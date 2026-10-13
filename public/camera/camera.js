// Camera page: live viewfinder → AI framing guide → auto-zoom → manual
// shutter → auto-correct + filter + border → save to Photos.
//
// Everything runs in the browser except the scene read, which is one call
// to /api/frame per tap of the Frame button.

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    shoot: $('shoot'), review: $('review'),
    viewfinder: $('viewfinder'), video: $('video'), flash: $('flash'),
    guide: $('guide'), gLine: $('g-line'), gTarget: $('g-target'), gReticle: $('g-reticle'), gArrow: $('g-arrow'),
    hint: $('hint'), flipBtn: $('flip-btn'), cancelBtn: $('cancel-btn'),
    shutterBtn: $('shutter-btn'), frameBtn: $('frame-btn'), zoomBadge: $('zoom-badge'),
    blocker: $('blocker'), blockerMsg: $('blocker-msg'), blockerRetry: $('blocker-retry'),
    retakeBtn: $('retake-btn'), autoBtn: $('auto-btn'), saveBtn: $('save-btn'),
    stage: $('stage'), preview: $('preview'),
    filterRow: $('filter-row'), borderRow: $('border-row'), deviceBtn: $('device-btn'),
    toast: $('toast'),
  };

  // ---------- Tunables ----------

  const SEND_LONG_SIDE = 768;     // px of the frame sent to Claude
  const TRACK_W = 120;            // width of the grayscale frames used for tracking
  const ALIGN_TOL = 0.05;         // box center within 5% of view center = aligned
  const CLOSE_TOL = 0.14;
  const ALIGN_HOLD_MS = 350;      // must stay aligned this long before zooming
  const MIN_ZOOM = 1.15;          // below this, zooming isn't worth the resolution
  const MAX_DIGITAL_ZOOM = 3;     // past ~3x a phone video frame turns to mush
  const MAX_OUTPUT_SIDE = 4096;

  const state = {
    stream: null,
    track: null,
    facing: 'environment',
    mirrored: false,
    phase: 'idle',                // idle | analyzing | guiding | zoomed
    requestId: 0,
    analysis: null,
    ref: null,                    // grayscale frame captured when Frame was tapped
    offset: { x: 0, y: 0 },       // how far the scene has moved since, in TRACK px
    alignedSince: 0,
    digitalZoom: 1,
    hwZoom: null,                 // { base, value } when the camera zooms optically
    exposure: null,               // original exposureCompensation, to restore
    loopOn: false,
  };

  // ---------- Small helpers ----------

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const pad2 = (n) => String(n).padStart(2, '0');

  let toastTimer = 0;
  function toast(msg, ms = 2600) {
    els.toast.textContent = msg;
    els.toast.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('is-on'), ms);
  }

  function setHint(main, sub) {
    els.hint.textContent = '';
    if (!main) { els.hint.classList.remove('is-on'); return; }
    els.hint.append(main);
    if (sub) {
      const s = document.createElement('small');
      s.textContent = sub;
      els.hint.append(s);
    }
    els.hint.classList.add('is-on');
  }

  function show(screen) {
    for (const s of [els.shoot, els.review]) s.classList.toggle('is-active', s === screen);
  }

  function capabilities() {
    try { return state.track?.getCapabilities?.() || {}; } catch { return {}; }
  }

  // ---------- Camera ----------

  async function startCamera() {
    els.blocker.hidden = true;
    if (!navigator.mediaDevices?.getUserMedia) {
      return block(window.isSecureContext
        ? "This browser can't open the camera. Try Safari on iPhone or Chrome on Android."
        : 'The camera only works over https. Open this page from its https:// address.');
    }
    stopCamera();
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: state.facing }, width: { ideal: 3840 }, height: { ideal: 2160 } },
      });
    } catch (err) {
      return block(err && err.name === 'NotAllowedError'
        ? 'Camera access was blocked. Allow it for this site in your browser settings, then try again.'
        : "Couldn't open the camera. Make sure no other app is using it, then try again.");
    }
    state.track = state.stream.getVideoTracks()[0];
    const settings = state.track.getSettings?.() || {};
    state.mirrored = (settings.facingMode || state.facing) === 'user';
    els.video.srcObject = state.stream;
    applyPreviewTransform();
    try { await els.video.play(); } catch { /* autoplay attribute covers it */ }
  }

  function stopCamera() {
    if (state.stream) for (const t of state.stream.getTracks()) t.stop();
    state.stream = null;
    state.track = null;
  }

  function block(msg) {
    els.blockerMsg.textContent = msg;
    els.blocker.hidden = false;
  }

  function applyPreviewTransform() {
    const z = state.digitalZoom;
    els.video.style.transform = `scale(${z}) scaleX(${state.mirrored ? -1 : 1})`;
  }

  // The part of the video frame actually on screen (object-fit: cover),
  // narrowed by the digital zoom. In video pixels.
  function visibleRect(zoom = 1) {
    const vw = els.video.videoWidth, vh = els.video.videoHeight;
    const W = els.viewfinder.clientWidth, H = els.viewfinder.clientHeight;
    const s = Math.max(W / vw, H / vh);
    const w = W / s / zoom, h = H / s / zoom;
    return { sx: (vw - w) / 2, sy: (vh - h) / 2, sw: w, sh: h };
  }

  // Draws what the person sees (cropped, mirrored for selfies) into ctx, so
  // every coordinate in this file is in "screen space".
  function drawView(ctx, w, h, zoom = 1) {
    const r = visibleRect(zoom);
    ctx.save();
    if (state.mirrored) { ctx.translate(w, 0); ctx.scale(-1, 1); }
    ctx.drawImage(els.video, r.sx, r.sy, r.sw, r.sh, 0, 0, w, h);
    ctx.restore();
  }

  function viewAspect() {
    return els.viewfinder.clientWidth / els.viewfinder.clientHeight;
  }

  // ---------- Motion tracking ----------
  //
  // The crop box Claude returns describes the frame at the moment of the tap.
  // Once the phone moves, that spot moves on screen, so the box has to follow
  // the scene. A tiny block-matching tracker does this: compare a 120px-wide
  // grayscale copy of each new frame against the reference frame and find the
  // shift that lines them up best. Tracking starts at the tap, so the box is
  // already in the right place when the answer arrives seconds later.

  const trackCanvas = document.createElement('canvas');
  const trackCtx = trackCanvas.getContext('2d', { willReadFrequently: true });

  function grabGray() {
    const w = TRACK_W;
    const h = Math.max(8, Math.round(TRACK_W / viewAspect()));
    if (trackCanvas.width !== w || trackCanvas.height !== h) {
      trackCanvas.width = w;
      trackCanvas.height = h;
    }
    drawView(trackCtx, w, h, 1);
    const d = trackCtx.getImageData(0, 0, w, h).data;
    const g = new Float32Array(w * h);
    let sum = 0;
    for (let i = 0, p = 0; i < g.length; i++, p += 4) {
      const v = d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114;
      g[i] = v;
      sum += v;
    }
    // Subtracting the mean makes the match survive auto-exposure shifts.
    const mean = sum / g.length;
    for (let i = 0; i < g.length; i++) g[i] -= mean;
    return { g, w, h };
  }

  // Mean absolute difference between cur(x, y) and ref(x - dx, y - dy).
  function matchCost(cur, ref, dx, dy, step) {
    const { w, h } = cur;
    const x0 = Math.max(0, dx), x1 = Math.min(w, w + dx);
    const y0 = Math.max(0, dy), y1 = Math.min(h, h + dy);
    if ((x1 - x0) * (y1 - y0) < w * h * 0.25) return Infinity;
    let sum = 0, n = 0;
    for (let y = y0; y < y1; y += step) {
      const co = y * w, ro = (y - dy) * w - dx;
      for (let x = x0; x < x1; x += step) {
        sum += Math.abs(cur.g[co + x] - ref.g[ro + x]);
        n++;
      }
    }
    return sum / n;
  }

  function updateTracking() {
    const ref = state.ref;
    const cur = grabGray();
    if (!ref || cur.w !== ref.w || cur.h !== ref.h) return;
    const px = state.offset.x, py = state.offset.y;
    let best = { c: Infinity, x: px, y: py };
    // Coarse pass around the last known shift, then refine.
    for (let dy = -14; dy <= 14; dy += 2) {
      for (let dx = -14; dx <= 14; dx += 2) {
        const c = matchCost(cur, ref, px + dx, py + dy, 3);
        if (c < best.c) best = { c, x: px + dx, y: py + dy };
      }
    }
    const cx = best.x, cy = best.y;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const c = matchCost(cur, ref, cx + dx, cy + dy, 2);
        if (c < best.c) best = { c, x: cx + dx, y: cy + dy };
      }
    }
    if (best.c < Infinity) state.offset = { x: best.x, y: best.y };
  }

  // Where the target box is on screen now, normalized 0-1.
  function currentBox() {
    const { crop } = state.analysis;
    return {
      x: crop.x + state.offset.x / state.ref.w,
      y: crop.y + state.offset.y / state.ref.h,
      w: crop.w,
      h: crop.h,
    };
  }

  function loop() {
    if (!state.loopOn) return;
    if ((state.phase === 'analyzing' || state.phase === 'guiding') && els.video.readyState >= 2) {
      updateTracking();
      if (state.phase === 'guiding') renderGuide();
    }
    requestAnimationFrame(loop);
  }

  function startLoop() {
    if (state.loopOn) return;
    state.loopOn = true;
    requestAnimationFrame(loop);
  }

  // ---------- Guide overlay ----------

  function renderGuide() {
    const W = els.viewfinder.clientWidth, H = els.viewfinder.clientHeight;
    els.guide.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const b = currentBox();
    const bw = b.w * W, bh = b.h * H;
    const tx = b.x * W, ty = b.y * H;
    const tcx = tx + bw / 2, tcy = ty + bh / 2;
    const cx = W / 2, cy = H / 2;

    setRect(els.gTarget, tx, ty, bw, bh);
    els.gReticle.setAttribute('d', corners(cx - bw / 2, cy - bh / 2, bw, bh, Math.min(bw, bh) * 0.16));
    els.gLine.setAttribute('x1', cx); els.gLine.setAttribute('y1', cy);
    els.gLine.setAttribute('x2', tcx); els.gLine.setAttribute('y2', tcy);

    // Arrowhead pointing at the target, pinned inside the screen edges.
    const ang = Math.atan2(tcy - cy, tcx - cx);
    const ax = clamp(tcx, 28, W - 28), ay = clamp(tcy, 28, H - 28);
    const s = 11;
    els.gArrow.setAttribute('d',
      `M${ax + Math.cos(ang) * s},${ay + Math.sin(ang) * s}` +
      `L${ax + Math.cos(ang + 2.5) * s},${ay + Math.sin(ang + 2.5) * s}` +
      `L${ax + Math.cos(ang - 2.5) * s},${ay + Math.sin(ang - 2.5) * s}Z`);

    const ex = b.x + b.w / 2 - 0.5, ey = b.y + b.h / 2 - 0.5;
    const err = Math.hypot(ex, ey);
    const aligned = err < ALIGN_TOL;
    els.guide.classList.toggle('is-close', err < CLOSE_TOL && !aligned);
    els.guide.classList.toggle('is-aligned', aligned);

    if (!aligned) {
      state.alignedSince = 0;
    } else if (!state.alignedSince) {
      state.alignedSince = performance.now();
    } else if (performance.now() - state.alignedSince > ALIGN_HOLD_MS) {
      zoomIn();
    }
  }

  function setRect(el, x, y, w, h) {
    el.setAttribute('x', x); el.setAttribute('y', y);
    el.setAttribute('width', w); el.setAttribute('height', h);
  }

  function corners(x, y, w, h, l) {
    const r = x + w, b = y + h;
    return `M${x},${y + l}V${y}H${x + l}M${r - l},${y}H${r}V${y + l}` +
           `M${r},${b - l}V${b}H${r - l}M${x + l},${b}H${x}V${b - l}`;
  }

  // ---------- Frame (AI analysis) ----------

  async function analyze() {
    if (state.phase === 'analyzing' || els.video.readyState < 2) return;
    await resetGuide();

    const aspect = viewAspect();
    const c = document.createElement('canvas');
    if (aspect >= 1) { c.width = SEND_LONG_SIDE; c.height = Math.round(SEND_LONG_SIDE / aspect); }
    else { c.height = SEND_LONG_SIDE; c.width = Math.round(SEND_LONG_SIDE * aspect); }
    drawView(c.getContext('2d'), c.width, c.height, 1);
    const image = c.toDataURL('image/jpeg', 0.8).split(',')[1];

    state.ref = grabGray();
    state.offset = { x: 0, y: 0 };
    state.phase = 'analyzing';
    const id = ++state.requestId;
    els.frameBtn.classList.add('is-busy');
    els.cancelBtn.hidden = false;
    setHint('Reading the scene…');
    startLoop();

    let res, data;
    try {
      res = await fetch('/api/frame', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image }),
      });
      data = await res.json().catch(() => ({}));
    } catch {
      data = { error: "Couldn't reach the server. Framing needs an internet connection." };
    }
    if (id !== state.requestId) return; // cancelled or superseded meanwhile
    els.frameBtn.classList.remove('is-busy');

    if (res && res.status === 401) { location.reload(); return; }
    if (!res || !res.ok || !data.crop) {
      state.phase = 'idle';
      els.cancelBtn.hidden = true;
      setHint('');
      toast(data.error || 'Framing failed. Try again.');
      return;
    }

    state.analysis = data;
    applyExposure(data.lighting.ev);
    const light = data.lighting.note || '';
    if (1 / data.crop.w < MIN_ZOOM) {
      // Already well framed; nothing to aim at.
      state.phase = 'zoomed';
      setHint(data.tip || 'Looks good as is', light);
      els.shutterBtn.classList.add('is-ready');
      return;
    }
    state.phase = 'guiding';
    state.alignedSince = 0;
    setHint(data.tip || 'Move the frame onto the box', light);
    els.guide.classList.add('is-on');
  }

  async function zoomIn() {
    if (state.phase !== 'guiding') return;
    state.phase = 'zoomed';
    els.guide.classList.remove('is-on', 'is-close', 'is-aligned');
    if (navigator.vibrate) navigator.vibrate(12);

    let want = clamp(1 / state.analysis.crop.w, 1, MAX_DIGITAL_ZOOM);
    // Optical/sensor zoom first where the browser exposes it (mostly Android
    // Chrome) — it keeps full resolution. Digital zoom covers the rest.
    const caps = capabilities();
    if (caps.zoom && caps.zoom.max > caps.zoom.min) {
      const base = state.track.getSettings().zoom || caps.zoom.min || 1;
      const target = clamp(base * want, caps.zoom.min, caps.zoom.max);
      // Recorded before the ramp so a cancel mid-ramp restores the base zoom.
      state.hwZoom = { base, value: target };
      try {
        for (let i = 1; i <= 6 && state.phase === 'zoomed'; i++) {
          await state.track.applyConstraints({ advanced: [{ zoom: base + (target - base) * (i / 6) }] });
        }
        want = clamp(want * base / target, 1, MAX_DIGITAL_ZOOM);
      } catch {
        state.hwZoom = { base, value: base };
      }
    }
    if (state.phase !== 'zoomed') { // cancelled during the ramp
      if (state.track && state.hwZoom) state.track.applyConstraints({ advanced: [{ zoom: state.hwZoom.base }] }).catch(() => {});
      state.hwZoom = null;
      return;
    }
    state.digitalZoom = want < 1.02 ? 1 : want;
    applyPreviewTransform();

    const total = state.digitalZoom * (state.hwZoom ? state.hwZoom.value / state.hwZoom.base : 1);
    els.zoomBadge.textContent = `${total.toFixed(1)}×`;
    els.zoomBadge.hidden = false;
    els.shutterBtn.classList.add('is-ready');
    setHint('Locked in — take the shot', state.analysis.lighting.note);
  }

  function applyExposure(ev) {
    const caps = capabilities();
    const ec = caps.exposureCompensation;
    if (!ec || !(ec.max > ec.min) || !ev) return;
    try {
      if (state.exposure == null) state.exposure = state.track.getSettings().exposureCompensation ?? 0;
      state.track.applyConstraints({ advanced: [{ exposureCompensation: clamp(ev, ec.min, ec.max) }] }).catch(() => {});
    } catch { /* unsupported — the auto-correct pass still fixes brightness */ }
  }

  async function resetGuide() {
    state.requestId++;
    state.phase = 'idle';
    state.analysis = null;
    state.alignedSince = 0;
    els.frameBtn.classList.remove('is-busy');
    els.guide.classList.remove('is-on', 'is-close', 'is-aligned');
    els.shutterBtn.classList.remove('is-ready');
    els.zoomBadge.hidden = true;
    els.cancelBtn.hidden = true;
    setHint('');
    state.digitalZoom = 1;
    applyPreviewTransform();
    const restore = {};
    if (state.hwZoom) restore.zoom = state.hwZoom.base;
    if (state.exposure != null) restore.exposureCompensation = state.exposure;
    state.hwZoom = null;
    state.exposure = null;
    if (state.track && Object.keys(restore).length) {
      try { await state.track.applyConstraints({ advanced: [restore] }); } catch { /* best effort */ }
    }
  }

  // ---------- Capture ----------

  async function shoot() {
    if (els.video.readyState < 2) return;
    const r = visibleRect(state.digitalZoom);
    let w = Math.round(r.sw), h = Math.round(r.sh);
    const scale = Math.min(1, MAX_OUTPUT_SIDE / Math.max(w, h));
    w = Math.round(w * scale); h = Math.round(h * scale);
    const photo = document.createElement('canvas');
    photo.width = w; photo.height = h;
    drawView(photo.getContext('2d'), w, h, state.digitalZoom);

    els.flash.classList.remove('is-firing');
    void els.flash.offsetWidth;
    els.flash.classList.add('is-firing');

    const settings = state.track?.getSettings?.() || {};
    const optical = state.hwZoom ? state.hwZoom.value / state.hwZoom.base : 1;
    const meta = {
      date: new Date(),
      zoom: state.digitalZoom * optical,
      width: w,
      height: h,
      iso: settings.iso || null,
      exposureTime: settings.exposureTime || null, // in 100µs units, per spec
      front: state.mirrored,
      lighting: state.analysis?.lighting || null,
    };
    await resetGuide();
    els.video.pause();
    openReview(photo, meta);
  }

  // ---------- Image pipeline ----------

  // Presets are deliberately small parameter sets so they're easy to tune.
  // t: temperature (+warm), tint (+magenta), sh/hi: split-tone RGB offsets.
  const FILTERS = [
    { id: 'original', name: 'Original' },
    { id: 'clean', name: 'Clean', exp: 1.04, con: 1.06, sat: 0.96, t: -0.015, fade: 0.015 },
    { id: 'harbor', name: 'Harbor', con: 1.08, sat: 0.78, t: -0.07, tint: -0.015, sh: [-0.02, 0.035, 0.06], hi: [0.03, 0.015, -0.01], fade: 0.05 },
    { id: 'dusk', name: 'Dusk', exp: 0.98, con: 1.05, sat: 1.04, t: 0.07, tint: 0.03, sh: [0.04, -0.01, 0.07], hi: [0.06, 0.02, -0.03], fade: 0.05, vig: 0.28 },
    { id: 'relic', name: 'Relic', con: 0.94, sat: 0.68, t: 0.09, sh: [0.06, 0.03, -0.01], hi: [0.03, 0.02, -0.04], fade: 0.11, vig: 0.38, grain: 0.05 },
    { id: 'mono', name: 'Mono', con: 1.2, sat: 0, fade: 0.03, vig: 0.22, grain: 0.03 },
  ];

  const BORDERS = [
    { id: 'none', name: 'Original' },
    { id: 'white', name: 'White' },
    { id: 'paper', name: 'Paper' },
    { id: 'specs', name: 'Specs' },
    { id: 'date', name: 'Date' },
  ];

  // Auto-correct from the photo's own histogram: stretch levels, a partial
  // gray-world white balance, and a gamma that pulls mid-tones toward a
  // natural brightness. Measuring the pixels is more reliable than any
  // description of them, so Claude's lighting read only nudges warmth.
  function measureAuto(data, lighting) {
    const hist = new Uint32Array(256);
    let sr = 0, sg = 0, sb = 0, n = 0;
    for (let p = 0; p < data.length; p += 16) {
      const r = data[p], g = data[p + 1], b = data[p + 2];
      hist[(r * 0.2126 + g * 0.7152 + b * 0.0722) | 0]++;
      sr += r; sg += g; sb += b; n++;
    }
    const pct = (q) => {
      let acc = 0;
      const target = n * q;
      for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= target) return i / 255; }
      return 1;
    };
    const black = Math.min(pct(0.005), 0.08);
    const white = Math.max(pct(0.995), 0.85);
    const mr = sr / n / 255, mg = sg / n / 255, mb = sb / n / 255;
    const avg = (mr + mg + mb) / 3 || 0.5;
    const warm = lighting ? lighting.warmth * 0.05 : 0;
    const wb = [mr, mg, mb].map((m) => clamp(1 + 0.5 * (avg / (m || avg) - 1), 0.9, 1.1));
    wb[0] *= 1 + warm;
    wb[2] *= 1 - warm;
    const meanLum = clamp(((mr * 0.2126 + mg * 0.7152 + mb * 0.0722) - black) / (white - black), 0.02, 0.98);
    const fullGamma = Math.log(0.46) / Math.log(meanLum);
    const gamma = clamp(1 + (fullGamma - 1) * 0.6, 0.7, 1.35);
    return { black, white, wb, gamma };
  }

  function buildLuts(auto) {
    const luts = [new Float32Array(256), new Float32Array(256), new Float32Array(256)];
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < 256; i++) {
        let v = i / 255;
        if (auto) {
          v = clamp((v - auto.black) / (auto.white - auto.black), 0, 1) * auto.wb[c];
          v = Math.pow(clamp(v, 0, 1), auto.gamma);
        }
        luts[c][i] = v;
      }
    }
    return luts;
  }

  function processPixels(src, w, h, f, auto) {
    const out = new Uint8ClampedArray(src.length);
    const [lr, lg, lb] = buildLuts(auto);
    const exp = f.exp ?? 1, con = f.con ?? 1, sat = f.sat ?? 1;
    const t = f.t ?? 0, tint = f.tint ?? 0, fade = f.fade ?? 0;
    const sh = f.sh || [0, 0, 0], hi = f.hi || [0, 0, 0];
    const vig = f.vig ?? 0, grain = (f.grain ?? 0) * 255;
    const halfDiag = Math.hypot(w / 2, h / 2);
    let seed = 1234567;
    for (let y = 0; y < h; y++) {
      const dy2 = (y - h / 2) ** 2;
      for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4;
        let r = lr[src[p]] * exp, g = lg[src[p + 1]] * exp, b = lb[src[p + 2]] * exp;
        r = (r - 0.5) * con + 0.5; g = (g - 0.5) * con + 0.5; b = (b - 0.5) * con + 0.5;
        const l = r * 0.2126 + g * 0.7152 + b * 0.0722;
        r = l + (r - l) * sat; g = l + (g - l) * sat; b = l + (b - l) * sat;
        r += t; b -= t; g -= tint;
        const lc = l < 0 ? 0 : l > 1 ? 1 : l, ls = 1 - lc;
        r += sh[0] * ls + hi[0] * lc; g += sh[1] * ls + hi[1] * lc; b += sh[2] * ls + hi[2] * lc;
        r = r * (1 - fade) + fade; g = g * (1 - fade) + fade; b = b * (1 - fade) + fade;
        if (vig) {
          const d = Math.sqrt((x - w / 2) ** 2 + dy2) / halfDiag;
          const k = d < 0.45 ? 1 : 1 - vig * Math.min(1, ((d - 0.45) / 0.55) ** 2);
          r *= k; g *= k; b *= k;
        }
        r *= 255; g *= 255; b *= 255;
        if (grain) {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          const nz = ((seed / 0x7fffffff) - 0.5) * grain;
          r += nz; g += nz; b += nz;
        }
        out[p] = r; out[p + 1] = g; out[p + 2] = b; out[p + 3] = 255;
      }
    }
    return new ImageData(out, w, h);
  }

  function filtered(srcImage, filterId, auto) {
    const f = FILTERS.find((x) => x.id === filterId) || FILTERS[0];
    const img = processPixels(srcImage.data, srcImage.width, srcImage.height, f, auto);
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d').putImageData(img, 0, 0);
    return c;
  }

  function formatDate(d) {
    return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${d.getFullYear()}`;
  }

  function specsLine(meta) {
    const parts = [];
    parts.push(`${meta.zoom.toFixed(1).replace(/\.0$/, '')}×`);
    if (meta.exposureTime) {
      const sec = meta.exposureTime / 10000;
      parts.push(sec >= 1 ? `${sec.toFixed(1)}s` : `1/${Math.round(1 / sec)}s`);
    }
    if (meta.iso) parts.push(`ISO ${Math.round(meta.iso)}`);
    parts.push(`${(meta.width * meta.height / 1e6).toFixed(1)} MP`);
    return parts.join('  ·  ');
  }

  // Wraps the filtered photo in the chosen border. All sizes scale with the
  // photo's short side, so the preview and the saved file match.
  function compose(img, borderId, meta) {
    const w = img.width, h = img.height, s = Math.min(w, h);
    if (borderId === 'none') return img;

    const out = document.createElement('canvas');
    const ctx = out.getContext('2d');

    if (borderId === 'date') {
      out.width = w; out.height = h;
      ctx.drawImage(img, 0, 0);
      const size = Math.round(s * 0.05);
      ctx.font = `${size}px "Share Tech Mono", ui-monospace, monospace`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#ff8a2a';
      ctx.shadowColor = 'rgba(255, 110, 20, 0.85)';
      ctx.shadowBlur = size * 0.45;
      ctx.fillText(formatDate(meta.date), w - s * 0.055, h - s * 0.05);
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(255, 220, 170, 0.55)';
      ctx.fillText(formatDate(meta.date), w - s * 0.055, h - s * 0.05);
      return out;
    }

    let side, top, bottom, fill;
    if (borderId === 'white') { side = top = bottom = Math.round(s * 0.025); fill = '#ffffff'; }
    else if (borderId === 'paper') { side = top = Math.round(s * 0.06); bottom = Math.round(s * 0.17); fill = '#f2eee6'; }
    else { side = top = Math.round(s * 0.035); bottom = Math.round(s * 0.14); fill = '#ffffff'; }

    out.width = w + side * 2;
    out.height = h + top + bottom;
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(img, side, top);

    if (borderId === 'specs') {
      const y = top + h + bottom / 2;
      const big = Math.round(s * 0.034), small = Math.round(s * 0.024);
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#16161a';
      ctx.font = `700 ${big}px "Space Grotesk", system-ui, sans-serif`;
      ctx.fillText(`Shot on ${deviceName()}`, side, y - big * 0.45);
      ctx.fillStyle = '#6d6d75';
      ctx.font = `500 ${small}px "Space Grotesk", system-ui, sans-serif`;
      const d = meta.date;
      ctx.fillText(`${formatDate(d)}  ${pad2(d.getHours())}:${pad2(d.getMinutes())}`, side, y + big * 0.6);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#16161a';
      ctx.font = `600 ${small}px "Space Grotesk", system-ui, sans-serif`;
      ctx.fillText(specsLine(meta), out.width - side, y - big * 0.45);
      ctx.fillStyle = '#6d6d75';
      ctx.font = `500 ${small}px "Space Grotesk", system-ui, sans-serif`;
      ctx.fillText(`${meta.width} × ${meta.height}${meta.front ? '  ·  front' : ''}`, out.width - side, y + big * 0.6);
    }
    return out;
  }

  // ---------- Device name (for the Specs border) ----------

  let detectedDevice = /iPhone/.test(navigator.userAgent) ? 'iPhone'
    : /iPad/.test(navigator.userAgent) ? 'iPad'
    : /Android/.test(navigator.userAgent) ? 'Android' : 'my phone';
  try {
    navigator.userAgentData?.getHighEntropyValues?.(['model'])
      .then((v) => { if (v.model) detectedDevice = v.model; })
      .catch(() => {});
  } catch { /* not Chromium */ }

  function deviceName() {
    try { return localStorage.getItem('cam.device') || detectedDevice; } catch { return detectedDevice; }
  }

  // ---------- Review screen ----------

  const review = {
    photo: null, meta: null,
    previewSrc: null, fullAuto: null, previewAuto: null,
    filter: 'original', border: 'none', auto: true,
    file: null, renderSeq: 0, finalTimer: 0,
  };

  function scaledImageData(src, maxSide) {
    const k = Math.min(1, maxSide / Math.max(src.width, src.height));
    const c = document.createElement('canvas');
    c.width = Math.round(src.width * k); c.height = Math.round(src.height * k);
    const ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0, c.width, c.height);
    return ctx.getImageData(0, 0, c.width, c.height);
  }

  function openReview(photo, meta) {
    review.photo = photo;
    review.meta = meta;
    review.file = null;
    show(els.review);
    const dpr = window.devicePixelRatio || 1;
    const box = els.stage.getBoundingClientRect();
    review.previewSrc = scaledImageData(photo, Math.min(1600, Math.max(box.width, box.height) * dpr));
    review.previewAuto = measureAuto(review.previewSrc.data, meta.lighting);
    buildFilterRow();
    buildBorderRow();
    renderPreview();
  }

  function buildFilterRow() {
    els.filterRow.textContent = '';
    const dpr = window.devicePixelRatio || 1;
    const t = Math.round(58 * dpr);
    // Square center crop of the preview for the thumbnails.
    const src = review.previewSrc;
    const side = Math.min(src.width, src.height);
    const crop = document.createElement('canvas');
    crop.width = crop.height = t;
    const tmp = document.createElement('canvas');
    tmp.width = src.width; tmp.height = src.height;
    tmp.getContext('2d').putImageData(src, 0, 0);
    crop.getContext('2d').drawImage(tmp, (src.width - side) / 2, (src.height - side) / 2, side, side, 0, 0, t, t);
    const thumbSrc = crop.getContext('2d').getImageData(0, 0, t, t);

    for (const f of FILTERS) {
      const btn = document.createElement('button');
      btn.className = 'chip';
      btn.setAttribute('role', 'radio');
      btn.dataset.id = f.id;
      const c = filtered(thumbSrc, f.id, review.auto ? review.previewAuto : null);
      btn.append(c, f.name);
      btn.addEventListener('click', () => { review.filter = f.id; renderPreview(); });
      els.filterRow.append(btn);
    }
    syncChips();
  }

  function buildBorderRow() {
    els.borderRow.textContent = '';
    for (const b of BORDERS) {
      const btn = document.createElement('button');
      btn.className = 'chip';
      btn.setAttribute('role', 'radio');
      btn.dataset.id = b.id;
      const sw = document.createElement('span');
      sw.className = `swatch swatch-${b.id}`;
      if (b.id === 'date') sw.textContent = formatDate(review.meta.date).slice(0, 5);
      else sw.append(document.createElement('i'));
      btn.append(sw, b.name);
      btn.addEventListener('click', () => { review.border = b.id; renderPreview(); });
      els.borderRow.append(btn);
    }
    syncChips();
  }

  function syncChips() {
    for (const [row, val] of [[els.filterRow, review.filter], [els.borderRow, review.border]]) {
      for (const btn of row.children) {
        const on = btn.dataset.id === val;
        btn.classList.toggle('is-on', on);
        btn.setAttribute('aria-checked', on);
      }
    }
    els.autoBtn.classList.toggle('is-on', review.auto);
    els.autoBtn.setAttribute('aria-pressed', review.auto);
    els.deviceBtn.hidden = review.border !== 'specs';
    els.deviceBtn.textContent = `Camera name: ${deviceName()} — tap to change`;
  }

  async function fontsReady() {
    try {
      await Promise.all([
        document.fonts.load('700 20px "Space Grotesk"'),
        document.fonts.load('500 20px "Space Grotesk"'),
        document.fonts.load('20px "Share Tech Mono"'),
      ]);
    } catch { /* fall back to system fonts */ }
  }

  async function renderPreview() {
    syncChips();
    await fontsReady();
    const img = filtered(review.previewSrc, review.filter, review.auto ? review.previewAuto : null);
    const out = compose(img, review.border, review.meta);
    els.preview.width = out.width;
    els.preview.height = out.height;
    els.preview.getContext('2d').drawImage(out, 0, 0);
    const box = els.stage.getBoundingClientRect();
    const fit = Math.min(box.width / out.width, box.height / out.height);
    els.preview.style.width = `${out.width * fit}px`;
    els.preview.style.height = `${out.height * fit}px`;
    scheduleFinal();
  }

  // The full-size file is rendered ahead of time so that tapping Save can
  // open the share sheet immediately: iOS only allows navigator.share()
  // straight from a tap, not after a long async render.
  function scheduleFinal() {
    review.file = null;
    els.saveBtn.disabled = true;
    els.saveBtn.textContent = 'Preparing…';
    clearTimeout(review.finalTimer);
    const seq = ++review.renderSeq;
    review.finalTimer = setTimeout(async () => {
      const ctx = review.photo.getContext('2d');
      const src = ctx.getImageData(0, 0, review.photo.width, review.photo.height);
      if (!review.fullAuto) review.fullAuto = measureAuto(src.data, review.meta.lighting);
      const img = filtered(src, review.filter, review.auto ? review.fullAuto : null);
      const out = compose(img, review.border, review.meta);
      const blob = await new Promise((r) => out.toBlob(r, 'image/jpeg', 0.92));
      if (seq !== review.renderSeq || !blob) return;
      const d = review.meta.date;
      const name = `IMG_${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_` +
        `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}.jpg`;
      review.file = new File([blob], name, { type: 'image/jpeg', lastModified: d.getTime() });
      els.saveBtn.disabled = false;
      els.saveBtn.textContent = 'Save';
    }, 250);
  }

  async function save() {
    const file = review.file;
    if (!file) return;
    // On phones the share sheet is the only route into Photos ("Save Image");
    // a plain download lands in Files/Downloads instead.
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast('Saved to your downloads');
  }

  function retake() {
    review.photo = null;
    review.previewSrc = null;
    review.fullAuto = null;
    review.file = null;
    review.renderSeq++;
    show(els.shoot);
    if (!state.stream) startCamera();
    else els.video.play().catch(() => {});
  }

  // ---------- Wiring ----------

  els.frameBtn.addEventListener('click', analyze);
  els.shutterBtn.addEventListener('click', shoot);
  els.cancelBtn.addEventListener('click', () => { resetGuide(); });
  els.flipBtn.addEventListener('click', async () => {
    await resetGuide();
    state.facing = state.facing === 'environment' ? 'user' : 'environment';
    startCamera();
  });
  els.blockerRetry.addEventListener('click', startCamera);
  els.retakeBtn.addEventListener('click', retake);
  els.saveBtn.addEventListener('click', save);
  els.autoBtn.addEventListener('click', () => {
    review.auto = !review.auto;
    buildFilterRow();
    renderPreview();
  });
  els.deviceBtn.addEventListener('click', () => {
    const name = prompt('What should the Specs border say this was shot on?', deviceName());
    if (name == null) return;
    try {
      if (name.trim()) localStorage.setItem('cam.device', name.trim().slice(0, 40));
      else localStorage.removeItem('cam.device');
    } catch { /* private mode: the name just won't stick */ }
    renderPreview();
  });

  // Release the camera when the page is hidden (battery, and the green dot),
  // and pick it back up on return.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      resetGuide();
      stopCamera();
    } else if (els.shoot.classList.contains('is-active')) {
      startCamera();
    }
  });
  // Rotating the phone invalidates the box (it was measured in the old
  // orientation); smaller resizes, like Safari's toolbar sliding, don't.
  let portrait = viewAspect() < 1;
  window.addEventListener('resize', () => {
    const now = viewAspect() < 1;
    if (now !== portrait && state.phase !== 'idle') resetGuide();
    portrait = now;
  });

  startCamera();
})();
