/* Forge frontend. Plain JS, no build step.
 *
 * All Anthropic/Places calls go through the Pages Functions proxy under
 * /api — no keys ever live in this file. Generation is one Claude call per
 * page; the old research pipeline is replaced by extractKeywords() below,
 * which runs locally and ships its findings along with the prompt.
 */

'use strict';

// ---------------------------------------------------------------- helpers

const $ = (sel) => document.querySelector(sel);

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const moneyFmt = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 0,
});
const moneyFmtCents = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 2,
});
function money(n) {
  // Round to cents first so float artifacts (e.g. 2600*0.35 = 910.0000001)
  // don't slip past the integer check and render as "$910.00".
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return Number.isInteger(v) ? moneyFmt.format(v) : moneyFmtCents.format(v);
}

// Browser storage can be switched off (private windows, strict settings), and
// then every read and write throws. Nothing in Forge depends on it — it only
// remembers preferences — so a failure is the same as "nothing saved".
function storeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function storeSet(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}

function localToday() {
  return new Date().toLocaleDateString('sv'); // YYYY-MM-DD
}
function localCurrentMonth() {
  return localToday().slice(0, 7); // YYYY-MM
}

// ---------------------------------------------------------- payment methods
// Standard published US rates. A fee is worked out when the money is logged
// and stored alongside it, so old records keep the fee that was really charged
// even if a platform changes its pricing later. Shared by the Money calendar,
// the Clients tab (upfront + maintenance) and the Revenue dashboard.

const PAYMENT_METHODS = [
  { key: 'stripe', label: 'Stripe', pct: 0.029, flat: 0.30 },
  { key: 'paypal', label: 'PayPal', pct: 0.0349, flat: 0.49 },
  { key: 'cashapp', label: 'Cash App', pct: 0.0275, flat: 0 },
  { key: 'bank', label: 'Bank transfer / Zelle', pct: 0, flat: 0 },
  { key: 'apple', label: 'Apple Cash (debit)', pct: 0, flat: 0 },
  { key: 'cash', label: 'Cash', pct: 0, flat: 0 },
  { key: 'other', label: 'Other / not sure', pct: 0, flat: 0 },
];
const MONEY_METHOD_KEY = 'forge-money-method';
const FIRST_CLIENT_KEY = 'forge-first-client';

function methodByKey(key) {
  return PAYMENT_METHODS.find((m) => m.key === key) || null;
}
function methodLabel(key) {
  const m = methodByKey(key);
  return m ? m.label : 'Other / not sure';
}

// What the payment platform keeps. Never more than the payment itself.
function feeFor(amount, methodKey) {
  const m = methodByKey(methodKey);
  const gross = Number(amount) || 0;
  if (!m || gross <= 0) return 0;
  return Math.min(Math.round((gross * m.pct + m.flat) * 100) / 100, gross);
}

function lastUsedMethod() {
  return storeGet(MONEY_METHOD_KEY) || 'stripe';
}
function rememberMethod(key) {
  storeSet(MONEY_METHOD_KEY, key);
}

// Fills any <select> with the method list, each showing its rate.
function populateMethodSelect(sel, selected) {
  if (!sel) return;
  sel.innerHTML = PAYMENT_METHODS.map((m) => {
    const rate = m.pct || m.flat
      ? `${(m.pct * 100).toFixed(2).replace(/\.?0+$/, '')}%${m.flat ? ` + $${m.flat.toFixed(2)}` : ''}`
      : 'no fee';
    return `<option value="${m.key}">${escapeHtml(m.label)} (${rate})</option>`;
  }).join('');
  sel.value = selected || lastUsedMethod();
}

// Shared "what actually lands" line used under every amount + method pairing.
function renderNetLine(el, amount, methodKey) {
  if (!el) return;
  const gross = Number(amount) || 0;
  if (!(gross > 0)) { el.hidden = true; return; }
  const fee = feeFor(gross, methodKey);
  el.hidden = false;
  el.textContent = fee > 0
    ? `${methodLabel(methodKey)} takes ${money(fee)} — you actually get ${money(gross - fee)}`
    : `No fee — you get all ${money(gross)}`;
  el.classList.toggle('is-free', fee === 0);
}
function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.includes('T') || iso.includes(' ') ? iso.replace(' ', 'T') + 'Z' : iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function formatMonth(ym) {
  if (!ym) return '';
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

// The server writes a request token into this page and nowhere else. Every API
// call sends it back, which is how the server tells the app apart from a
// script inside a generated site (see functions/_middleware.js). It is read
// once and taken out of the document.
const FORGE_TOKEN = (() => {
  const meta = document.querySelector('meta[name="forge-token"]');
  const value = meta ? meta.content : '';
  if (meta) meta.remove();
  return value;
})();

// How long to wait for the server. A generation is one long, silent request —
// the real ones take two to three minutes — so it gets a much longer limit
// than everything else, but still a limit: without one a stalled connection
// left the spinner turning for ever with no way out.
const API_TIMEOUT_MS = 30 * 1000;
const GENERATE_TIMEOUT_MS = 12 * 60 * 1000;

function statusMessage(status) {
  if (status === 401) return 'You are signed out. Reload the page and sign in again.';
  if (status === 413) return 'That was too large to send.';
  if (status === 429) return 'Too many requests at once. Wait a moment and try again.';
  if (status >= 500) return `Forge's server had a problem (${status}). Wait a moment and try again.`;
  return `That did not work (${status}). Try again.`;
}

// Generations in flight, so the page can warn before it is closed on one.
let generationsRunning = 0;
window.addEventListener('beforeunload', (e) => {
  if (generationsRunning > 0) { e.preventDefault(); e.returnValue = ''; }
});

// `signal` lets the caller stop waiting (a Stop button). An error from a
// deliberate stop carries `cancelled: true` so callers can tell it apart.
async function api(path, { method = 'GET', body, signal, timeout } = {}) {
  const isGeneration = path.startsWith('/api/generate');
  const limit = timeout || (isGeneration ? GENERATE_TIMEOUT_MS : API_TIMEOUT_MS);
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (FORGE_TOKEN) headers['X-Forge-Token'] = FORGE_TOKEN;

  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, limit);
  const stop = () => ctl.abort();
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener('abort', stop, { once: true });
  }
  if (isGeneration) generationsRunning++;

  try {
    let res;
    let data = null;
    try {
      res = await fetch(path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      });
      try { data = await res.json(); } catch { /* non-JSON error page */ }
    } catch (err) {
      if (signal && signal.aborted) {
        throw Object.assign(new Error('Stopped.'), { cancelled: true });
      }
      if (timedOut) {
        throw new Error(isGeneration
          ? 'This has taken over 12 minutes, which is far longer than a site should, so Forge stopped waiting. Try again.'
          : 'The server took too long to answer. Check your connection and try again.');
      }
      throw new Error('Could not reach Forge. Check your internet connection and try again.');
    }
    if (!res.ok) throw new Error(data?.error || statusMessage(res.status));
    return data;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', stop);
    if (isGeneration) generationsRunning--;
  }
}

// A running clock beside the spinner. The staged messages are decoration; this
// is the honest part — how long it has actually been.
function startElapsed(el) {
  if (!el) return () => {};
  const began = Date.now();
  const show = () => {
    const secs = Math.floor((Date.now() - began) / 1000);
    el.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} so far · a site usually takes 2 to 3 minutes`;
  };
  show();
  const timer = setInterval(show, 1000);
  return () => { clearInterval(timer); el.textContent = ''; };
}

let toastTimer = null;
function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('toast-error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

// ---------------------------------------------------------------- motion
// Small presentation helpers. Every one of them is a no-op when the viewer
// has asked for reduced motion, and none of them change what anything does.

const REDUCED_MOTION = (() => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  catch { return false; }
})();

// Deal a freshly rendered list in with a slight stagger.
function staggerIn(container) {
  if (!container || REDUCED_MOTION) return;
  for (const el of container.children) el.classList.add('stagger-in');
}

// Count a number up to its value instead of snapping to it. Formats through
// whatever function the caller uses elsewhere, so currency stays currency.
function countUp(el, to, format = (n) => String(Math.round(n))) {
  if (!el) return;
  const target = Number(to) || 0;
  if (REDUCED_MOTION) { el.textContent = format(target); return; }

  const from = 0;
  const duration = 550;
  const start = performance.now();
  // Cancel any count still running on this element.
  if (el._countRaf) cancelAnimationFrame(el._countRaf);

  const tick = (now) => {
    const t = Math.min(1, (now - start) / duration);
    // ease-out cubic: quick then settling
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = format(from + (target - from) * eased);
    if (t < 1) el._countRaf = requestAnimationFrame(tick);
    else { el._countRaf = null; el.textContent = format(target); }
  };
  el._countRaf = requestAnimationFrame(tick);
}

// ---- Showing a generated page without letting it touch the app --------------
// A generated page is written by a model that has read text from the public
// internet, so its scripts are treated as a stranger's. Loaded with `srcdoc`
// the page would count as part of this app and could call anything the app
// can. Loaded from a data: address it gets an origin of its own: it still
// runs, its map and fonts still load, but it cannot reach this page.
const ANALYTICS_BLOCK_RE = /<!--forge-analytics-start-->[\s\S]*?<!--forge-analytics-end-->/g;
// Chrome refuses addresses much past 2MB. A page that large (several uploaded
// photos) falls back to a stricter frame instead of failing to show.
const MAX_DATA_URL = 1900000;
const FRAME_SANDBOX = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals';

function toDataUrl(html) {
  const bytes = new TextEncoder().encode(html);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return 'data:text/html;charset=utf-8;base64,' + btoa(bin);
}

function showInFrame(frame, html) {
  if (!frame) return;
  // Your own previews must not count as visits, so the beacon stays out of
  // them. The saved and downloaded copies keep it.
  const page = String(html || '').replace(ANALYTICS_BLOCK_RE, '');
  const url = toDataUrl(page);
  if (url.length <= MAX_DATA_URL) {
    frame.setAttribute('sandbox', FRAME_SANDBOX + ' allow-same-origin');
    frame.removeAttribute('srcdoc');
    frame.src = url;
  } else {
    frame.setAttribute('sandbox', FRAME_SANDBOX);
    frame.removeAttribute('src');
    frame.srcdoc = page;
  }
}

// Fade a preview frame out and back in around a content swap, so a regenerated
// site doesn't flash white.
function swapFrame(frame, html) {
  if (!frame) return;
  if (REDUCED_MOTION) { showInFrame(frame, html); return; }
  frame.classList.add('is-swapping');
  showInFrame(frame, html);
  const done = () => frame.classList.remove('is-swapping');
  frame.addEventListener('load', done, { once: true });
  setTimeout(done, 1200); // never leave it dimmed if load doesn't fire
}

// A press ripples out from where you actually clicked. Delegated, so it covers
// buttons that get created later too.
document.addEventListener('pointerdown', (e) => {
  if (REDUCED_MOTION) return;
  const btn = e.target.closest('.btn, .tab-btn, .decide-btn');
  if (!btn || btn.disabled) return;
  const r = btn.getBoundingClientRect();
  const size = Math.max(r.width, r.height);
  const dot = document.createElement('span');
  dot.className = 'ripple';
  dot.style.width = dot.style.height = size + 'px';
  dot.style.left = (e.clientX - r.left - size / 2) + 'px';
  dot.style.top = (e.clientY - r.top - size / 2) + 'px';
  btn.appendChild(dot);
  dot.addEventListener('animationend', () => dot.remove(), { once: true });
});

// Flash an element green when something completes.
function flashOk(el) {
  if (!el || REDUCED_MOTION) return;
  el.classList.remove('flash-ok');
  void el.offsetWidth;
  el.classList.add('flash-ok');
  el.addEventListener('animationend', () => el.classList.remove('flash-ok'), { once: true });
}

// Rolling captions while a site generates, so the wait reads as work happening
// rather than a frozen screen. Purely cosmetic — it does not track real
// progress, and it stops the moment generation finishes.
const GEN_STAGES = [
  'Reading the business details…',
  'Choosing colours and type…',
  'Writing the copy…',
  'Laying out the sections…',
  'Adding the contact form…',
  'Wiring up the interactions…',
  'Polishing…',
];
function startGenStages(el) {
  if (!el) return () => {};
  let i = 0;
  el.textContent = GEN_STAGES[0];
  if (REDUCED_MOTION) return () => {};
  const timer = setInterval(() => {
    i = (i + 1) % GEN_STAGES.length;
    el.classList.add('is-fading');
    setTimeout(() => {
      el.textContent = GEN_STAGES[i];
      el.classList.remove('is-fading');
    }, 250);
  }, 2600);
  return () => clearInterval(timer);
}

// Shape-of-the-content placeholders while a list loads.
function showSkeleton(container, { rows = 3, grid = false } = {}) {
  if (!container) return;
  container.className = container.className
    .replace(/\bskeleton-list\b|\bskeleton-grid\b/g, '').trim();
  container.innerHTML = Array.from({ length: rows }, () => `
    <div class="skeleton">
      <div class="sk-line w-40"></div>
      <div class="sk-line w-80"></div>
      <div class="sk-line w-60"></div>
    </div>`).join('');
  container.classList.add(grid ? 'skeleton-grid' : 'skeleton-list');
}
function clearSkeleton(container) {
  if (!container) return;
  container.classList.remove('skeleton-list', 'skeleton-grid');
}

// A brief burst for a genuinely good moment. Removes itself.
function celebrate() {
  if (REDUCED_MOTION) return;
  const colors = ['#e8853c', '#58c98a', '#7aa7e8', '#f2c14e', '#f29d5c'];
  for (let i = 0; i < 70; i++) {
    const bit = document.createElement('i');
    bit.className = 'confetti-piece';
    bit.style.left = Math.random() * 100 + 'vw';
    bit.style.background = colors[i % colors.length];
    bit.style.animationDuration = (2.2 + Math.random() * 1.6) + 's';
    bit.style.animationDelay = (Math.random() * 0.5) + 's';
    bit.style.borderRadius = Math.random() < 0.4 ? '50%' : '2px';
    document.body.appendChild(bit);
    bit.addEventListener('animationend', () => bit.remove(), { once: true });
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard');
  } catch {
    toast('Could not copy — select and copy manually', true);
  }
}

function downloadFile(filename, content) {
  const blob = new Blob([content], { type: 'text/html' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Carry a site's injected contact-form wiring across a refine when we don't
// have the notify email on hand (e.g. after opening a saved site to edit).
const FORMS_BLOCK_RE = /<!--forge-forms-start-->[\s\S]*?<!--forge-forms-end-->/;
function preserveForms(oldHtml, newHtml) {
  const m = FORMS_BLOCK_RE.exec(oldHtml || '');
  if (!m) return newHtml;
  const cleaned = String(newHtml).replace(new RegExp(FORMS_BLOCK_RE.source, 'g'), '');
  return insertBeforeBodyEnd(cleaned, m[0]);
}

// Before the page's last </body>. Built by slicing rather than String.replace,
// whose replacement text treats "$&" and "$'" as instructions.
function insertBeforeBodyEnd(html, block) {
  const doc = String(html || '');
  const at = doc.toLowerCase().lastIndexOf('</body>');
  return at === -1 ? doc + block : doc.slice(0, at) + block + doc.slice(at);
}

// A stable per-site id, used for the visitor counter beacon. Kept across
// refines so a site's view count doesn't reset when it's edited.
const ANALYTICS_ID_RE = /forge-analytics-start-->[\s\S]*?var S=("|')((?:\\.|[^"'\\])*?)\1/;
function newSiteId() {
  try { return crypto.randomUUID(); } catch { return 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
}
function extractSiteId(html) {
  const m = ANALYTICS_ID_RE.exec(html || '');
  return m ? m[2] : '';
}

// ---------------------------------------------------------------- tabs

const panels = ['build', 'multi', 'sites', 'leads', 'history', 'prospects', 'clients', 'revenue', 'invoice', 'traffic', 'money', 'emails'];

let lastTabIndex = 0;
function switchTab(name) {
  const nextIndex = panels.indexOf(name);
  const dir = nextIndex > lastTabIndex ? 'from-right' : nextIndex < lastTabIndex ? 'from-left' : '';
  lastTabIndex = nextIndex < 0 ? lastTabIndex : nextIndex;
  for (const p of panels) {
    const el = $(`#panel-${p}`);
    el.classList.remove('from-right', 'from-left');
    el.classList.toggle('is-active', p === name);
    if (p === name && dir) el.classList.add(dir);
  }
  document.querySelectorAll('.tab-btn').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.tab === name);
  });
  if (name === 'sites') loadSites();
  if (name === 'leads') {
    loadLeadUsage();
    updateBatchBar();   // a basket restored from last session shows up right away
  }
  if (name === 'history') loadHistory();
  if (name === 'prospects') loadProspects();
  if (name === 'clients') loadClients();
  if (name === 'revenue') loadRevenue();
  if (name === 'invoice') initInvoice();
  if (name === 'traffic') loadTraffic();
  if (name === 'money') loadMoney();
  if (name === 'emails') initEmails();
}

document.querySelectorAll('.tab-btn').forEach((b) => {
  b.addEventListener('click', () => switchTab(b.dataset.tab));
});

// ---------------------------------------------------------------- autogrow

document.querySelectorAll('textarea.autogrow').forEach((ta) => {
  const grow = () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 340) + 'px';
  };
  ta.addEventListener('input', grow);
  grow();
});

// ------------------------------------------------- client-side keyword pass
// Replaces the old multi-call research pipeline: one cheap local pass that
// pulls structured hints out of the prompt, so generation stays a single
// API call per page.

const TRADE_KEYWORDS = [
  'electrician', 'plumbing', 'plumber', 'roofing', 'roofer', 'landscaping',
  'landscaper', 'hvac', 'auto body', 'mechanic', 'auto repair', 'painting',
  'painter', 'general contractor', 'remodeling', 'carpentry', 'masonry',
  'flooring', 'tree service', 'pest control', 'cleaning', 'towing', 'paving',
  'restaurant', 'bakery', 'salon', 'barber', 'dentist', 'law firm', 'gym',
];

function extractKeywords(prompt) {
  const lower = prompt.toLowerCase();
  const lines = [];

  const trades = TRADE_KEYWORDS.filter((t) => lower.includes(t));
  if (trades.length) lines.push(`Business type: ${trades.slice(0, 3).join(', ')}`);

  const phone = prompt.match(/(\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/);
  if (phone) lines.push(`Phone number to feature: ${phone[1]}`);

  const email = prompt.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
  if (email) lines.push(`Email: ${email[0]}`);

  const loc = prompt.match(/\bin ([A-Z][A-Za-z .'-]+,\s*[A-Z]{2})\b/);
  const zip = prompt.match(/\b(\d{5})(?:-\d{4})?\b/);
  if (loc) lines.push(`Location: ${loc[1]}`);
  else if (zip) lines.push(`Location (ZIP): ${zip[1]}`);

  const rating = prompt.match(/(\d(?:\.\d)?)\s*(?:stars?|★)/i);
  if (rating) lines.push(`Rating to highlight: ${rating[1]} stars`);

  return lines.join('\n');
}

// ---------------------------------------------------------------- previews

async function createPreview(payload, outputEl) {
  const res = await api('/api/previews', { method: 'POST', body: payload });
  const fullUrl = location.origin + res.url;
  outputEl.hidden = false;
  outputEl.innerHTML = `
    <a href="${escapeHtml(res.url)}" target="_blank" rel="noopener">${escapeHtml(fullUrl)}</a>
    <button class="btn btn-sm" data-copy="${escapeHtml(fullUrl)}">Copy</button>`;
  outputEl.querySelector('[data-copy]').addEventListener('click', (e) => copyText(e.target.dataset.copy));
  loadSites();
  return res;
}

// My Sites gallery — backed by the same saved previews, shown as thumbnails
// with open-in-builder / copy / delete. The thumbnails are pictures of the
// page, not running copies of it: `sandbox=""` switches their scripts off, so
// opening this tab neither runs anything a generated page contains nor counts
// as a visit to every site at once.
async function loadSites() {
  const grid = $('#sites-grid');
  showSkeleton(grid, { rows: 3, grid: true });
  try {
    const { previews } = await api('/api/previews');
    $('#sites-empty').hidden = previews.length > 0;
    grid.innerHTML = previews.map((p) => `
      <div class="site-card" data-id="${escapeHtml(p.id)}" data-kind="${escapeHtml(p.kind)}" data-url="${escapeHtml(p.url)}">
        <div class="site-thumb"><iframe src="${escapeHtml(p.url)}" sandbox="" loading="lazy" scrolling="no" tabindex="-1" title="preview"></iframe></div>
        <div class="site-card-body">
          <div class="site-card-title">${escapeHtml(p.title || '(untitled site)')}</div>
          <div class="site-card-meta">${p.kind === 'multi' ? 'multi-page' : 'single page'} · ${escapeHtml(formatDate(p.createdAt))}</div>
          <div class="site-card-actions">
            <button class="btn btn-sm btn-primary" data-act="edit">Edit</button>
            <button class="btn btn-sm" data-act="view">View</button>
            <button class="btn btn-sm" data-act="copy">Copy link</button>
            <button class="btn btn-sm btn-danger" data-act="delete">Delete</button>
          </div>
        </div>
      </div>`).join('');
    clearSkeleton(grid);
    staggerIn(grid);
    grid.querySelectorAll('.site-card').forEach((card) => {
      const { id, kind, url } = card.dataset;
      const full = location.origin + url;
      card.querySelector('[data-act="copy"]').addEventListener('click', () => copyText(full));
      card.querySelector('[data-act="delete"]').addEventListener('click', async () => {
        if (!confirm('Delete this saved site and its link? Anyone holding the link will lose access.')) return;
        try {
          await api(`/api/previews/${id}`, { method: 'DELETE' });
          toast('Deleted');
          loadSites();
        } catch (err) { toast(err.message, true); }
      });
      // View = open the live saved page in a new tab (read-only).
      card.querySelector('[data-act="view"]').addEventListener('click', () => window.open(url, '_blank', 'noopener'));

      // Edit = load the saved site back into its builder, where the Refine
      // box and the Desktop/Mobile toggle are available.
      card.querySelector('[data-act="edit"]').addEventListener('click', async () => {
        try {
          const data = await api(`/api/previews/${id}`);
          if (data.kind === 'multi') {
            openMultiInBuilder(data.pages);
            toast('Opened in Multi-page — refine any page, flip to Mobile, then save a new link');
          } else {
            buildState.html = data.html;
            buildState.facts = '';
            buildState.placeId = null;
            buildState.siteId = extractSiteId(data.html) || null;
            showInFrame($('#build-frame'), data.html);
            $('#build-frame').classList.remove('is-mobile');
            reportSlop(data.html, '#build-slop', '');
            $('#build-device').querySelectorAll('button').forEach((x) => x.classList.toggle('is-active', x.dataset.device === 'desktop'));
            $('#build-result').hidden = false;
            $('#build-link-output').hidden = true;
            switchTab('build');
            toast('Opened in Build — refine it or flip to Mobile, then save a new link');
          }
        } catch (err) {
          toast(err.message, true);
        }
      });
    });
  } catch (err) {
    grid.innerHTML = `<p class="inline-error">${escapeHtml(err.message)}</p>`;
  }
}

$('#sites-refresh').addEventListener('click', loadSites);

// ------------------------------------------------- Section 1: single page

// `facts` is the prompt the page was built from, kept so the pre-send check can
// set the page against it. A site opened from My Sites has none.
const buildState = { html: null, placeId: null, notifyEmail: '', siteId: null, facts: '' };

// `direction` is passed in when the caller already fixed one (a lead card shows
// its prompt before you click, so the promise has to match the page). A manual
// build takes the next one in the rotation.
async function generateSingle(prompt, placeId = null, direction = null) {
  const errEl = $('#build-error');
  errEl.hidden = true;
  $('#build-result').hidden = true;
  $('#build-link-output').hidden = true;
  $('#build-loading').hidden = false;
  $('#build-generate').disabled = true;
  const stopStages = startGenStages($('#build-status'));
  const stopElapsed = startElapsed($('#build-elapsed'));
  const waiting = new AbortController();
  $('#build-cancel').onclick = () => waiting.abort();

  const notifyEmail = ($('#build-notify-email')?.value || '').trim();
  const siteId = newSiteId();
  try {
    const context = extractKeywords(prompt);
    // The prompt text itself is the niche hint: a concept's `match` is a regex,
    // so "a plumber in Worcester MA" selects the plumbing concepts. Passing an
    // empty niche here used to hand manual builds a concept at random.
    const dir = direction
      || { concept: pickConcept(prompt, { placeId: prompt.slice(0, 80) }), layout: nextLayout({ placeId: prompt.slice(0, 80) }) };
    const fullPrompt = direction
      ? prompt
      : `${prompt}\n\n${conceptInstruction(dir.concept)}\n\n${layoutInstruction(dir.layout)}`;

    const res = await api('/api/generate', {
      method: 'POST',
      body: { mode: 'page', prompt: fullPrompt, context, notifyEmail, siteId },
      signal: waiting.signal,
    });
    // Recorded only when a site is really generated, so the variety window
    // tracks what was built rather than what was merely looked at. The font is
    // whatever the model actually chose, read back off its own concept note.
    rememberPick({
      concept: dir.concept.key,
      layout: dir.layout.key,
      font: parseConcept(res.html)?.['display-font'] || '',
    });
    buildState.html = res.html;
    buildState.placeId = placeId;
    buildState.notifyEmail = notifyEmail;
    buildState.siteId = siteId;
    buildState.facts = fullPrompt;
    swapFrame($('#build-frame'), res.html);
    $('#build-result').hidden = false;
    reportSlop(res.html, '#build-slop', fullPrompt);
    toast('Site generated');
  } catch (err) {
    errEl.textContent = err.cancelled
      ? 'Stopped waiting. If the AI had already started on the page, that credit was still used.'
      : err.message;
    errEl.hidden = false;
  } finally {
    stopStages();
    stopElapsed();
    $('#build-loading').hidden = true;
    $('#build-generate').disabled = false;
  }
}

$('#build-generate').addEventListener('click', () => {
  const prompt = $('#build-prompt').value.trim();
  if (!prompt) {
    const errEl = $('#build-error');
    errEl.textContent = 'Describe the site you want first — a sentence or two is plenty.';
    errEl.hidden = false;
    return;
  }
  generateSingle(prompt, null);
});

$('#build-preview-link').addEventListener('click', async (e) => {
  if (!buildState.html) return;
  e.target.disabled = true;
  try {
    await createPreview(
      { kind: 'single', html: buildState.html, placeId: buildState.placeId },
      $('#build-link-output')
    );
    toast('Preview link ready — send it to the prospect');
  } catch (err) {
    toast(err.message, true);
  } finally {
    e.target.disabled = false;
  }
});

$('#build-copy').addEventListener('click', () => buildState.html && copyText(buildState.html));
$('#build-download').addEventListener('click', () => buildState.html && downloadFile('site.html', buildState.html));

// ---- Set/update contact email on an ALREADY-generated site — free, no AI.
// Lets you build a demo before you know the prospect's email, then wire it in
// the moment they say yes, without spending a single credit.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

$('#build-set-email')?.addEventListener('click', async () => {
  if (!buildState.html) { toast('Generate a site first', true); return; }
  const email = ($('#build-notify-email')?.value || '').trim();
  if (!EMAIL_RE.test(email)) { toast('Enter a valid email first', true); return; }
  if (!buildState.siteId) buildState.siteId = extractSiteId(buildState.html) || newSiteId();
  const btn = $('#build-set-email');
  btn.disabled = true;
  try {
    const res = await api('/api/rewire', {
      method: 'POST',
      body: { html: buildState.html, notifyEmail: email, siteId: buildState.siteId },
    });
    buildState.html = res.html;
    buildState.notifyEmail = email;
    showInFrame($('#build-frame'), res.html);
    $('#build-link-output').hidden = true;
    toast('Contact email set — free, no credits used');
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

// ---- Prompt helper: paste raw business info -> a facts block (no AI, free).
// The pasted text goes through untouched as the facts, with the same reading
// rules a Lead Finder site gets. It used to be wrapped in an order for "a
// professional, modern" page with a hero, a services section, a why-choose-us
// section and a testimonials section — the exact template the design rules
// exist to get away from, and an invitation to invent the testimonials.
function makePromptFromInfo(raw, { multiPage = false } = {}) {
  const text = String(raw || '').replace(/\r/g, '').trim();
  if (!text) return '';
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  let name = (lines[0] || 'this business').replace(/\s+/g, ' ').slice(0, 120);
  // Strip a trailing rating/review count if it landed on the name line.
  name = name.replace(/\s+[0-5](\.\d)?\s*(★|stars?)?\s*\(?[\d,]+\)?\s*(reviews?)?\s*$/i, '').trim() || name;
  const loc = (text.match(/\b([A-Z][A-Za-z .'\-]+,\s*[A-Z]{2})\b/) || [])[1];

  const out = [
    `Build the ${multiPage ? 'multi-page website' : 'one-page website'} for ${name}${loc ? `, in ${loc}` : ''}.`,
    '',
    'BUSINESS FACTS — everything known about them is below, exactly as it was pasted in. Use only these and invent nothing:',
    lines.map((l) => `    ${l}`).join('\n').slice(0, 6000),
    '',
    'How to read them:',
    '- A phone number in there is the number to call. If there is none, show no phone number and make the contact form the call to action.',
    '- Show a star rating or a review count only if it appears above, and exactly as it appears.',
    '- Quote a customer only if their words appear above, word for word. Otherwise write no testimonials.',
    '- Not stated above means not known: hours, years in business, licences, insurance, certifications, prices, free estimates, service area, the owner\'s name. Leave each one out rather than guess.',
    '- Photos: none. Design without photographs — no stock photography.',
  ];
  return out.join('\n');
}

$('#pb-make')?.addEventListener('click', () => {
  const info = ($('#pb-input')?.value || '').trim();
  if (!info) { toast('Paste some business info first', true); return; }
  const box = $('#build-prompt');
  box.value = makePromptFromInfo(info);
  box.dispatchEvent(new Event('input')); // resize + refresh hint
  box.focus();
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  toast('Prompt ready — tweak it if you want, then hit Generate');
});

$('#pb-make-multi')?.addEventListener('click', () => {
  const info = ($('#pb-input-multi')?.value || '').trim();
  if (!info) { toast('Paste some business info first', true); return; }
  const box = $('#multi-prompt');
  box.value = makePromptFromInfo(info, { multiPage: true });
  box.dispatchEvent(new Event('input'));
  box.focus();
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  toast('Prompt ready — tweak it if you want, then hit Generate');
});

// ------------------------------------------------- Section 2: multi-page

const multiState = { pages: {}, defs: [], current: null, placeId: null, notifyEmail: '', siteId: null };

function selectedPageDefs() {
  const defs = [{ filename: 'index.html', title: 'Home' }];
  $('#multi-pages').querySelectorAll('input[type="checkbox"]:checked').forEach((cb) => {
    if (cb.value !== 'index.html') defs.push({ filename: cb.value, title: cb.dataset.title });
  });
  return defs;
}

function setProgress(defs, statuses) {
  $('#multi-progress').innerHTML = defs.map((d) => {
    const s = statuses[d.filename] || 'waiting';
    const cls = s === 'done' ? 'chip done' : s === 'fail' ? 'chip fail' : 'chip';
    const label = s === 'done' ? '✓' : s === 'fail' ? '✕' : '…';
    return `<span class="${cls}">${escapeHtml(d.title)} ${label}</span>`;
  }).join('');
}

// Iframe-only shim: intercepts clicks on relative .html links inside the
// local preview and switches the page tab instead of 404ing. Stored and
// shared-preview HTML stays untouched (real preview URLs navigate normally).
function withNavShim(html) {
  const shim = `<script>document.addEventListener('click',function(e){var a=e.target.closest('a');if(!a)return;var h=a.getAttribute('href')||'';if(/^[a-z0-9-]+\\.html$/i.test(h)){e.preventDefault();parent.postMessage({forgePage:h},'*');}});<\/script>`;
  return insertBeforeBodyEnd(html, shim);
}

window.addEventListener('message', (e) => {
  if (e.data && e.data.forgePage && multiState.pages[e.data.forgePage]) {
    showMultiPage(e.data.forgePage);
  }
});

function showMultiPage(filename) {
  multiState.current = filename;
  swapFrame($('#multi-frame'), withNavShim(multiState.pages[filename]));
  $('#multi-tabs').querySelectorAll('button').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.file === filename);
  });
}

function renderMultiResult() {
  $('#multi-tabs').innerHTML = multiState.defs
    .map((d) => `<button data-file="${escapeHtml(d.filename)}">${escapeHtml(d.title)}</button>`)
    .join('');
  $('#multi-tabs').querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => showMultiPage(b.dataset.file));
  });
  $('#multi-result').hidden = false;
  showMultiPage('index.html');
}

const PAGE_TITLES = {
  'index.html': 'Home', 'about.html': 'About', 'services.html': 'Services',
  'contact.html': 'Contact', 'gallery.html': 'Gallery', 'reviews.html': 'Reviews',
};
function titleForFile(f) {
  return PAGE_TITLES[f] || f.replace(/\.html$/i, '').replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Load a saved multi-page site back into the Multi-page builder so it can be
// refined page by page (index.html first, then the rest).
function openMultiInBuilder(pages) {
  const files = Object.keys(pages || {}).filter((f) => pages[f]);
  if (!files.length) { toast('This site has no pages to edit', true); return; }
  const ordered = ['index.html', ...files.filter((f) => f !== 'index.html')].filter((f) => pages[f]);
  multiState.pages = pages;
  multiState.defs = ordered.map((f) => ({ filename: f, title: titleForFile(f) }));
  multiState.placeId = null;
  multiState.siteId = extractSiteId(pages['index.html'] || '') || null;
  $('#multi-error').hidden = true;
  $('#multi-link-output').hidden = true;
  renderMultiResult();
  switchTab('multi');
}

// Generate the given pages of a multi-page job. Returns what finished and what
// did not; a failure on one page never discards the others.
async function generatePages(job, targetDefs, statuses, signal) {
  const results = await Promise.allSettled(targetDefs.map((page) =>
    api('/api/generate', {
      method: 'POST',
      body: {
        mode: 'page', prompt: job.prompt, context: job.context, brand: job.brand,
        page, pages: job.defs, notifyEmail: job.notifyEmail, siteId: job.siteId,
      },
      signal,
    }).then((res) => {
      statuses[page.filename] = 'done';
      setProgress(job.defs, statuses);
      return { page, html: res.html };
    }).catch((err) => {
      statuses[page.filename] = 'fail';
      setProgress(job.defs, statuses);
      throw Object.assign(err, { page });
    })
  ));
  const pages = {};
  const failed = [];
  for (const r of results) {
    if (r.status === 'fulfilled') pages[r.value.page.filename] = r.value.html;
    else failed.push(r.reason);
  }
  return { pages, failed };
}

// Show whatever pages exist, and if some are missing say which and offer to
// make just those. Each page is its own paid call, so throwing away four good
// pages because the fifth hit a rate limit wasted most of the job.
function settleMultiJob(job, pages, failed, statuses) {
  multiState.pages = { ...multiState.pages, ...pages };
  multiState.defs = job.defs.filter((d) => multiState.pages[d.filename]);
  const errEl = $('#multi-error');

  if (multiState.pages['index.html']) renderMultiResult();
  if (!failed.length) {
    errEl.hidden = true;
    toast('Site generated — all pages share one brand');
    return;
  }

  const missing = failed.map((f) => f.page);
  const cancelled = failed.every((f) => f.cancelled);
  const why = cancelled
    ? 'Stopped waiting. Pages the AI had already started on still used their credits.'
    : failed[0].message;
  const have = multiState.defs.length;
  errEl.innerHTML = `${escapeHtml(`${missing.length} of ${job.defs.length} pages did not finish (${missing.map((p) => p.title).join(', ')}). ${why}`)}
    ${have ? escapeHtml(` The ${have} that did ${have === 1 ? 'is' : 'are'} kept.`) : ''}
    <button type="button" class="btn btn-sm" id="multi-retry">Make the missing ${missing.length === 1 ? 'page' : 'pages'} (${missing.length} credit${missing.length === 1 ? '' : 's'})</button>`;
  errEl.hidden = false;
  $('#multi-retry').addEventListener('click', async () => {
    errEl.hidden = true;
    $('#multi-loading').hidden = false;
    $('#multi-generate').disabled = true;
    for (const p of missing) statuses[p.filename] = 'waiting';
    setProgress(job.defs, statuses);
    $('#multi-status').textContent = `Generating ${missing.length} missing page${missing.length === 1 ? '' : 's'}…`;
    const stopElapsed = startElapsed($('#multi-elapsed'));
    const waiting = new AbortController();
    $('#multi-cancel').onclick = () => waiting.abort();
    try {
      const again = await generatePages(job, missing, statuses, waiting.signal);
      settleMultiJob(job, again.pages, again.failed, statuses);
    } finally {
      stopElapsed();
      $('#multi-loading').hidden = true;
      $('#multi-generate').disabled = false;
    }
  });
}

async function generateMulti(prompt) {
  const errEl = $('#multi-error');
  errEl.hidden = true;
  $('#multi-result').hidden = true;
  $('#multi-link-output').hidden = true;
  $('#multi-loading').hidden = false;
  $('#multi-generate').disabled = true;

  const defs = selectedPageDefs();
  const statuses = {};
  setProgress(defs, statuses);
  const notifyEmail = ($('#multi-notify-email')?.value || '').trim();
  multiState.notifyEmail = notifyEmail;
  multiState.pages = {};
  multiState.defs = [];
  const siteId = newSiteId();
  multiState.siteId = siteId;
  const stopElapsed = startElapsed($('#multi-elapsed'));
  const waiting = new AbortController();
  $('#multi-cancel').onclick = () => waiting.abort();

  try {
    // One design direction for the whole site, chosen the same way a single
    // page's is. Only the concept: the structure briefs describe one-page
    // shapes, and a multi-page site divides its content across pages instead.
    const concept = pickConcept(prompt, { placeId: prompt.slice(0, 80) });
    const sitePrompt = `${prompt}\n\n${conceptInstruction(concept)}`;

    // Pass 1 — one shared brand/style summary for the whole site.
    $('#multi-status').textContent = 'Locking the brand direction for the whole site…';
    const brandRes = await api('/api/generate', {
      method: 'POST',
      body: { mode: 'brand', prompt: sitePrompt, pages: defs },
      signal: waiting.signal,
    });

    // Pass 2 — every page gets the same brand brief, so styling/tone/nav
    // stay consistent across the site.
    $('#multi-status').textContent = `Generating ${defs.length} pages with a shared brand…`;
    const job = { prompt: sitePrompt, context: extractKeywords(prompt), brand: brandRes.brand, defs, notifyEmail, siteId };
    const { pages, failed } = await generatePages(job, defs, statuses, waiting.signal);
    if (!failed.length) {
      rememberPick({ concept: concept.key, layout: 'multi', font: parseConcept(pages['index.html'])?.['display-font'] || '' });
    }
    settleMultiJob(job, pages, failed, statuses);
  } catch (err) {
    errEl.textContent = err.cancelled
      ? 'Stopped waiting. If the AI had already started, that credit was still used.'
      : err.message;
    errEl.hidden = false;
  } finally {
    stopElapsed();
    $('#multi-loading').hidden = true;
    $('#multi-generate').disabled = false;
  }
}

$('#multi-generate').addEventListener('click', () => {
  const prompt = $('#multi-prompt').value.trim();
  if (!prompt) {
    const errEl = $('#multi-error');
    errEl.textContent = 'Describe the site you want first.';
    errEl.hidden = false;
    return;
  }
  generateMulti(prompt);
});

$('#multi-preview-link').addEventListener('click', async (e) => {
  if (!Object.keys(multiState.pages).length) return;
  e.target.disabled = true;
  try {
    await createPreview(
      { kind: 'multi', pages: multiState.pages, placeId: multiState.placeId },
      $('#multi-link-output')
    );
    toast('Preview link ready — pages link to each other on the live URL');
  } catch (err) {
    toast(err.message, true);
  } finally {
    e.target.disabled = false;
  }
});

$('#multi-download').addEventListener('click', () => {
  if (multiState.current && multiState.pages[multiState.current]) {
    downloadFile(multiState.current, multiState.pages[multiState.current]);
  }
});

// Set/update contact email across every page of an already-generated
// multi-page site — free, no AI. Same use case as the Build tab: pre-build a
// demo without knowing the prospect's email, wire it in once they say yes.
$('#multi-set-email')?.addEventListener('click', async () => {
  const files = Object.keys(multiState.pages || {}).filter((f) => multiState.pages[f]);
  if (!files.length) { toast('Generate a site first', true); return; }
  const email = ($('#multi-notify-email')?.value || '').trim();
  if (!EMAIL_RE.test(email)) { toast('Enter a valid email first', true); return; }
  if (!multiState.siteId) multiState.siteId = extractSiteId(multiState.pages[files[0]]) || newSiteId();
  const btn = $('#multi-set-email');
  btn.disabled = true;
  try {
    for (const f of files) {
      const res = await api('/api/rewire', {
        method: 'POST',
        body: { html: multiState.pages[f], notifyEmail: email, siteId: multiState.siteId },
      });
      multiState.pages[f] = res.html;
    }
    multiState.notifyEmail = email;
    if (multiState.current) showMultiPage(multiState.current);
    $('#multi-link-output').hidden = true;
    toast(`Contact email set on all ${files.length} pages — free, no credits used`);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------------- Section 3: Lead Finder

// `selected` is the basket: place ID -> { lead, niche }. It deliberately
// outlives a search, so leads picked in one ZIP or niche are still there after
// searching another. Every entry carries its own niche because a mixed basket
// can't share one — the prompt for a plumber isn't the prompt for a bakery.
const BASKET_KEY = 'forge.leadBasket';
const leadState = { niche: '', leads: [], selected: new Map() };

function saveBasket() {
  try {
    localStorage.setItem(BASKET_KEY, JSON.stringify(Array.from(leadState.selected.values())));
  } catch {
    // Storage blocked or full — the basket still works for this session.
  }
}

// Survives an accidental refresh, so an afternoon's picks aren't one stray
// reload away from being gone.
function loadBasket() {
  try {
    const saved = JSON.parse(localStorage.getItem(BASKET_KEY) || '[]');
    if (!Array.isArray(saved)) return;
    for (const entry of saved) {
      if (entry && entry.lead && entry.lead.placeId) {
        leadState.selected.set(entry.lead.placeId, { lead: entry.lead, niche: entry.niche || '' });
      }
    }
  } catch {
    // A corrupt basket just starts empty rather than breaking the tab.
  }
}

function basketAdd(lead, niche) {
  leadState.selected.set(lead.placeId, { lead, niche });
  saveBasket();
  updateBatchBar();
  syncSelectCheckboxes(lead.placeId, true);
}

function basketRemove(placeId) {
  leadState.selected.delete(placeId);
  saveBasket();
  updateBatchBar();
  syncSelectCheckboxes(placeId, false);
}

// Every rendered lead card carries a select box. This makes one of them live,
// pre-ticked if the lead is already in the basket.
function wireSelectCheckbox(container, lead, niche) {
  const cb = container.querySelector('.lead-select-cb');
  if (!cb) return;
  cb.checked = leadState.selected.has(lead.placeId);
  cb.addEventListener('change', () => {
    if (cb.checked) basketAdd(lead, niche);
    else basketRemove(lead.placeId);
  });
}

// One lead can have a checkbox in the results grid and another in the detail
// modal at the same time. Whichever one is clicked, both follow.
function syncSelectCheckboxes(placeId, checked) {
  document.querySelectorAll(`.lead-select-cb[data-place-id="${CSS.escape(placeId)}"]`)
    .forEach((cb) => { cb.checked = checked; });
}

loadBasket();

// Google gives 1,000 free Places searches a month and Forge uses exactly one
// per search, so this count is the free-tier count. Shown on every search so
// the number is never a surprise.
function renderLeadUsage(usage) {
  const box = $('#lead-usage');
  if (!box || !usage) return;
  const today = Number(usage.today) || 0;
  const remaining = Number(usage.monthRemaining) || 0;
  const target = Number(usage.dayTarget) || 30;

  const changed = $('#lu-today').textContent !== String(today);
  $('#lu-today').textContent = today;
  $('#lu-month-remaining').textContent = remaining.toLocaleString();
  if (changed && !REDUCED_MOTION) {
    box.classList.remove('just-changed');
    void box.offsetWidth;            // restart the animation
    box.classList.add('just-changed');
  }
  // Warn once the day's pace or the month's allowance starts running out.
  box.classList.toggle('is-warn', today >= target || remaining <= 100);
  box.hidden = false;
}

async function loadLeadUsage() {
  try {
    renderLeadUsage(await api(`/api/leads/usage?day=${encodeURIComponent(localToday())}`));
  } catch {
    // A missing counter shouldn't get in the way of finding leads.
  }
}

function resolveNiche() {
  const sel = $('#lead-niche').value;
  if (sel !== '__other') return sel;
  return $('#lead-niche-other').value.trim();
}

$('#lead-niche').addEventListener('change', () => {
  $('#lead-niche-other').hidden = $('#lead-niche').value !== '__other';
});

// "a electrician" and "a auto detailing" read as sloppy in a prompt the user
// can see on the lead card. Vowel sounds take "an" — including acronyms like
// HVAC, which is spoken "aitch-vack" even though H is a consonant.
const AN_ACRONYM_INITIALS = new Set(['A', 'E', 'F', 'H', 'I', 'L', 'M', 'N', 'O', 'R', 'S', 'X']);
function article(word) {
  const w = String(word || '').trim();
  if (!w) return 'a';
  if (/^[aeiou]/i.test(w)) return 'an';
  // Treat a leading run of capitals as an acronym read letter by letter.
  if (/^[A-Z]{2,}/.test(w) && AN_ACRONYM_INITIALS.has(w[0])) return 'an';
  return 'a';
}

// ---- Service area, without a second API call ---------------------------------
// The spec wants the business's town plus three to six towns it plausibly
// serves. Google's search response carries one address and nothing about what
// is next door, and a geocoding lookup would be a second billable call per
// lead. So the neighbours are a static table of Central Mass, which is the
// market Forge is actually pointed at. An unknown town falls back to naming
// only the town itself — the generator is forbidden from inventing the rest.
const TOWN_NEIGHBORS = {
  worcester: ['Shrewsbury', 'Auburn', 'Millbury', 'Holden', 'West Boylston', 'Leicester'],
  shrewsbury: ['Worcester', 'Westborough', 'Grafton', 'Northborough', 'Boylston'],
  auburn: ['Worcester', 'Millbury', 'Oxford', 'Leicester', 'Charlton'],
  millbury: ['Worcester', 'Auburn', 'Grafton', 'Sutton', 'Oxford'],
  holden: ['Worcester', 'West Boylston', 'Paxton', 'Rutland', 'Sterling'],
  westborough: ['Shrewsbury', 'Northborough', 'Grafton', 'Hopkinton', 'Marlborough'],
  northborough: ['Shrewsbury', 'Westborough', 'Marlborough', 'Berlin', 'Boylston'],
  grafton: ['Shrewsbury', 'Millbury', 'Westborough', 'Upton', 'Sutton'],
  oxford: ['Auburn', 'Charlton', 'Sutton', 'Webster', 'Millbury'],
  leicester: ['Worcester', 'Auburn', 'Spencer', 'Paxton', 'Rochdale'],
  spencer: ['Leicester', 'Charlton', 'Sturbridge', 'Paxton', 'East Brookfield'],
  charlton: ['Oxford', 'Auburn', 'Spencer', 'Sturbridge', 'Southbridge'],
  sutton: ['Millbury', 'Oxford', 'Grafton', 'Northbridge', 'Douglas'],
  webster: ['Oxford', 'Dudley', 'Thompson', 'Douglas'],
  clinton: ['Sterling', 'Lancaster', 'Berlin', 'Boylston'],
  sterling: ['Holden', 'Clinton', 'Lancaster', 'West Boylston', 'Princeton'],
  leominster: ['Fitchburg', 'Lunenburg', 'Sterling', 'Lancaster', 'Princeton'],
  fitchburg: ['Leominster', 'Lunenburg', 'Westminster', 'Ashby'],
  gardner: ['Westminster', 'Templeton', 'Hubbardston', 'Ashburnham'],
  marlborough: ['Northborough', 'Westborough', 'Southborough', 'Hudson', 'Sudbury'],
  framingham: ['Marlborough', 'Natick', 'Ashland', 'Southborough'],
  'west boylston': ['Worcester', 'Holden', 'Boylston', 'Sterling'],
  boylston: ['West Boylston', 'Shrewsbury', 'Northborough', 'Clinton'],
  paxton: ['Worcester', 'Holden', 'Leicester', 'Rutland', 'Spencer'],
  'northbridge': ['Sutton', 'Uxbridge', 'Grafton', 'Douglas'],
  uxbridge: ['Northbridge', 'Douglas', 'Millville', 'Sutton'],
  dudley: ['Webster', 'Southbridge', 'Oxford', 'Charlton'],
  southbridge: ['Charlton', 'Dudley', 'Sturbridge', 'Brookfield'],
};

// Google's formattedAddress reads "107 Main St, Worcester, MA 01604, USA" —
// the town is the field before the state.
function townFromAddress(address) {
  const parts = String(address || '').split(',').map((x) => x.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (/^[A-Z]{2}\s+\d{5}/.test(parts[i]) || /^[A-Z]{2}$/.test(parts[i])) {
      return parts[i - 1] || '';
    }
  }
  return parts.length >= 2 ? parts[parts.length - 2] : '';
}

function serviceAreaFor(address) {
  const town = townFromAddress(address);
  const near = TOWN_NEIGHBORS[town.toLowerCase()] || [];
  return { town, nearby: near.slice(0, 6) };
}

// ---- Concept library (spec Section 5) ---------------------------------------
// Starting points, not templates. Each concept names a direction the model
// would not reach for on its own; the business's real facts then bend it.
// `match` is tested against the niche, so one entry covers a family of trades.
const CONCEPTS = [
  { key: 'high-voltage', name: 'High Voltage', match: /electric/i,
    brief: 'Near-black ground, one electric accent (safety yellow or arc blue), sharp angled section dividers, heavy condensed type. Reads like a van at night.' },
  { key: 'blueprint', name: 'Blueprint', match: /electric|contractor|carpent|remodel|builder/i,
    brief: 'Navy ground with a fine white grid, technical-drawing line work, dimension marks, monospace labels against a strong slab serif. Services laid out like a panel schedule.' },
  { key: 'panel-label', name: 'Panel Label', match: /electric/i,
    brief: 'Off-white ground with labels styled like breaker-panel stickers and a numbered, circuit-style services list.' },

  { key: 'emergency-line', name: 'Emergency Line', match: /plumb|drain|septic|water|restoration/i,
    brief: 'The phone number IS the hero, set enormous. Water-blue accent, bold condensed type, an ink-stamp mark carrying the town name. Built for somebody standing in a puddle. A 24-hour or emergency claim appears only if their listed hours show it.' },
  { key: 'old-school-trade', name: 'Old-School Trade', match: /plumb|lock|hardware|upholster|cobbler|tailor/i,
    brief: 'Cream and deep green, slab serif, copper-pipe line illustrations, the feel of a hand-painted shop sign that has been there forty years.' },

  { key: 'hot-cold-split', name: 'Hot / Cold Split', match: /hvac|heating|air condition|furnace|boiler/i,
    brief: 'The hero splits into a warm half and a cool half and the visitor picks their problem. Nothing centred, no shared middle.' },
  { key: 'thermostat', name: 'Thermostat', match: /hvac|heating|air condition/i,
    brief: 'Huge numerals, a dial-like circular element as the main graphic, cool grey with a single orange accent.' },

  { key: 'garage-floor', name: 'Garage Floor Industrial', match: /auto|car|tire|mechanic|collision|body shop|transmission|muffler/i,
    brief: 'Concrete grey, safety yellow and black hazard striping, stencil or heavy condensed type, the phone number set on a license-plate graphic.' },
  { key: 'before-after', name: 'Before / After', photos: true, match: /auto|collision|body shop|detail|clean|pressure wash|restoration|landscap/i,
    brief: 'A real before/after pair as the hero with a working drag divider, built around the photo slots their own pictures will fill.' },
  { key: 'racing-livery', name: 'Racing Livery', match: /auto|car|tire|detail|performance|mechanic/i,
    brief: 'Bold diagonal colour bands, heavy italic type, a checker motif used once and sparingly.' },

  { key: 'field-guide', name: 'Field Guide', match: /landscap|lawn|tree|garden|nursery|snow/i,
    brief: 'Editorial serif, muted greens and soil browns, services laid out as a seasons timeline from spring cleanup through mowing, leaves and snow.' },
  { key: 'full-bleed', name: 'Full Bleed', photos: true, match: /landscap|lawn|pool|roof|paint|floor/i,
    brief: 'Enormous photographs of their own work with minimal text over them, built around the photo slots their pictures will fill.' },

  { key: 'storm-ready', name: 'Storm Ready', match: /roof|gutter|siding|chimney|restoration/i,
    brief: 'Dark slate, one strong accent, copy built around storm damage and insurance claims when the business handles them.' },
  { key: 'shingle', name: 'Shingle Pattern', match: /roof|siding/i,
    brief: 'Overlapping offset blocks shaped like courses of shingles, used as the section shapes themselves.' },

  { key: 'crisp', name: 'Crisp', match: /clean|maid|janitor|pressure wash|window|carpet/i,
    brief: 'Generous white space, one bright fresh accent, and a single clean wipe transition revealed on scroll — drawn in colour and shape, not photographs.' },
  { key: 'checklist', name: 'Checklist', match: /clean|maid|janitor|inspect|move|handyman/i,
    brief: 'Services as a satisfying checklist that ticks itself off as the visitor scrolls.' },

  { key: 'menu-board', name: 'Menu Board', match: /restaurant|pizza|cafe|coffee|deli|bakery|food|bar|grill|taco|diner/i,
    brief: 'The page reads like their actual menu — chalkboard or printed-menu typesetting, prices where prices are known, the menu as the largest element.' },
  { key: 'sunday-morning', name: 'Sunday Morning', match: /bakery|cafe|coffee|donut|ice cream|candy|brunch/i,
    brief: 'Warm cream ground, a soft serif, slightly hand-made shapes, and the hours set big because that is what visitors came to find.' },
  { key: 'neighborhood-spot', name: 'Neighborhood Spot', match: /restaurant|cafe|bar|deli|pizza|convenience|liquor|market/i,
    brief: 'Street name and town in very large type, like the lettering on an awning, and a come-by-and-see-us voice. Their address does the work a photograph would.' },

  { key: 'classic-barber', name: 'Classic Barber', match: /barber|salon|hair|nail|spa|lash|brow/i,
    brief: 'Red, white and navy stripe accents used sparingly, a serif with real personality, the price list presented as a framed sign.' },
  { key: 'studio', name: 'Studio', photos: true, match: /barber|salon|hair|nail|tattoo|photo|lash|brow|makeup/i,
    brief: 'Monochrome with one bold colour, large photographs of their own work carrying the page, built around the photo slots their pictures will fill.' },

  { key: 'poster', name: 'Poster', match: /gym|fitness|martial|boxing|yoga|crossfit|dance|climb/i,
    brief: 'Oversized type bleeding off the edges, hard contrast, the class schedule as a bold grid.' },

  { key: 'calm-clinic', name: 'Calm Clinic', match: /dentist|dental|chiro|medical|clinic|doctor|vet|therap|optom|podiat/i,
    brief: 'Soft warm neutrals rather than cold hospital blue, a friendly rounded serif, booking up front. No photographs of people.' },

  { key: 'job-site', name: 'Job Site', match: /contractor|remodel|carpent|builder|kitchen|bath|deck|fence|concrete|mason|handyman/i,
    brief: 'Kraft-paper and pencil tones, measurement marks and dimension lines, short hand-written annotations in the margins — a page that reads like the sketch a builder makes on site.' },
  { key: 'portfolio', name: 'Portfolio', photos: true, match: /contractor|remodel|carpent|paint|floor|kitchen|bath|landscap|tile|cabinet/i,
    brief: 'Project-first layout built around the photo slots their own pictures will fill, each with room for a town and a single line about what was done.' },

  // Cross-trade directions. Section 11 wants nothing repeating inside a window
  // of ten, but the niche-specific lists above are only two or three deep for
  // some trades — a plumber matched five concepts in total, so a run of ten
  // plumbers had to recycle. These apply to any trade and give every niche a
  // pool deep enough for the window to actually hold.
  { key: 'work-order', name: 'Work Order', match: /./,
    brief: 'The page is laid out like one of their own work orders or invoices: ruled rows, a job-number header, monospace labels against a plain workhorse face. Services are line items.' },
  { key: 'night-shift', name: 'Night Shift', match: /./,
    brief: 'A dark ground with one warm lit accent, like a shop window still lit after dark. The mood is visual only: say nothing about late or emergency hours unless their listed hours show them.' },
  { key: 'hand-painted', name: 'Hand Painted', match: /./,
    brief: 'Sign-painter lettering with slight irregularity, a two-colour palette like a window gilded forty years ago, and the town name given as much weight as the trade.' },
  { key: 'stamped', name: 'Stamped', match: /./,
    brief: 'Ink-stamp marks, a municipal form feel, one strong red used only for the stamps. Headings sit in boxed rules. Plain, official and unfussy.' },
  { key: 'ledger', name: 'Ledger', match: /./,
    brief: 'A ruled-ledger grid with hairline rules and tabular figures, prices and services aligned in columns. Numbers are the design.' },

  // Fallbacks, so an unmatched niche still gets a direction rather than drifting
  // to the statistical average.
  { key: 'price-board', name: 'Price Board', match: /./,
    brief: 'The services and prices typeset as a real board or menu, as the largest and most confident element on the page.' },
  { key: 'one-room', name: 'One Room', match: /./,
    brief: 'The whole business on a single screen: what they do, the town, the phone number set large, hours. Almost nothing below the fold.' },
  { key: 'town-name', name: 'Town Name', match: /./,
    brief: 'The town set in type large enough to read from across the room, the trade underneath it, a local and unfussy voice.' },
];

// ---- Variety tracking (spec Section 11) -------------------------------------
// Two demos in one batch must not share a concept, a display font or a hero
// layout, and nothing repeats inside a window of the last ten.
const VARIETY_KEY = 'forge.recentPicks';
const VARIETY_WINDOW = 10;

function readRecent() {
  try {
    const v = JSON.parse(localStorage.getItem(VARIETY_KEY) || '[]');
    return Array.isArray(v) ? v.slice(-VARIETY_WINDOW) : [];
  } catch {
    return [];
  }
}

function rememberPick(pick) {
  try {
    const next = readRecent().concat([pick]).slice(-VARIETY_WINDOW);
    localStorage.setItem(VARIETY_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked; variety still holds for this page's lifetime via the
    // in-memory assignments below.
  }
}

// Pick a concept that fits the niche and hasn't been used in the recent window.
// Falls back to the least recently used candidate rather than refusing, so a
// long run in one niche still rotates instead of stalling.
function pickConcept(niche, lead, taken = []) {
  // A direction that needs something this business cannot supply is never
  // offered. Forge used to hand out photo-led concepts to leads with no
  // photographs, which left the model to fake the pictures or ignore the brief.
  const usable = CONCEPTS.filter((c) => fitsLead(c, lead));
  const candidates = usable.filter((c) => c.match.test(niche || ''));
  const pool = candidates.length ? candidates : usable;
  // `taken` holds the concepts already handed to other leads in this batch, so
  // two demos shown to two shops on the same street can't come out as twins.
  const recent = readRecent().map((p) => p.concept).concat(taken);

  const unused = pool.filter((c) => !recent.includes(c.key));
  if (unused.length) {
    // Deterministic per business, so the same lead keeps the same concept.
    return unused[hashString(lead.placeId) % unused.length];
  }
  // Everything in the pool is recent: take whichever was used longest ago.
  let best = pool[0];
  let bestAge = -1;
  for (const c of pool) {
    const age = recent.length - 1 - recent.lastIndexOf(c.key);
    if (age > bestAge) { bestAge = age; best = c; }
  }
  return best;
}

function hashString(str) {
  let h = 0;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

// ---- Layout archetypes ----------------------------------------------------
// The art-style picker only ever changed the paint: colours, fonts, texture.
// The bones underneath never moved, so a Brutalist bakery and a Luxury plumber
// still came out as the same page. These are the bones. Each one is a genuinely
// different structure — different section order, different hero, different
// things left out — so two demos never read as the same template wearing a
// different coat.
const LAYOUTS = [
  {
    key: 'gallery',
    name: 'Gallery-first',
    photos: true,
    blurb: 'The work leads. Barely any text above the photos.',
    brief: `Structure the page around the WORK, not around words. Open with a full-bleed image grid or a large photo mosaic — the business name and phone sit over or beside it, small. No paragraph of intro copy before the images; the visitor should be looking at work within one second. Below the grid: a short band of what they do (a compact list, not cards), then reviews, then contact. Omit any "why choose us" section entirely — the photographs are the argument. Clicking a photo opens a lightbox.`,
  },
  {
    key: 'split',
    name: 'Split screen',
    blurb: 'A panel locked on one side, content scrolls past it.',
    brief: `Build a two-column split. On desktop, one half of the viewport holds a fixed, full-height panel of solid colour and type that stays put; the other half scrolls through the content. The business name, tagline and phone live in the fixed panel and remain visible the whole way down. The scrolling half moves through short, generously spaced blocks — one idea per screen. Collapse to a single column on mobile with the panel becoming a tall hero. No card grids anywhere.`,
  },
  {
    key: 'onescreen',
    name: 'One screen',
    blurb: 'Everything above the fold. Almost nothing to scroll.',
    brief: `Fit the ENTIRE business onto roughly one screen. Name, what they do, the three things that matter, the phone number as a large tappable target, hours, and address — arranged as a single composed layout, not stacked sections. Below the fold there is at most a short contact form and the footer, nothing else. Ruthlessly cut: no FAQ, no testimonials carousel, no long services list. This suits a business with three things to say and no patience for a brochure.`,
  },
  {
    key: 'menu',
    name: 'Price list',
    blurb: 'Services and prices are the whole page.',
    brief: `Make the service-and-price list the centrepiece and the largest thing on the page. Present it as a real menu — an aligned list with leader dots or a clean two-column rule between service and price, typeset properly, not as a grid of cards. A compact header with the name and phone sits above it; hours and location sit below it. Keep everything else minimal. If no prices were provided, list the services in the same menu form with "Call for a quote" where prices would be. No hero image larger than a narrow banner.`,
  },
  {
    key: 'story',
    name: 'Long-form',
    blurb: 'One column, real writing, no cards at all.',
    brief: `Write it as one continuous single-column page with a comfortable reading measure, like a well-set article. Real prose paragraphs with proper typography — no card grids, no icon rows, no three-across feature blocks anywhere on the page. Section breaks are typographic: a rule, a change in type size, generous white space. The story runs only on what you were given: what they do and where, what it is like to call them, what customers say in their own words, then how to reach them. No invented history, founders or milestones. Pull-quotes for the real reviews.`,
  },
  {
    key: 'booking',
    name: 'Booking-first',
    blurb: 'The form is the hero. Everything else supports it.',
    brief: `The contact/quote form IS the hero — put it in the first screen, right-hand side on desktop, directly under a one-line headline on mobile. It should be the largest and most visually dominant element on the page. Everything below exists only to justify filling it in: a short band of the facts you were actually given (the rating if one was supplied, the town, the hours), a compact list of services, the real reviews if there are any. Repeat a smaller version of the form once more at the bottom. No FAQ accordion, no large photo galleries competing with the form.`,
  },
  {
    key: 'beforeafter',
    name: 'Before & after',
    photos: true,
    blurb: 'Transformation pairs carry the page.',
    brief: `Lead with transformation. The hero is a before/after pair — either side by side, or one image with a draggable divider that actually works. Follow with two or three more before/after pairs, each with a one-line caption saying what was done. Then a short process section — three steps, numbered, because the order genuinely matters here — then reviews, then contact. Omit a generic services grid; the pairs already show the services.`,
  },
  {
    key: 'proof',
    name: 'Reviews-led',
    reviews: true,
    blurb: 'The rating and the reviews come first, not last.',
    brief: `Put the social proof at the very top instead of buried near the footer. Open with the star rating and review count set large and typographically, with two or three short review quotes immediately beneath — before any description of what the business does. Then what they do, kept brief. Then the phone and contact. This inverts the usual order on purpose: the visitor learns the business is trusted before they learn what it sells. No hero photograph competing with the rating.`,
  },
  {
    key: 'magazine',
    name: 'Editorial grid',
    blurb: 'Asymmetric magazine layout, nothing centred.',
    brief: `Lay the page out on an asymmetric editorial grid — uneven column widths, deliberate overlaps, content that starts off-centre and stays there. Nothing is centre-aligned. A large display headline breaks across the grid at the top. Blocks are different sizes on purpose: a wide block of colour or an oversized numeral beside a narrow text column, a small caption block hanging in white space, a full-width band that interrupts. It should read like a spread, not a page of stacked sections.`,
  },
  {
    key: 'findus',
    name: 'Find us',
    blurb: 'Hours, address and map dominate. For walk-ins.',
    brief: `Build it for someone standing outside trying to work out if the place is open. Hours, address, phone and the map are the largest and highest things on the page — hours set big and legible, today's row emphasised. The map is full-width and substantial, not a small box near the footer. What they do is a short list underneath. Reviews are one compact line. Everything else is cut. This suits a business people physically visit rather than call for a quote.`,
  },
  {
    key: 'poster',
    name: 'Poster',
    blurb: 'Type-driven. Almost no sections.',
    brief: `Treat the first screen as a poster: enormous display typography carrying the business name and what they do, minimal or no photography, one striking colour relationship. The type IS the design. Below the poster, only three things — a short service list, the phone as a large element, and a contact form. Four sections total on the entire page including the footer. Nothing else. Silence is part of the design; do not fill it.`,
  },
  {
    key: 'classic',
    name: 'Classic service page',
    blurb: 'The familiar one. Still right for some trades.',
    brief: `A well-executed conventional service page: an opening screen with a clear call to action, services, the real reviews if any were given, hours and where to find them, then contact. No "why choose us" band and no FAQ — both would have to be made up. Keep it tight and confident rather than long — this layout earns its place by being fast and familiar, not by having the most sections. Do not pad it out.`,
  },
];

const LAYOUT_KEY = 'forge.layoutCursor';

// Whether a concept or layout can be built honestly for this business. Photo-led
// ones need the owner's own pictures (ticked in "Their details"); a reviews-led
// page needs real reviews and a rating worth leading with.
function fitsLead(item, lead) {
  if (item.photos && !leadExtras(lead?.placeId).photos) return false;
  if (item.reviews && !(goodReviews(lead).length >= 2 && Number(lead?.rating) >= 4.5)) return false;
  return true;
}

// Hand out a different archetype every time, skipping any this business cannot
// fill. The cursor persists, so the first site of a new session doesn't repeat
// the last site of the previous one.
function nextLayout(lead = null) {
  let i = 0;
  try { i = parseInt(localStorage.getItem(LAYOUT_KEY) || '0', 10) || 0; } catch { /* ignore */ }
  let layout = LAYOUTS[i % LAYOUTS.length];
  for (let step = 0; step < LAYOUTS.length; step++) {
    layout = LAYOUTS[(i + step) % LAYOUTS.length];
    if (fitsLead(layout, lead)) { i += step; break; }
  }
  try { localStorage.setItem(LAYOUT_KEY, String((i + 1) % LAYOUTS.length)); } catch { /* ignore */ }
  return layout;
}

function layoutInstruction(layout) {
  return `Page structure — "${layout.name}": ${layout.brief}

Follow this structure over any default arrangement of sections. Sections not called for here should be left out rather than added back in — a shorter page that commits to a shape beats a longer one that hedges.`;
}

// ---- Extra facts Places cannot supply ---------------------------------------
// Brand colours, the owner's first name and anything distinctive are the three
// inputs that move a site furthest from the average, and none of them are in a
// Places response. They are typed in once per business and kept locally, keyed
// by place ID, so a demo regenerated later keeps them.
const EXTRAS_KEY = 'forge.leadExtras';

function readExtras() {
  try {
    const v = JSON.parse(localStorage.getItem(EXTRAS_KEY) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function leadExtras(placeId) {
  const all = readExtras();
  const e = all[placeId] || {};
  return {
    colors: e.colors || '',
    owner: e.owner || '',
    distinctive: e.distinctive || '',
    services: e.services || '',
    towns: e.towns || '',
    photos: Boolean(e.photos),
  };
}

function saveLeadExtras(placeId, extras) {
  try {
    const all = readExtras();
    all[placeId] = extras;
    localStorage.setItem(EXTRAS_KEY, JSON.stringify(all));
  } catch {
    // Storage blocked — the extras just won't survive a reload.
  }
}

function hasExtras(placeId) {
  const e = leadExtras(placeId);
  return Boolean(e.colors || e.owner || e.distinctive || e.services || e.towns || e.photos);
}

// ---- Concept + layout, bound to one lead ------------------------------------
// Memoised together against the place ID: the card shows the direction before
// you click, so the page you get has to be the page you were promised.
const leadDirections = new Map();
function directionForLead(lead, niche) {
  if (!leadDirections.has(lead.placeId)) {
    const taken = Array.from(leadDirections.values()).map((d) => d.concept.key);
    leadDirections.set(lead.placeId, {
      concept: pickConcept(niche, lead, taken),
      layout: nextLayout(lead),   // the cursor rotates, so layouts never repeat inside a run
    });
  }
  return leadDirections.get(lead.placeId);
}

// The model picks the display font, not Forge, so the only way to stop the same
// one appearing ten times is to read back what it chose and rule it out next
// time. Parsed from the FORGE-CONCEPT comment the rules require.
function parseConcept(html) {
  const m = String(html || '').match(/<!--\s*FORGE-CONCEPT([\s\S]*?)-->/i);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^\s*([a-z-]+)\s*:\s*(.+?)\s*$/i);
    if (kv) out[kv[1].toLowerCase()] = kv[2];
  }
  return Object.keys(out).length ? out : null;
}

function recentFonts() {
  return Array.from(new Set(readRecent().map((p) => p.font).filter(Boolean)));
}

// ---- The facts block (spec Section 3) ---------------------------------------
// Everything true that Forge knows about this business, labelled, with nothing
// implied and nothing padded. Where a fact is missing the block says so and
// says what to do about it, because a model left to notice an absence fills it.

// Reviews fit to put on the business's own website: four stars or better.
// Google returns whichever reviews it finds most relevant, and that can include
// a one-star complaint.
function goodReviews(lead) {
  return (Array.isArray(lead?.reviews) ? lead.reviews : [])
    .filter((r) => r && r.text && r.author && (r.rating === null || r.rating === undefined || r.rating >= 4));
}

// Trades that go to the customer. Everyone else is somewhere people come to,
// and "also serving Grafton" on a barbershop's site is nonsense.
const TRAVELLING_TRADE = /plumb|electric|hvac|heating|cooling|air condition|furnace|boiler|roof|gutter|siding|landscap|lawn|tree|snow|paint|clean|maid|janitor|pressure wash|pest|contractor|remodel|carpent|builder|handyman|mason|concrete|paving|fence|deck|floor|tile|lock|tow|moving|mover|septic|drain|restoration|appliance|garage door|window|insulation|chimney|pool|irrigation|excavat|drywall|glass|junk|haul|mobile|inspect/i;

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildLeadPrompt(lead, niche) {
  const area = serviceAreaFor(lead.address);
  const extra = leadExtras(lead.placeId);
  const L = [];

  L.push(`Build the website for ${lead.name}, ${article(niche)} ${niche}${area.town ? ` in ${area.town}` : ''}.`);
  L.push('');
  L.push('BUSINESS FACTS — use only these, invent nothing:');
  L.push(`- Name, exactly as it appears on their sign: ${lead.name}`);
  // A custom niche is free text, so it is matched as text, not as a pattern.
  const sameAsCategory = lead.category && new RegExp(escapeRegExp(niche), 'i').test(lead.category);
  L.push(`- Trade: ${niche}${lead.category && !sameAsCategory ? ` (Google lists them as ${lead.category})` : ''}`);

  if (extra.services) {
    L.push(`- Services, in their words: ${extra.services}`);
  } else {
    L.push(`- Services: not confirmed with the owner. List only the plain, core jobs every ${niche} does — six at most, in everyday words. No specialties, brands, certifications or prices. Put <!-- CONFIRM: services --> directly above the list.`);
  }

  if (lead.address) L.push(`- Address: ${lead.address}`);
  else L.push('- Address: not known. Show no address and no map.');

  if (area.town) {
    if (extra.towns) {
      L.push(`- Town: ${area.town}. Towns they serve, confirmed: ${extra.towns}. Name these on the page.`);
    } else if (TRAVELLING_TRADE.test(niche)) {
      L.push(area.nearby.length
        ? `- Town: ${area.town}. Their service area is not confirmed. You may say "${area.town} and nearby towns" and, once, in small type, name these neighbours as nearby: ${area.nearby.join(', ')}. Do not call it a guaranteed service area. Put <!-- CONFIRM: service area --> beside it.`
        : `- Town: ${area.town}. Their service area is not confirmed — say "${area.town} and nearby towns" and name no other town.`);
    } else {
      L.push(`- Town: ${area.town}. Customers come to them, so name ${area.town} only. Do not list other towns or a service area.`);
    }
  }

  if (lead.phone) L.push(`- Phone: ${lead.phone}`);
  else L.push('- Phone: not known. Show no phone number and no call buttons; the contact form is the one call to action.');

  if (Array.isArray(lead.hours) && lead.hours.length) {
    L.push(`- Hours, word for word from their Google listing:\n    ${lead.hours.join('\n    ')}`);
  } else {
    L.push('- Hours: not known. Leave hours out entirely rather than guessing at them.');
  }

  const rating = Number(lead.rating) || 0;
  if (rating >= 4.5 && lead.reviewCount) {
    L.push(`- Rating: ${lead.rating} stars from ${lead.reviewCount} Google reviews. Both numbers are real; show them exactly.`);
  } else if (rating >= 4 && lead.reviewCount) {
    L.push(`- Rating: ${lead.rating} stars from ${lead.reviewCount} Google reviews. Both numbers are real. You may show them once, small; do not build the page around them.`);
  } else {
    L.push('- Rating: do not show a star rating or a review count anywhere on the page.');
  }

  const reviews = goodReviews(lead);
  if (reviews.length) {
    L.push('- Real Google reviews. Quote these word for word, in the language they were written in, with the first name shown. Do not edit, shorten, polish, translate or add to them, and quote no one else:');
    for (const r of reviews) {
      L.push(`    "${r.text}" — ${r.author}${r.rating ? `, ${r.rating} stars` : ''}`);
    }
    L.push('- What these reviews keep praising is the strongest thing you have. Read them and lead the page with it.');
  } else {
    L.push('- Reviews: none to use. Write no testimonials and no customer quotes. Leave <!-- PLACEHOLDER: add real reviews --> where they would go and show nothing.');
  }

  if (extra.colors) L.push(`- Their real brand colours, from their sign, truck or storefront: ${extra.colors}. Build the palette from these.`);
  else L.push('- Brand colours: unknown. Choose a palette from the trade and the concept, and avoid purple, violet and indigo entirely.');
  if (extra.owner) L.push(`- Owner's first name: ${extra.owner}. You may address the visitor in his voice, e.g. "Call ${extra.owner} directly".`);
  else L.push('- Owner: not known. Name no owner, founder or staff member.');
  if (extra.distinctive) L.push(`- Distinctive, and worth building the concept around: ${extra.distinctive}`);

  if (extra.photos) {
    L.push('- Photos: the owner\'s own photographs will be dropped in after you finish. Wherever the structure calls for a photograph, output an <img> with a descriptive alt, width and height attributes, and its src set to a plain inline SVG placeholder (a data: URI in a neutral tone from your palette, with the alt text lettered small in the middle). Use no stock photography at all.');
  } else {
    L.push('- Photos: none, and none are coming. Design without photographs: type, colour, shape and inline SVG drawing carry this page. Use no stock photography and no <img> elements.');
  }
  L.push('- Not stated above means not known: years in business, licences, insurance, certifications, awards, guarantees, prices, free estimates, emergency or 24-hour service, team size. Claim none of them.');

  return L.join('\n');
}

// What actually gets sent: the facts, then the design direction. Split from the
// facts so the lead card can show the readable half.
function fullLeadPrompt(lead, niche) {
  const d = directionForLead(lead, niche);
  return [
    buildLeadPrompt(lead, niche),
    '',
    conceptInstruction(d.concept),
    '',
    layoutInstruction(d.layout),
  ].join('\n');
}

function conceptInstruction(concept) {
  return `DESIGN CONCEPT — start from "${concept.name}": ${concept.brief}

This is a direction, not a template. Bend it with this business's own facts until it could not be used for anyone else, and write it up in the FORGE-CONCEPT comment. If the concept fights the facts you were given — it calls for photographs you do not have, or before-and-after pairs that were not supplied — pick a different direction and say so in the comment rather than faking the content it needs.${avoidFontsLine()}`;
}

// Section 11: nothing repeats inside a window of the last ten.
function avoidFontsLine() {
  const fonts = recentFonts();
  if (!fonts.length) return '';
  return `\n\nAlready used on recent sites, so pick a different display font: ${fonts.join(', ')}.`;
}

// `compact` renders a scannable summary card for the results grid — tapping it
// opens the same card in full, with the prompt and the Generate button. Keeping
// the whole prompt on every card made the grid enormous and hard to skim.
function leadCardHtml(lead, niche, status = 'undecided', { compact = false } = {}) {
  const prompt = buildLeadPrompt(lead, niche);
  const dir = directionForLead(lead, niche);
  const layout = dir.layout;
  const rating = lead.rating
    ? `<div class="rating">★ ${escapeHtml(lead.rating)} · ${escapeHtml(lead.reviewCount)} reviews</div>`
    : '<div class="rating muted">No reviews yet</div>';
  const badge = lead.website
    ? `<span class="badge badge-undecided">Has website</span>`
    : `<span class="badge">No website found</span>`;

  const decide = status === 'client'
    ? `<p class="decide-note">✓ Already a client — manage them from the Clients tab.</p>`
    : `<div class="lead-decide ${status !== 'undecided' ? 'has-choice' : ''}">
         <button class="decide-btn decide-yes ${status === 'yes' ? 'is-selected' : ''}" data-act="yes">Yes</button>
         <button class="decide-btn decide-no ${status === 'no' ? 'is-selected' : ''}" data-act="no">No</button>
       </div>`;

  return `
    <div class="lead-head">
      <div class="lead-name-group">
        <label class="lead-select"><input type="checkbox" class="lead-select-cb" data-place-id="${escapeHtml(lead.placeId)}" aria-label="Select ${escapeHtml(lead.name)} for bulk demo generation"></label>
        <h3>${escapeHtml(lead.name)}</h3>
      </div>
      ${badge}
    </div>
    <div class="lead-meta">
      ${lead.category ? `<div>${escapeHtml(lead.category)}</div>` : ''}
      ${lead.address ? `<div>${escapeHtml(lead.address)}</div>` : ''}
      ${lead.phone ? `<div>${escapeHtml(lead.phone)}</div>` : ''}
      ${rating}
    </div>
    ${compact
      ? `<div class="lead-open-hint"><span class="ll-tag">${escapeHtml(dir.concept.name)}</span><span class="ll-tag ll-dim">${escapeHtml(layout.name)}</span><span class="chev">›</span></div>`
      : `<div class="lead-prompt">
      <h4>What the site will be built from</h4>
      <pre class="lead-facts">${escapeHtml(prompt)}</pre>
      <p class="lead-layout"><span class="ll-tag">Concept</span> <strong>${escapeHtml(dir.concept.name)}</strong> — ${escapeHtml(dir.concept.brief)}</p>
      <p class="lead-layout"><span class="ll-tag">Layout</span> <strong>${escapeHtml(layout.name)}</strong> — ${escapeHtml(layout.blurb)}</p>
    </div>
    <div class="lead-generate">
      <button class="btn btn-primary" data-act="generate">Generate site</button>
      <button class="btn ${hasExtras(lead.placeId) ? 'has-extras' : ''}" data-act="extras">${hasExtras(lead.placeId) ? '✓ Their details' : '+ Their details'}</button>
    </div>`}
    ${decide}`;
}

// Wire up a rendered card's buttons. onDecided(newStatus) lets the caller
// decide what happens after (search results remove the card; History
// re-renders in place so the choice stays visible and changeable).
function wireLeadCard(cardEl, lead, niche, onDecided) {
  const genBtn = cardEl.querySelector('[data-act="generate"]');
  if (genBtn) {
    genBtn.addEventListener('click', () => {
      const prompt = fullLeadPrompt(lead, niche);
      $('#build-prompt').value = prompt;
      $('#build-prompt').dispatchEvent(new Event('input'));
      switchTab('build');
      generateSingle(prompt, lead.placeId, directionForLead(lead, niche));
    });
  }

  const extrasBtn = cardEl.querySelector('[data-act="extras"]');
  if (extrasBtn) {
    extrasBtn.addEventListener('click', () => openLeadExtras(lead, niche, cardEl));
  }

  const yesBtn = cardEl.querySelector('[data-act="yes"]');
  const noBtn = cardEl.querySelector('[data-act="no"]');

  if (yesBtn) {
    yesBtn.addEventListener('click', () => {
      openClientModal({
        mode: 'lead',
        lead,
        onSaved: () => onDecided('client'),
      });
    });
  }

  if (noBtn) {
    noBtn.addEventListener('click', async () => {
      const alreadyNo = noBtn.classList.contains('is-selected');
      try {
        const decision = alreadyNo ? 'undecided' : 'no';
        await api('/api/leads/decision', {
          method: 'POST',
          body: { placeId: lead.placeId, decision },
        });
        noBtn.classList.toggle('is-selected', !alreadyNo);
        toast(alreadyNo ? 'Decision cleared — back to undecided' : 'Dismissed — it won\'t show up in searches again');
        onDecided(decision);
      } catch (err) {
        toast(err.message, true);
      }
    });
  }
}

// Full view of a lead from the results grid: the whole auto-generated prompt
// plus Generate and the Yes/No decision. Decisions taken here are mirrored back
// onto the card behind the modal so the two never disagree.
function openLeadDetail(lead, niche, sourceCard) {
  const holder = $('#detail-card');
  const render = (status) => {
    holder.innerHTML = `<article class="lead-card">${leadCardHtml(lead, niche, status)}</article>`;
    wireSelectCheckbox(holder, lead, niche);
    wireLeadCard(holder.firstElementChild, lead, niche, (newStatus) => {
      $('#detail-modal').hidden = true;
      if ((newStatus === 'client' || newStatus === 'no') && sourceCard) {
        basketRemove(lead.placeId);
        sourceCard.classList.add('is-leaving');
        setTimeout(() => {
          sourceCard.remove();
          if (!$('#lead-results').children.length) $('#lead-empty').hidden = false;
        }, 350);
      }
    });
  };
  render('undecided');
  $('#detail-modal').hidden = false;
}

function renderLeadResults(leads, niche) {
  const grid = $('#lead-results');
  grid.innerHTML = '';
  for (const lead of leads) {
    const card = document.createElement('article');
    card.className = 'lead-card is-compact';
    card.innerHTML = leadCardHtml(lead, niche, 'undecided', { compact: true });

    // Tapping the card body opens the full view. The checkbox and the Yes/No
    // buttons keep working in place, so triage doesn't need a detour.
    card.addEventListener('click', (e) => {
      if (e.target.closest('.lead-select, .lead-decide, button, input, label')) return;
      openLeadDetail(lead, niche, card);
    });

    wireLeadCard(card, lead, niche, (newStatus) => {
      if (newStatus === 'client' || newStatus === 'no') {
        // Decided → drops out of the active results and out of the basket.
        basketRemove(lead.placeId);
        card.classList.add('is-leaving');
        setTimeout(() => {
          card.remove();
          if (!grid.children.length) $('#lead-empty').hidden = false;
        }, 350);
      }
    });
    // Already in the basket from an earlier search? It renders pre-ticked.
    wireSelectCheckbox(card, lead, niche);
    grid.appendChild(card);
  }
  staggerIn(grid);
  updateBatchBar();
}

$('#lead-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const zip = $('#lead-zip').value.trim();
  const niche = resolveNiche();
  const minRating = $('#lead-min-rating').value;
  const minReviews = $('#lead-min-reviews').value;
  const errEl = $('#lead-error');
  errEl.hidden = true;
  $('#lead-empty').hidden = true;
  $('#lead-stats').hidden = true;
  $('#lead-results').innerHTML = '';
  leadState.leads = [];
  updateBatchBar();   // note: the basket is left alone — picks carry over

  if (!zip) { errEl.textContent = 'Enter a ZIP code or address.'; errEl.hidden = false; return; }
  if (!niche) { errEl.textContent = 'Pick a niche (or type a custom one).'; errEl.hidden = false; return; }

  $('#lead-loading').hidden = false;
  $('#lead-search-btn').disabled = true;
  try {
    const res = await api('/api/leads/search', {
      method: 'POST',
      body: {
        zip, niche,
        minRating: minRating || undefined,
        minReviews: minReviews || undefined,
        day: localToday(), // so "today" resets at your midnight, not UTC's
      },
    });
    leadState.niche = niche;
    leadState.leads = res.leads;
    renderLeadUsage(res.usage);

    const s = res.stats;
    const filterNote = s.belowThreshold ? ` · ${s.belowThreshold} below your rating/review filter` : '';
    $('#lead-stats').textContent =
      `${s.total} businesses found · ${s.withWebsite} already have a website · ${s.dismissed} previously decided${filterNote} · ${res.leads.length} new lead${res.leads.length === 1 ? '' : 's'}`;
    $('#lead-stats').hidden = false;

    if (!res.leads.length) {
      $('#lead-empty').hidden = false;
      updateBatchBar();
    } else {
      renderLeadResults(res.leads, niche);
    }
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  } finally {
    $('#lead-loading').hidden = true;
    $('#lead-search-btn').disabled = false;
  }
});

// ---- "Their details" modal --------------------------------------------------
// Collects the three Section 3 inputs a Places response can never carry. Saved
// per place ID, so the card, the prompt and a regeneration all agree.
let extrasTarget = null;

function openLeadExtras(lead, niche, cardEl) {
  extrasTarget = { lead, niche, cardEl };
  const e = leadExtras(lead.placeId);
  $('#extras-modal-sub').textContent =
    `Anything you know about ${lead.name} that Google doesn't. Every field is optional, and anything left blank is left off the site rather than guessed at.`;
  $('#extras-colors').value = e.colors;
  $('#extras-owner').value = e.owner;
  $('#extras-services').value = e.services;
  $('#extras-distinctive').value = e.distinctive;
  $('#extras-towns').value = e.towns;
  $('#extras-photos').checked = e.photos;
  $('#extras-modal').hidden = false;
  $('#extras-colors').focus();
}

function closeLeadExtras() {
  $('#extras-modal').hidden = true;
  extrasTarget = null;
}

$('#extras-cancel').addEventListener('click', closeLeadExtras);
$('#extras-modal').addEventListener('click', (e) => {
  if (e.target === $('#extras-modal')) closeLeadExtras();
});

$('#extras-save').addEventListener('click', () => {
  if (!extrasTarget) return closeLeadExtras();
  const { lead, niche, cardEl } = extrasTarget;
  saveLeadExtras(lead.placeId, {
    colors: $('#extras-colors').value.trim(),
    owner: $('#extras-owner').value.trim(),
    services: $('#extras-services').value.trim(),
    distinctive: $('#extras-distinctive').value.trim(),
    towns: $('#extras-towns').value.trim(),
    photos: $('#extras-photos').checked,
  });
  closeLeadExtras();
  // What the business can supply decides which directions are open to it, so
  // the one chosen before is dropped and picked again.
  leadDirections.delete(lead.placeId);

  // Their details change the facts block, so the card has to be rebuilt or it
  // would still be advertising the old prompt.
  if (cardEl) {
    const compact = cardEl.classList.contains('is-compact');
    cardEl.innerHTML = leadCardHtml(lead, niche, 'undecided', { compact });
    wireSelectCheckbox(cardEl, lead, niche);
    wireLeadCard(cardEl, lead, niche, () => {});
  }
  toast('Saved — the site will be built from these');
});

// ---- Pre-send check (spec Section 15) ----------------------------------------
// Free: a search over HTML Forge already has, set against the facts the page
// was built from. It never regenerates on its own, because that would spend a
// credit without being asked — it reports, and fixing is your call.
//
// Three kinds of finding:
//   fix      wrong on its face (an invented quote, a wrong phone number, a
//            banned font) and can be repaired with one refine
//   confirm  might be true, but nothing Forge was told says so — ask the owner
//   note     nothing wrong, just not finished (the form is still a preview)
const BANNED_FONTS = [
  'Inter', 'Roboto', 'Open Sans', 'Lato', 'Poppins', 'Montserrat', 'Raleway',
  'Nunito', 'Space Grotesk', 'Plus Jakarta Sans', 'Manrope', 'DM Sans',
  'Outfit', 'Sora', 'Playfair Display', 'Oswald', 'Bebas Neue',
];
const BANNED_PHRASES = [
  'elevate', 'empower', 'unlock', 'seamless', 'cutting-edge', 'state-of-the-art',
  'innovative solutions', 'one-stop shop', 'trusted partner', 'pride ourselves',
  'we take pride', 'top-notch', 'second to none', 'excellence', 'look no further',
  'quality you can trust', 'satisfaction is our priority', 'transforming', 'journey',
  'tailored solutions', 'peace of mind', "we've got you covered",
  'why choose us', 'what our customers say', 'Get Started', 'Learn More',
];
// Claims an owner has to stand behind. Each is fine when the facts say it.
const CLAIMS = [
  ['licensed', /\blicen[cs]ed\b/i],
  ['insured', /\binsured\b/i],
  ['bonded', /\bbonded\b/i],
  ['certified', /\bcertifi(?:ed|cation)/i],
  ['family-owned', /\bfamily[- ](?:owned|run|operated)\b/i],
  ['locally owned', /\blocally[- ]owned\b/i],
  ['"since" a year', /\b(?:since|est\.?|established)\s+(?:in\s+)?(?:19|20)\d{2}\b/i],
  ['years in business', /\b\d{1,3}\+?\s*(?:years|yrs)\b/i],
  ['free estimates', /\bfree\s+(?:estimates?|quotes?|consultations?|inspections?)\b/i],
  ['24-hour or emergency service', /\b24\s*\/\s*7\b|\b24[- ]hours?\b|\baround the clock\b|\bemergency\b/i],
  ['a guarantee or warranty', /\bguarantee[ds]?\b|\bwarrant(?:y|ies)\b/i],
  ['an award or "best"', /\baward[- ]winning\b|\bbest of\b|#\s?1\b|\bnumber one\b/i],
  ['"trusted"', /\btrusted\b/i],
];

function looseText(text) {
  return String(text || '').toLowerCase()
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, '...')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

// The part of a prompt that states facts, with Forge's own instructions taken
// out. Those instructions name the very things the check looks for ("claim no
// free estimates"), and would otherwise read as the facts vouching for them.
function factsOnly(prompt) {
  let text = String(prompt || '');
  for (const cut of ['DESIGN CONCEPT —', 'Page structure —', 'How to read them:']) {
    const at = text.indexOf(cut);
    if (at !== -1) text = text.slice(0, at);
  }
  return text.split('\n').filter((line) =>
    !/^- (?:Not stated above|Services: not confirmed|Photos:|Rating: do not|Reviews: none|Hours: not known|Brand colours: unknown|Owner: not known|Phone: not known|Address: not known)/.test(line.trim())
    && !/Their service area is not confirmed|Customers come to them/.test(line)
  ).join('\n');
}

function checkSite(html, prompt = '') {
  const doc = String(html || '');
  const fix = [];
  const confirm = [];
  const note = [];
  const hasFacts = Boolean(String(prompt || '').trim());
  const facts = factsOnly(prompt);
  const factsLoose = looseText(facts);

  const visible = doc
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;|&rsquo;|&lsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"').replace(/&mdash;/g, '—').replace(/\s+/g, ' ');

  // -- typefaces: only where one is actually applied, not where the word
  // happens to appear in copy.
  const fontContexts = (doc.match(/font-family\s*:[^;}]+/gi) || []).join(' ')
    + ' ' + (doc.match(/fonts\.googleapis\.com[^"')\s]*/gi) || []).join(' ');
  const fonts = BANNED_FONTS.filter((f) => new RegExp(`(?:^|[^a-z])${f.replace(/\s+/g, '[\\s+]')}(?:[^a-z]|$)`, 'i').test(fontContexts));
  if (fonts.length) {
    fix.push({
      text: `banned font: ${fonts.join(', ')}`,
      ask: `Replace ${fonts.join(' and ')} — banned. Swap the Google Fonts link and the font-family for a face that suits this page's existing concept.`,
    });
  }

  // -- colour and effects
  const effects = [];
  if (/linear-gradient\([^)]*(#?(8b5cf6|a855f7|6366f1|7c3aed|818cf8|c084fc)|purple|violet|indigo)/i.test(doc)) effects.push('purple or indigo gradient');
  if (/-webkit-background-clip\s*:\s*text/i.test(doc) && /linear-gradient/i.test(doc)) effects.push('gradient text');
  if (/backdrop-filter\s*:\s*blur/i.test(doc)) effects.push('frosted-glass blur');
  if (effects.length) {
    fix.push({ text: effects.join(', '), ask: `Remove: ${effects.join(', ')}. Use flat, confident colour from the page's existing palette instead.` });
  }

  // -- emoji standing in for icons. ©, ® and ™ are ordinary text.
  const emoji = Array.from(new Set(visible.match(/\p{Extended_Pictographic}/gu) || [])).filter((c) => !'©®™'.includes(c));
  if (emoji.length) {
    fix.push({
      text: `emoji used as icons: ${emoji.slice(0, 8).join(' ')}`,
      ask: 'Remove every emoji. Where one was doing the job of an icon, draw a small inline SVG in the page\'s own line weight and colour, or use plain type.',
    });
  }

  // -- numbers that count up from zero
  if (/data-(?:count|target|to|countup|num)\s*=\s*["']?\d/i.test(doc)) {
    fix.push({
      text: 'numbers that count up from zero',
      ask: 'Remove the count-up animation: write each number into the HTML at its real value and delete the script and data attributes that animate it.',
    });
  }

  // -- images loaded from somewhere else (stock photos)
  const remote = new Set([
    ...(doc.match(/<img\b[^>]*\bsrc\s*=\s*["']https?:\/\/[^"']+/gi) || []),
    ...(doc.match(/url\(\s*["']?https?:\/\/(?!fonts\.(?:googleapis|gstatic)\.com)[^"')\s]+/gi) || []),
  ]);
  if (remote.size) {
    fix.push({
      text: `${remote.size} stock photo${remote.size === 1 ? '' : 's'} loaded from another site`,
      ask: 'Remove every photograph loaded from another website, including background images. Redraw those areas with colour, type and inline SVG from the page\'s own palette so the layout still holds.',
    });
  }
  const slots = (doc.match(/<img\b[^>]*\bsrc\s*=\s*["']data:image\/svg/gi) || []).length;
  if (slots) note.push({ text: `${slots} photo slot${slots === 1 ? '' : 's'} still empty — add their pictures with Photos` });

  // -- customer quotes that are not in the facts
  if (hasFacts) {
    const quotes = new Set();
    for (const m of visible.matchAll(/[“"]\s*([^“”"]{40,500}?)\s*[”"]/g)) quotes.add(m[1]);
    for (const m of doc.matchAll(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi)) {
      const t = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (t.length >= 40) quotes.add(t.replace(/^[“"]|[”"]$/g, ''));
    }
    const made = Array.from(quotes).filter((q) => !factsLoose.includes(looseText(q)));
    if (made.length) {
      fix.push({
        text: `${made.length} quote${made.length === 1 ? '' : 's'} not in the facts: “${made[0].slice(0, 60)}…”`,
        ask: `Delete ${made.length === 1 ? 'this quote' : 'these quotes'} and the name attached, because ${made.length === 1 ? 'it was' : 'they were'} never said by a customer: ${made.map((q) => `"${q.slice(0, 80)}"`).join('; ')}. Do not write replacements.`,
      });
    }
  }

  // -- phone numbers
  const digits = (t) => String(t).replace(/\D/g, '').slice(-10);
  const telLinks = Array.from(new Set((doc.match(/href\s*=\s*["']tel:[^"']+/gi) || []).map((t) => digits(t.replace(/^[^:]*:/, ''))))).filter((d) => d.length === 10);
  if (hasFacts) {
    const known = new Set((facts.match(/\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/g) || []).map(digits));
    const wrong = telLinks.filter((d) => !known.has(d));
    if (wrong.length) {
      fix.push({
        text: `a phone number that is not theirs: ${wrong.map((d) => `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`).join(', ')}`,
        ask: known.size
          ? `Every phone number and tel: link must be ${Array.from(known).map((d) => `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`).join(' or ')}. Replace any other number.`
          : 'No phone number is known for this business. Remove every phone number and tel: link; the contact form is the call to action.',
      });
    }
    if (known.size && !telLinks.length) {
      fix.push({ text: 'their phone number is not a tap-to-call link', ask: 'Make every appearance of the phone number a tel: link, and put one in the header and the opening screen.' });
    }
  }

  // -- structure
  const h1 = (doc.match(/<h1[\s>]/gi) || []).length;
  if (h1 !== 1) fix.push({ text: h1 === 0 ? 'no main heading' : `${h1} main headings`, ask: 'The page must have exactly one h1. Demote or merge the others without changing how anything looks.' });
  if (!/<form[\s>]/i.test(doc)) fix.push({ text: 'no contact form', ask: 'Add a contact form with fields named name, phone, email and message (a textarea) and a submit button, styled to match the page, with no action attribute.' });
  if (!/<\/html>\s*$/i.test(doc.trim())) fix.push({ text: 'the page looks cut off', ask: null });

  // -- wording
  const phrases = BANNED_PHRASES.filter((ph) => new RegExp(`\\b${ph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(visible));
  if (phrases.length) {
    fix.push({
      text: `stock phrases: ${phrases.slice(0, 5).join(', ')}`,
      ask: `Rewrite only the sentences or labels containing these, keeping the meaning in the owner's plain voice: ${phrases.join(', ')}. Add no new claims.`,
    });
  }

  // -- claims nothing in the facts supports
  const unbacked = CLAIMS.filter(([, re]) => re.test(visible) && !re.test(facts)).map(([label]) => label);
  if (unbacked.length) confirm.push({ text: `says ${unbacked.join(', ')}` });
  for (const m of doc.matchAll(/<!--\s*CONFIRM:\s*([^>]*?)\s*-->/gi)) {
    confirm.push({ text: `${m[1].slice(0, 60)}` });
  }
  const seen = new Set();
  const confirmUnique = confirm.filter((c) => (seen.has(c.text) ? false : seen.add(c.text)));

  // -- not finished yet
  if (/<!--forge-forms-start--><script>\(function\(\)\{var TO="",/.test(doc)) {
    note.push({ text: 'contact form is in preview mode — set their email before this goes live' });
  }

  return { fix, confirm: confirmUnique, note, total: fix.length + confirmUnique.length };
}

// Kept for the callers that only want to know whether anything is wrong.
function scanForSlop(html, prompt = '') {
  return checkSite(html, prompt);
}

function reportSlop(html, where, prompt = '') {
  const r = checkSite(html, prompt);
  const box = $(where);
  if (!box) return r;
  if (!r.total && !r.note.length) {
    box.hidden = true;
    return r;
  }
  const line = (label, items) => (items.length
    ? `<div class="check-line"><strong>${label}</strong> ${items.map((i) => escapeHtml(i.text)).join(' · ')}</div>`
    : '');
  box.innerHTML =
    line(`${r.fix.length} to fix:`, r.fix)
    + line('Ask the owner:', r.confirm)
    + line('Before it goes live:', r.note)
    + (r.fix.some((f) => f.ask) ? '<button type="button" class="btn btn-sm" data-act="fix-slop">Fix these with one edit (1 credit)</button>' : '');
  box.classList.toggle('is-clean', !r.fix.length);
  box.hidden = false;
  return r;
}

// ---- Bulk selection + batch demo generation ----

function updateBatchBar() {
  const bar = $('#lead-batch-bar');
  const total = leadState.leads.length;
  const n = leadState.selected.size;
  // The bar stays up with an empty results grid whenever the basket has
  // something in it — otherwise picks made before a fruitless search would
  // look like they'd vanished.
  if (!total && !n) { bar.hidden = true; return; }
  bar.hidden = false;

  const countBtn = $('#lead-selected-count');
  countBtn.textContent = `${n} selected`;
  countBtn.disabled = n === 0;
  $('#lead-batch-generate').disabled = n === 0;

  const allCb = $('#lead-select-all-cb');
  // "Select all" only ever speaks for what's on screen right now.
  const here = leadState.leads.filter((l) => leadState.selected.has(l.placeId)).length;
  allCb.disabled = total === 0;
  allCb.checked = total > 0 && here === total;
  allCb.indeterminate = here > 0 && here < total;
}

$('#lead-select-all-cb').addEventListener('change', (e) => {
  const checked = e.target.checked;
  leadState.leads.forEach((l) => {
    if (checked) leadState.selected.set(l.placeId, { lead: l, niche: leadState.niche });
    else leadState.selected.delete(l.placeId);
  });
  saveBasket();
  $('#lead-results').querySelectorAll('.lead-select-cb').forEach((cb) => { cb.checked = checked; });
  updateBatchBar();
});

// ---- The basket: everything picked so far, across every search ----

function basketRowHtml(entry) {
  const { lead, niche } = entry;
  const meta = [niche, lead.address].filter(Boolean).join(' · ');
  return `
    <div class="basket-row" data-place-id="${escapeHtml(lead.placeId)}">
      <div class="bk-text">
        <span class="bk-name">${escapeHtml(lead.name)}</span>
        ${meta ? `<span class="bk-meta">${escapeHtml(meta)}</span>` : ''}
      </div>
      <button type="button" class="btn btn-sm bk-remove" data-remove="${escapeHtml(lead.placeId)}" aria-label="Remove ${escapeHtml(lead.name)}">Remove</button>
    </div>`;
}

function renderBasket() {
  const list = $('#basket-list');
  const entries = Array.from(leadState.selected.values());
  const n = entries.length;
  $('#basket-modal-sub').textContent = n
    ? `${n} business${n === 1 ? '' : 'es'} · ${n} AI credit${n === 1 ? '' : 's'} to generate them all`
    : 'Nothing picked yet. Tick a lead in the results to add it here.';
  list.innerHTML = entries.map(basketRowHtml).join('');
  $('#basket-generate').disabled = n === 0;
  $('#basket-clear').disabled = n === 0;
}

function openBasket() {
  renderBasket();
  $('#basket-modal').hidden = false;
}

$('#lead-selected-count').addEventListener('click', openBasket);
$('#basket-modal-close').addEventListener('click', () => { $('#basket-modal').hidden = true; });
$('#basket-modal').addEventListener('click', (e) => {
  if (e.target === $('#basket-modal')) $('#basket-modal').hidden = true;
});

$('#basket-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-remove]');
  if (!btn) return;
  const row = btn.closest('.basket-row');
  basketRemove(btn.dataset.remove);
  if (row) row.remove();
  renderBasket();
});

$('#basket-clear').addEventListener('click', () => {
  if (!leadState.selected.size) return;
  if (!confirm('Take everything out of the basket?')) return;
  leadState.selected.clear();
  saveBasket();
  $('#lead-results').querySelectorAll('.lead-select-cb').forEach((cb) => { cb.checked = false; });
  updateBatchBar();
  renderBasket();
});

$('#basket-generate').addEventListener('click', () => {
  $('#basket-modal').hidden = true;
  runBatchGenerate(Array.from(leadState.selected.values()));
});

// Reuses the "from" identity already saved by the Invoice/Emails tabs so the
// pitch line can introduce you by name without asking again.
function pitchTextFor(lead, url) {
  const from = emailFromInfo();
  const intro = from.name && from.name !== 'Your Business' ? `I'm ${from.name} — ` : '';
  return `Hi, is this the owner of ${lead.name}? ${intro}I build websites for local businesses. I already made one for you — want to see it? ${url}`;
}

function batchRowHtml(entry) {
  const { lead, niche } = entry;
  return `
    <div class="batch-row" data-place-id="${escapeHtml(lead.placeId)}">
      <div class="br-top">
        <span class="br-name">${escapeHtml(lead.name)}</span>
        <span class="br-status">Waiting…</span>
      </div>
      ${niche ? `<span class="br-niche">${escapeHtml(niche)}</span>` : ''}
    </div>`;
}

let batchCancelled = false;
// While a batch is mid-run the modal is the only signal that credits are still
// being spent, so it stays put until the run ends or Cancel is pressed.
let batchRunning = false;

// `entries` are basket entries — { lead, niche } — not bare leads. A basket
// built across several searches holds several niches, so the prompt for each
// site has to come from the niche that lead was found under.
async function runBatchGenerate(entries) {
  if (!entries.length) return;
  const n = entries.length;
  if (!confirm(`Generate ${n} demo site${n === 1 ? '' : 's'}? This uses ${n} AI credit${n === 1 ? '' : 's'} — one per site.`)) return;

  batchCancelled = false;
  batchRunning = true;
  $('#batch-modal-title').textContent = 'Generating demos…';
  $('#batch-modal-sub').textContent = `0 of ${n} done · about ${Math.max(3, Math.round(n * 2.5))} minutes · keep this tab open`;
  $('#batch-list').innerHTML = entries.map(batchRowHtml).join('');
  const rows = Array.from($('#batch-list').querySelectorAll('.batch-row'));
  const cancelBtn = $('#batch-modal-cancel');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.disabled = false;
  cancelBtn.onclick = () => {
    batchCancelled = true;
    // The site in progress is already paid for, so it is allowed to finish.
    cancelBtn.textContent = 'Stopping after this site…';
    cancelBtn.disabled = true;
  };
  $('#batch-modal').hidden = false;

  // A batch is minutes of waiting, and a phone that locks its screen suspends
  // the page and drops the request it was waiting on. Where the browser allows
  // it, hold the screen on until the batch ends.
  let wakeLock = null;
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not supported or refused */ }

  let done = 0;
  try {
    for (let i = 0; i < entries.length; i++) {
      if (batchCancelled) break;
      const { lead, niche } = entries[i];
      const row = rows[i];
      const statusEl = row.querySelector('.br-status');
      statusEl.textContent = 'Generating…';
      try {
        const prompt = fullLeadPrompt(lead, niche);
        const context = extractKeywords(prompt);
        const siteId = newSiteId();
        const genRes = await api('/api/generate', {
          method: 'POST',
          body: { mode: 'page', prompt, context, notifyEmail: '', siteId },
        });
        rememberPick({
          concept: directionForLead(lead, niche).concept.key,
          layout: directionForLead(lead, niche).layout.key,
          font: parseConcept(genRes.html)?.['display-font'] || '',
        });
        const prevRes = await api('/api/previews', {
          method: 'POST',
          body: { kind: 'single', html: genRes.html, placeId: lead.placeId },
        });
        const fullUrl = location.origin + prevRes.url;
        row.classList.add('is-done');
        // Every demo is checked against the facts it was built from before you
        // are handed a link to send.
        const check = checkSite(genRes.html, prompt);
        statusEl.textContent = check.fix.length ? `Done — ${check.fix.length} to fix first` : 'Done ✓';
        if (check.total) {
          row.classList.toggle('needs-look', check.fix.length > 0);
          const bits = [
            check.fix.length ? `Fix: ${check.fix.map((f) => f.text).join(' · ')}` : '',
            check.confirm.length ? `Ask the owner: ${check.confirm.map((f) => f.text).join(' · ')}` : '',
          ].filter(Boolean);
          row.insertAdjacentHTML('beforeend', `<p class="br-check">${escapeHtml(bits.join('  —  '))}</p>`);
        }
        const pitch = pitchTextFor(lead, fullUrl);
        row.insertAdjacentHTML('beforeend', `
          <a class="br-link" href="${escapeHtml(prevRes.url)}" target="_blank" rel="noopener">${escapeHtml(fullUrl)}</a>
          <div class="br-actions">
            <button type="button" class="btn btn-sm" data-copy-link="${escapeHtml(fullUrl)}">Copy link</button>
            <button type="button" class="btn btn-sm" data-copy-pitch="${escapeHtml(pitch)}">Copy pitch text</button>
          </div>`);
        row.querySelector('[data-copy-link]').addEventListener('click', (e) => copyText(e.target.dataset.copyLink));
        row.querySelector('[data-copy-pitch]').addEventListener('click', (e) => copyText(e.target.dataset.copyPitch));
        // Its demo exists now, so it leaves the basket. Anything that failed
        // stays put, ready for another go.
        basketRemove(lead.placeId);
      } catch (err) {
        row.classList.add('is-failed');
        statusEl.textContent = `Failed — ${err.message}`;
      }
      done++;
      $('#batch-modal-sub').textContent = `${done} of ${n} done`;
    }
  } finally {
    // Always hand the modal back, even if something above threw. Otherwise the
    // backdrop stays blocked and Cancel still reads "Cancel", leaving a modal
    // that can only be escaped by reloading the page.
    batchRunning = false;
    try { await wakeLock?.release(); } catch { /* already released */ }
    cancelBtn.textContent = 'Close';
    cancelBtn.disabled = false;
    cancelBtn.onclick = () => { $('#batch-modal').hidden = true; };
    $('#batch-modal-title').textContent = batchCancelled ? 'Stopped early' : 'All done';
  }
  loadSites();
}

$('#lead-batch-generate').addEventListener('click', () => {
  runBatchGenerate(Array.from(leadState.selected.values()));
});

// Tapping the backdrop closes the modal only once nothing is left running —
// otherwise sites would keep generating (and credits keep being spent) with
// nothing on screen to show it. Stopping early has to be a deliberate Cancel.
$('#batch-modal').addEventListener('click', (e) => {
  if (e.target === $('#batch-modal') && !batchRunning) $('#batch-modal').hidden = true;
});

// ------------------------------------------------- Section 3b: History

async function loadHistory() {
  const list = $('#history-list');
  showSkeleton(list, { rows: 4 });
  try {
    const { entries } = await api('/api/history');
    $('#history-empty').hidden = entries.length > 0;
    list.innerHTML = entries.map((e, i) => `
      <button class="history-row" data-i="${i}">
        <span class="h-name">${escapeHtml(e.name)}</span>
        <span class="h-niche">${escapeHtml(e.niche)}</span>
        <span class="h-date">${escapeHtml(formatDate(e.firstViewedAt))}</span>
        <span class="badge badge-${e.status === 'client' ? 'client' : e.status}">${e.status === 'client' ? 'Yes — client' : e.status === 'no' ? 'No' : 'Undecided'}</span>
      </button>`).join('');
    clearSkeleton(list);
    staggerIn(list);
    list.querySelectorAll('.history-row').forEach((row) => {
      row.addEventListener('click', () => openHistoryDetail(entries[Number(row.dataset.i)]));
    });
  } catch (err) {
    list.innerHTML = `<p class="inline-error">${escapeHtml(err.message)}</p>`;
  }
}

$('#history-refresh').addEventListener('click', loadHistory);

function openHistoryDetail(entry) {
  const lead = entry.lead || {
    placeId: entry.placeId, name: entry.name, address: '', phone: '',
    rating: null, reviewCount: 0, website: null, category: '',
  };
  const holder = $('#detail-card');
  const render = (status) => {
    holder.innerHTML = `<article class="lead-card">${leadCardHtml(lead, entry.niche, status === 'yes' ? 'client' : status)}</article>`;
    wireSelectCheckbox(holder, lead, entry.niche);
    wireLeadCard(holder.firstElementChild, lead, entry.niche, (newStatus) => {
      render(newStatus === 'client' ? 'client' : newStatus);
      loadHistory();
    });
  };
  render(entry.status);
  $('#detail-modal').hidden = false;
}

$('#detail-close').addEventListener('click', () => { $('#detail-modal').hidden = true; });
$('#detail-modal').addEventListener('click', (e) => {
  if (e.target === $('#detail-modal')) $('#detail-modal').hidden = true;
});

// ------------------------------------------------- Prospects (manual pipeline)
// Any lead however you found it — not tied to a Google Place ID the way
// Lead Finder's History is, so it works whether or not Lead Finder is ever
// turned on. Tracks: new -> contacted -> follow_up -> won (becomes a client)
// or no.

const prospectState = { prospects: [] };

const PROSPECT_STATUS_LABEL = {
  new: 'New', contacted: 'Contacted', follow_up: 'Follow up', won: 'Won — client', no: 'No',
};

function updateFollowupVisibility() {
  const row = $('#pf-followup-row');
  if (row) row.style.display = $('#pf-status').value === 'follow_up' ? '' : 'none';
}
$('#pf-status')?.addEventListener('change', updateFollowupVisibility);

function openProspectModal(prospect = null) {
  $('#prospect-form').reset();
  $('#prospect-form-error').hidden = true;
  $('#pf-id').value = prospect ? prospect.id : '';
  if (prospect) {
    $('#prospect-modal-title').textContent = 'Edit prospect';
    $('#pf-name').value = prospect.businessName;
    $('#pf-niche').value = prospect.niche || '';
    $('#pf-phone').value = prospect.phone || '';
    $('#pf-notes').value = prospect.notes || '';
    // "won" isn't a manually-selectable option — use the Won button instead.
    $('#pf-status').value = prospect.status === 'won' ? 'contacted' : prospect.status;
    $('#pf-followup').value = prospect.followUpDate || '';
  } else {
    $('#prospect-modal-title').textContent = 'Add prospect';
    $('#pf-status').value = 'new';
  }
  updateFollowupVisibility();
  $('#prospect-modal').hidden = false;
  $('#pf-name').focus();
}

$('#prospect-add')?.addEventListener('click', () => openProspectModal());
$('#prospect-modal-cancel')?.addEventListener('click', () => { $('#prospect-modal').hidden = true; });
$('#prospect-modal')?.addEventListener('click', (e) => { if (e.target === $('#prospect-modal')) $('#prospect-modal').hidden = true; });

$('#prospect-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('#prospect-form-error');
  errEl.hidden = true;
  const id = $('#pf-id').value;
  const payload = {
    businessName: $('#pf-name').value.trim(),
    niche: $('#pf-niche').value.trim(),
    phone: $('#pf-phone').value.trim(),
    notes: $('#pf-notes').value.trim(),
    status: $('#pf-status').value,
    followUpDate: $('#pf-status').value === 'follow_up' ? ($('#pf-followup').value || null) : null,
  };
  if (!payload.businessName) { errEl.textContent = 'Business name is required.'; errEl.hidden = false; return; }
  $('#prospect-form-submit').disabled = true;
  try {
    if (id) {
      await api(`/api/prospects/${id}`, { method: 'PUT', body: payload });
      toast('Prospect updated');
    } else {
      await api('/api/prospects', { method: 'POST', body: payload });
      toast('Prospect added');
    }
    $('#prospect-modal').hidden = true;
    loadProspects();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  } finally {
    $('#prospect-form-submit').disabled = false;
  }
});

async function updateProspectStatus(prospect, status, followUpDate) {
  try {
    await api(`/api/prospects/${prospect.id}`, {
      method: 'PUT',
      body: { status, followUpDate: status === 'follow_up' ? (followUpDate ?? prospect.followUpDate) : null },
    });
    loadProspects();
  } catch (err) { toast(err.message, true); }
}

// Reuses the existing client modal (same as Lead Finder's Yes-flow) so a won
// prospect becomes a real client with zero duplicate code.
function convertProspectToClient(prospect) {
  openClientModal({
    mode: 'lead',
    lead: { name: prospect.businessName, phone: prospect.phone, address: '', placeId: null },
    onSaved: async () => {
      try { await api(`/api/prospects/${prospect.id}`, { method: 'PUT', body: { status: 'won' } }); } catch { /* client still saved */ }
      toast(`${prospect.businessName} added as a client 🎉`);
      loadProspects();
    },
  });
}

async function deleteProspect(prospect) {
  if (!confirm(`Delete ${prospect.businessName}? This can't be undone.`)) return;
  try {
    await api(`/api/prospects/${prospect.id}`, { method: 'DELETE' });
    toast('Deleted');
    loadProspects();
  } catch (err) { toast(err.message, true); }
}

function renderProspects() {
  const today = localToday();
  const active = prospectState.prospects.filter((p) => p.status !== 'won' && p.status !== 'no');
  const dueNow = active.filter((p) => p.status === 'follow_up' && p.followUpDate && p.followUpDate <= today);

  const dueBox = $('#prospects-due');
  if (dueNow.length) {
    dueBox.hidden = false;
    dueBox.innerHTML = `<h3>Follow up today (${dueNow.length})</h3>` + dueNow.map((p) => `
      <div class="due-row" data-id="${p.id}">
        <span><strong>${escapeHtml(p.businessName)}</strong>${p.phone ? ` · ${escapeHtml(p.phone)}` : ''}</span>
        <button class="btn btn-sm btn-primary" data-act="contacted">Mark contacted</button>
      </div>`).join('');
    dueBox.querySelectorAll('.due-row').forEach((row) => {
      const p = prospectState.prospects.find((x) => String(x.id) === row.dataset.id);
      row.querySelector('[data-act="contacted"]').addEventListener('click', () => updateProspectStatus(p, 'contacted'));
    });
  } else {
    dueBox.hidden = true;
  }

  const list = $('#prospects-list');
  $('#prospects-empty').hidden = active.length > 0;
  list.innerHTML = '';
  for (const p of active) {
    const card = document.createElement('div');
    card.className = 'prospect-card';
    card.innerHTML = `
      <div class="client-top">
        <h3>${escapeHtml(p.businessName)}</h3>
        <span class="badge${p.status === 'new' || p.status === 'contacted' ? ' badge-undecided' : ''}">${PROSPECT_STATUS_LABEL[p.status]}</span>
      </div>
      <div class="client-meta">
        ${p.niche ? `<div>${escapeHtml(p.niche)}</div>` : ''}
        ${p.phone ? `<div><a href="tel:${escapeHtml(p.phone.replace(/[^\d+]/g, ''))}">${escapeHtml(p.phone)}</a></div>` : ''}
        ${p.followUpDate ? `<div>Follow up: <strong>${escapeHtml(formatDate(p.followUpDate))}</strong></div>` : ''}
      </div>
      ${p.notes ? `<p class="prospect-notes">${escapeHtml(p.notes)}</p>` : ''}
      <div class="prospect-actions">
        <select class="status-select" aria-label="Status">
          <option value="new" ${p.status === 'new' ? 'selected' : ''}>New</option>
          <option value="contacted" ${p.status === 'contacted' ? 'selected' : ''}>Contacted</option>
          <option value="follow_up" ${p.status === 'follow_up' ? 'selected' : ''}>Follow up</option>
        </select>
        <input type="date" class="followup-input" value="${p.followUpDate || ''}" ${p.status === 'follow_up' ? '' : 'hidden'}>
        <button class="btn btn-sm btn-primary" data-act="won">🎉 Won</button>
        <button class="btn btn-sm" data-act="no">No</button>
        <button class="btn btn-sm" data-act="edit">Edit</button>
        <button class="btn btn-sm btn-danger" data-act="delete">Delete</button>
      </div>`;
    const dateInput = card.querySelector('.followup-input');
    card.querySelector('.status-select').addEventListener('change', (e) => {
      dateInput.hidden = e.target.value !== 'follow_up';
      updateProspectStatus(p, e.target.value, dateInput.value);
    });
    dateInput.addEventListener('change', () => updateProspectStatus(p, 'follow_up', dateInput.value));
    card.querySelector('[data-act="won"]').addEventListener('click', () => convertProspectToClient(p));
    card.querySelector('[data-act="no"]').addEventListener('click', () => updateProspectStatus(p, 'no'));
    card.querySelector('[data-act="edit"]').addEventListener('click', () => openProspectModal(p));
    card.querySelector('[data-act="delete"]').addEventListener('click', () => deleteProspect(p));
    list.appendChild(card);
  }
}

async function loadProspects() {
  try {
    const { prospects } = await api('/api/prospects');
    prospectState.prospects = prospects;
    renderProspects();
  } catch (err) {
    $('#prospects-list').innerHTML = `<p class="inline-error">${escapeHtml(err.message)}</p>`;
  }
}

// ------------------------------------------------- Section 4: Clients

const clientState = { clients: [] };

// The upfront payment has a processing fee too — and it's the bigger one, so
// it matters more than the monthly. Editing an existing client leaves the
// recorded method alone; only new clients log income.
function renderClientNetPreview() {
  const isEdit = !!$('#cf-id').value;
  const amount = Number($('#cf-amount').value || 0);
  $('#cf-method-row').hidden = isEdit || !(amount > 0);
  if (isEdit || !(amount > 0)) { $('#cf-net').hidden = true; return; }
  renderNetLine($('#cf-net'), amount, $('#cf-method').value);
}

(function initClientMethod() {
  const sel = $('#cf-method');
  if (!sel) return;
  populateMethodSelect(sel);
  sel.addEventListener('change', () => { rememberMethod(sel.value); renderClientNetPreview(); });
  $('#cf-amount')?.addEventListener('input', renderClientNetPreview);
})();

function openClientModal({ mode, lead = null, client = null, onSaved = null }) {
  const modal = $('#client-modal');
  const form = $('#client-form');
  form.reset();
  $('#client-form-error').hidden = true;
  $('#cf-id').value = client ? client.id : '';
  $('#cf-place-id').value = lead ? lead.placeId : (client?.placeId || '');
  $('#cf-close-date').value = localToday();
  $('#cf-method').value = lastUsedMethod();

  if (mode === 'lead') {
    $('#client-modal-title').textContent = 'New client 🎉';
    $('#client-modal-sub').textContent = 'Fill in what the Places listing doesn\'t know. Close date defaults to today — edit it to log an older deal.';
    $('#cf-company').value = lead.name || '';
    $('#cf-phone').value = lead.phone || '';
    $('#cf-address').value = lead.address || '';
  } else if (mode === 'edit') {
    $('#client-modal-title').textContent = 'Edit client';
    $('#client-modal-sub').textContent = '';
    $('#cf-company').value = client.companyName;
    $('#cf-owner').value = client.ownerName;
    $('#cf-email').value = client.email;
    $('#cf-phone').value = client.phone;
    $('#cf-address').value = client.address;
    $('#cf-amount').value = client.amountPaid;
    $('#cf-monthly').value = client.monthlyFee;
    $('#cf-close-date').value = client.closeDate;
  } else {
    $('#client-modal-title').textContent = 'Add client';
    $('#client-modal-sub').textContent = 'For deals that didn\'t come through Lead Finder.';
  }

  renderClientNetPreview();
  modal.hidden = false;
  modal.dataset.mode = mode;
  modal._onSaved = onSaved;
  $('#cf-company').focus();
}

$('#client-modal-cancel').addEventListener('click', () => { $('#client-modal').hidden = true; });
$('#client-modal').addEventListener('click', (e) => {
  if (e.target === $('#client-modal')) $('#client-modal').hidden = true;
});

$('#client-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const modal = $('#client-modal');
  const errEl = $('#client-form-error');
  errEl.hidden = true;

  const amountPaid = Number($('#cf-amount').value || 0);
  const payload = {
    companyName: $('#cf-company').value.trim(),
    ownerName: $('#cf-owner').value.trim(),
    email: $('#cf-email').value.trim(),
    phone: $('#cf-phone').value.trim(),
    address: $('#cf-address').value.trim(),
    amountPaid,
    monthlyFee: Number($('#cf-monthly').value || 0),
    closeDate: $('#cf-close-date').value,
  };

  const id = $('#cf-id').value;
  if (!id && amountPaid > 0) {
    payload.paymentMethod = $('#cf-method').value;
    payload.fee = feeFor(amountPaid, payload.paymentMethod);
  }
  const placeId = $('#cf-place-id').value;
  $('#client-form-submit').disabled = true;
  try {
    if (id) {
      await api(`/api/clients/${id}`, { method: 'PUT', body: payload });
      toast('Client updated');
    } else {
      const isFirstEver = clientState.clients.length === 0;
      await api('/api/clients', { method: 'POST', body: { ...payload, placeId: placeId || undefined } });
      // First client is a genuine milestone — mark it, but only ever once.
      if (isFirstEver && !storeGet(FIRST_CLIENT_KEY)) {
        storeSet(FIRST_CLIENT_KEY, '1');
        celebrate();
        setTimeout(() => toast('🎉 First client. That is the hard one done.'), 900);
      }
      toast(amountPaid > 0
        ? `Client added — ${money(amountPaid)} logged to Money`
        : (placeId ? 'Client added — this lead won\'t show up in searches anymore' : 'Client added'));
    }
    modal.hidden = true;
    if (typeof modal._onSaved === 'function') modal._onSaved();
    loadClients();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  } finally {
    $('#client-form-submit').disabled = false;
  }
});

$('#client-add').addEventListener('click', () => openClientModal({ mode: 'add' }));

// Every maintenance month this client still owes, oldest first — not just the
// current one. A month that gets skipped used to vanish the moment the
// calendar rolled over, so the money was quietly never collected.
function unpaidMonths(client, currentMonth) {
  if (!(client.monthlyFee > 0)) return [];
  if (client.status === 'ended') return [];          // no longer billing them
  const closeMonth = (client.closeDate || '').slice(0, 7);
  if (!closeMonth) return [];

  // Maintenance cycles start the month after close; upfront covers month 1.
  const out = [];
  let m = shiftMonth(closeMonth, 1);
  while (m <= currentMonth) {
    if (!client.paidMonths.includes(m)) out.push(m);
    m = shiftMonth(m, 1);
  }
  return out;
}

function amountOwed(client, currentMonth) {
  return unpaidMonths(client, currentMonth).length * (client.monthlyFee || 0);
}

// Asks how a payment arrived so the fee can be worked out, then resolves with
// { method, fee } — or null if cancelled.
function askPaymentMethod({ title, sub, amount }) {
  return new Promise((resolve) => {
    const modal = $('#paymethod-modal');
    const sel = $('#pm-method');
    const netEl = $('#pm-net');
    $('#paymethod-title').textContent = title;
    $('#paymethod-sub').textContent = sub;
    populateMethodSelect(sel);

    const update = () => renderNetLine(netEl, amount, sel.value);
    update();

    const close = (result) => {
      modal.hidden = true;
      sel.removeEventListener('change', onChange);
      $('#paymethod-form').removeEventListener('submit', onSubmit);
      $('#paymethod-cancel').removeEventListener('click', onCancel);
      modal.removeEventListener('click', onBackdrop);
      resolve(result);
    };
    const onChange = () => { rememberMethod(sel.value); update(); };
    const onSubmit = (e) => {
      e.preventDefault();
      close({ method: sel.value, fee: feeFor(amount, sel.value) });
    };
    const onCancel = () => close(null);
    const onBackdrop = (e) => { if (e.target === modal) close(null); };

    sel.addEventListener('change', onChange);
    $('#paymethod-form').addEventListener('submit', onSubmit);
    $('#paymethod-cancel').addEventListener('click', onCancel);
    modal.addEventListener('click', onBackdrop);
    modal.hidden = false;
  });
}

async function markPaid(client, month) {
  const target = month || localCurrentMonth();
  const answer = await askPaymentMethod({
    title: 'How did they pay?',
    sub: `${client.companyName} — ${formatMonth(target)} · ${money(client.monthlyFee)}`,
    amount: client.monthlyFee,
  });
  if (!answer) return;
  try {
    await api(`/api/clients/${client.id}/payments`, {
      method: 'POST',
      body: { month: target, method: answer.method, fee: answer.fee, date: localToday() },
    });
    toast(`${client.companyName} paid for ${formatMonth(target)} — added to Money`);
    loadClients();
  } catch (err) {
    toast(err.message, true);
  }
}

async function setClientStatus(client, status) {
  const ending = status === 'ended';
  if (ending && !confirm(
    `Stop billing ${client.companyName}?\n\nThey'll stop showing up as owing you money, but everything they already paid stays counted in Revenue.`
  )) return;
  try {
    await api(`/api/clients/${client.id}`, { method: 'PUT', body: { status } });
    toast(ending ? `${client.companyName} marked as ended` : `${client.companyName} is active again`);
    loadClients();
  } catch (err) {
    toast(err.message, true);
  }
}

function renderClients() {
  const month = localCurrentMonth();
  const owing = clientState.clients
    .map((c) => ({ client: c, months: unpaidMonths(c, month) }))
    .filter((x) => x.months.length > 0);

  const dueBox = $('#clients-due');
  if (owing.length) {
    const totalOwed = owing.reduce((sum, x) => sum + x.months.length * x.client.monthlyFee, 0);
    const behind = owing.filter((x) => x.months.length > 1).length;
    dueBox.hidden = false;
    dueBox.innerHTML = `
      <h3>Owed to you — ${money(totalOwed)}${behind ? ` · ${behind} behind` : ''}</h3>
      ${owing.map(({ client: c, months }) => `
        <div class="due-row" data-id="${c.id}">
          <span>
            <strong>${escapeHtml(c.companyName)}</strong> · ${money(c.monthlyFee)}/mo
            <small class="due-months">Owes ${months.map((m) => escapeHtml(formatMonth(m))).join(', ')} — <b>${money(months.length * c.monthlyFee)}</b></small>
          </span>
          <span class="due-btns">
            ${months.map((m) => `<button class="btn btn-sm btn-primary" data-month="${m}">${escapeHtml(formatMonth(m).replace(/ \d{4}$/, ''))} paid</button>`).join('')}
          </span>
        </div>`).join('')}`;
    dueBox.querySelectorAll('.due-row').forEach((row) => {
      const client = clientState.clients.find((c) => c.id === Number(row.dataset.id));
      row.querySelectorAll('[data-month]').forEach((btn) => {
        btn.addEventListener('click', () => markPaid(client, btn.dataset.month));
      });
    });
  } else {
    dueBox.hidden = clientState.clients.length === 0;
    dueBox.innerHTML = `<h3>All caught up 🔥</h3><p class="muted" style="margin:0">Nobody owes you anything right now.</p>`;
  }

  const list = $('#clients-list');
  $('#clients-empty').hidden = clientState.clients.length > 0;
  list.innerHTML = '';
  for (const c of clientState.clients) {
    const ended = c.status === 'ended';
    const owedMonths = unpaidMonths(c, month);
    const paidThisMonth = c.paidMonths.includes(month);
    const card = document.createElement('div');
    card.className = `client-card${ended ? ' is-ended' : ''}`;
    card.innerHTML = `
      <div class="client-top">
        <h3>${escapeHtml(c.companyName)}</h3>
        <div class="client-actions">
          ${ended ? '<span class="badge badge-undecided">Ended</span>' : ''}
          ${!ended && owedMonths.length
            ? `<button class="btn btn-sm btn-primary" data-act="paid">Mark ${escapeHtml(formatMonth(owedMonths[0]).replace(/ \d{4}$/, ''))} paid</button>`
            : !ended && paidThisMonth ? '<span class="badge badge-client">Paid this month</span>' : ''}
          <button class="btn btn-sm" data-act="edit">Edit</button>
          <button class="btn btn-sm" data-act="status">${ended ? 'Reactivate' : 'Mark as ended'}</button>
          <button class="btn btn-sm btn-danger" data-act="delete">Delete</button>
        </div>
      </div>
      <div class="client-meta">
        ${c.ownerName ? `<div>Contact: <strong>${escapeHtml(c.ownerName)}</strong></div>` : ''}
        ${c.phone ? `<div>Phone: <strong>${escapeHtml(c.phone)}</strong></div>` : ''}
        ${c.email ? `<div>Email: <strong>${escapeHtml(c.email)}</strong></div>` : ''}
        ${c.address ? `<div>Address: <strong>${escapeHtml(c.address)}</strong></div>` : ''}
        <div>Upfront: <strong>${money(c.amountPaid)}</strong></div>
        <div>Monthly: <strong>${money(c.monthlyFee)}</strong></div>
        <div>Closed: <strong>${escapeHtml(formatDate(c.closeDate))}</strong></div>
        <div>Months paid: <strong>${c.paidMonths.length}</strong>${c.lastPaidMonth ? ` (last: ${escapeHtml(formatMonth(c.lastPaidMonth))})` : ''}</div>
        ${owedMonths.length ? `<div class="owes">Owes: <strong>${money(owedMonths.length * c.monthlyFee)}</strong> (${owedMonths.length} month${owedMonths.length === 1 ? '' : 's'})</div>` : ''}
      </div>`;
    card.querySelector('[data-act="edit"]').addEventListener('click', () => openClientModal({ mode: 'edit', client: c }));
    card.querySelector('[data-act="status"]').addEventListener('click', () => setClientStatus(c, ended ? 'active' : 'ended'));
    card.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      if (!confirm(
        `Delete ${c.companyName} completely?\n\nThis also erases every payment they ever made, from Revenue and from the Money tab, so both totals will drop. If they were a real client who's just finished, use "Mark as ended" instead.`
      )) return;
      try {
        await api(`/api/clients/${c.id}`, { method: 'DELETE' });
        toast('Client removed');
        loadClients();
      } catch (err) { toast(err.message, true); }
    });
    const paidBtn = card.querySelector('[data-act="paid"]');
    if (paidBtn) paidBtn.addEventListener('click', () => markPaid(c, owedMonths[0]));
    list.appendChild(card);
  }
  staggerIn(list);
}

async function loadClients() {
  try {
    const { clients } = await api('/api/clients');
    clientState.clients = clients;
    renderClients();
  } catch (err) {
    $('#clients-list').innerHTML = `<p class="inline-error">${escapeHtml(err.message)}</p>`;
  }
}

// ------------------------------------------------- Section 5: Revenue

const WINDOW_LABELS = {
  '24h': 'yesterday',
  week: 'prior week',
  month: 'prior 30 days',
  '6months': 'prior 6 months',
  year: 'prior year',
};

let revenueWindow = 'month';

async function loadRevenue() {
  try {
    // The server works in whole days on your clock, so it needs to know what
    // day it is here and how far this timezone is from UTC.
    const tz = -new Date().getTimezoneOffset();
    const res = await api(`/api/revenue?window=${encodeURIComponent(revenueWindow)}&today=${localToday()}&tz=${tz}`);
    countUp($('#revenue-value'), res.total, money);
    countUp($('#revenue-upfront'), res.upfront, money);
    countUp($('#revenue-monthly'), res.monthly, money);

    // Only shown once a fee has actually been charged, so a cash-only stretch
    // isn't cluttered with two extra zero rows.
    const fees = Number(res.fees) || 0;
    $('#revenue-net-box').hidden = fees <= 0;
    $('#revenue-fees').textContent = `−${money(fees)}`;
    $('#revenue-net').textContent = money(Number(res.net) || 0);

    const delta = $('#revenue-delta');
    if (res.trendPct === null || res.prior === null) {
      delta.hidden = true;
    } else {
      const up = res.trendPct >= 0;
      delta.className = `stat-delta ${up ? 'up' : 'down'}`;
      delta.innerHTML = `${up ? '↑' : '↓'} ${up ? '+' : ''}${res.trendPct}% <span class="vs">vs ${escapeHtml(WINDOW_LABELS[revenueWindow] || 'prior period')}</span>`;
      delta.hidden = false;
    }
  } catch (err) {
    toast(err.message, true);
  }
}

$('#revenue-toggle').querySelectorAll('button').forEach((b) => {
  b.addEventListener('click', () => {
    revenueWindow = b.dataset.window;
    $('#revenue-toggle').querySelectorAll('button').forEach((x) => x.classList.toggle('is-active', x === b));
    loadRevenue();
  });
});

// ------------------------------------------------- Traffic (visitor counts)

async function loadTraffic() {
  const list = $('#traffic-list');
  try {
    const { sites, total } = await api('/api/traffic');
    // A site is listed from the moment it is built, so "sent but never opened"
    // is visible too — that is the list to follow up on.
    const visited = sites.filter((s) => Number(s.views) > 0);
    const unopened = sites.filter((s) => !(Number(s.views) > 0));
    $('#traffic-empty').hidden = sites.length > 0;
    const totalEl = $('#traffic-total');
    if (totalEl) {
      totalEl.textContent = `${Number(total || 0).toLocaleString()} total visit${total === 1 ? '' : 's'} across ${visited.length} site${visited.length === 1 ? '' : 's'}`
        + (unopened.length ? ` · ${unopened.length} not opened yet` : '');
      totalEl.hidden = sites.length === 0;
    }
    const row = (s) => `
      <div class="traffic-row${Number(s.views) > 0 ? '' : ' is-unopened'}">
        <span class="t-name">${escapeHtml(s.label || '(untitled site)')}</span>
        <span class="t-views">${Number(s.views || 0).toLocaleString()}<small>visits</small></span>
        <span class="t-date">${Number(s.views) > 0
          ? 'last: ' + escapeHtml(formatDate(s.updatedAt))
          : 'built ' + escapeHtml(formatDate(s.createdAt))}</span>
      </div>`;
    list.innerHTML = visited.map(row).join('')
      + (unopened.length ? `<h3 class="traffic-sub">Not opened yet</h3>` + unopened.map(row).join('') : '');
  } catch (err) {
    list.innerHTML = `<p class="inline-error">${escapeHtml(err.message)}</p>`;
  }
}

$('#traffic-refresh')?.addEventListener('click', loadTraffic);

// ------------------------------------------------- Money Tracker (calendar)
// Log income, see it on a month calendar, and auto-split each month + all-time
// into fixed buckets: 25% taxes / 10% Forge / 35% save / 30% self.
//
// The buckets are worked out from what actually LANDED, not the sticker price:
// a $500 sale paid through PayPal only puts ~$482 in the bank, and setting
// aside 25% of $500 for tax would be setting aside money that never arrived.

const MONEY_SPLIT = [
  { key: 'tax', label: 'Taxes', pct: 0.25 },
  { key: 'forge', label: 'Forge', pct: 0.10 },
  { key: 'save', label: 'Save', pct: 0.35 },
  { key: 'you', label: 'You', pct: 0.30 },
];

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const moneyState = { month: localCurrentMonth(), entries: [] };

function pad2(n) { return String(n).padStart(2, '0'); }
function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

async function loadMoney() {
  if (!moneyState.month) moneyState.month = localCurrentMonth();
  try {
    const { entries } = await api('/api/income');
    moneyState.entries = entries || [];
    renderMoney();
  } catch (err) {
    $('#money-calendar').innerHTML = `<p class="inline-error">${escapeHtml(err.message)}</p>`;
  }
}

function moneySplitHtml(total) {
  const bar = MONEY_SPLIT.map((s) => `<span class="seg-${s.key}" style="width:${s.pct * 100}%"></span>`).join('');
  const rows = MONEY_SPLIT.map((s) => `
    <div class="bk">
      <span class="dot dot-${s.key}"></span>
      <span class="bk-name"><b>${s.label}</b><small>${Math.round(s.pct * 100)}%</small></span>
      <span class="bk-val money">${money(total * s.pct)}</span>
    </div>`).join('');
  return `<div class="stackbar" aria-hidden="true">${bar}</div><div class="bk-list">${rows}</div>`;
}

function renderMoney() {
  const ym = moneyState.month;
  const [y, m] = ym.split('-').map(Number);

  // Group this month's entries by day. Calendar cells show the sticker price
  // (that's the sale you remember making); the split below uses the net.
  const byDay = {};
  let monthGross = 0;
  let monthFees = 0;
  for (const e of moneyState.entries) {
    if ((e.date || '').slice(0, 7) !== ym) continue;
    const amt = Number(e.amount) || 0;
    monthGross += amt;
    monthFees += Number(e.fee) || 0;
    (byDay[e.date] = byDay[e.date] || { sum: 0 }).sum += amt;
  }
  const monthNet = monthGross - monthFees;

  $('#money-month-label').textContent = formatMonth(ym);
  countUp($('#money-month-total'), monthGross, money);

  // Build the calendar grid.
  const firstDow = new Date(y, m - 1, 1).getDay();
  const daysInMonth = new Date(y, m, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push('<td class="empty"></td>');
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${y}-${pad2(m)}-${pad2(d)}`;
    const info = byDay[key];
    cells.push(info
      ? `<td class="has" data-date="${key}"><div class="cd">${d}</div><div class="cd-amt money">${money(info.sum)}</div></td>`
      : `<td data-date="${key}"><div class="cd">${d}</div></td>`);
  }
  while (cells.length % 7 !== 0) cells.push('<td class="empty"></td>');
  let rows = '';
  for (let i = 0; i < cells.length; i += 7) rows += `<tr>${cells.slice(i, i + 7).join('')}</tr>`;
  $('#money-calendar').innerHTML =
    `<table class="cal"><thead><tr>${WEEKDAYS.map((w) => `<th>${w}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;

  // Month split summary. The fee/net lines only appear when a fee was actually
  // charged, so a cash-only month stays uncluttered.
  const monthFeeLines = monthFees > 0
    ? `<div class="fee-line"><small>Payment fees</small><b class="money">−${money(monthFees)}</b></div>
       <div class="net-line"><small>Actually received</small><b class="money">${money(monthNet)}</b></div>`
    : '';
  $('#money-summary').innerHTML =
    `<div class="tot"><small>Made this month</small><b class="money">${money(monthGross)}</b></div>
     ${monthFeeLines}
     <div class="money-split">${moneySplitHtml(monthNet)}</div>`;

  // All-time totals.
  const allGross = moneyState.entries.reduce((a, e) => a + (Number(e.amount) || 0), 0);
  const allFees = moneyState.entries.reduce((a, e) => a + (Number(e.fee) || 0), 0);
  const allNet = allGross - allFees;
  const pct = Object.fromEntries(MONEY_SPLIT.map((s) => [s.key, s.pct]));
  const feeStat = allFees > 0
    ? `<div class="stat fees"><small>Lost to payment fees</small><b class="money">${money(allFees)}</b></div>`
    : '';
  $('#money-alltime').innerHTML = `
    <div class="alltime-title">All-time totals</div>
    <div class="stat"><small>Total made</small><b class="money">${money(allGross)}</b></div>
    ${feeStat}
    <div class="stat tax"><small>Tax set aside</small><b class="money">${money(allNet * pct.tax)}</b></div>
    <div class="stat save"><small>Saved &amp; invested</small><b class="money">${money(allNet * pct.save)}</b></div>
    <div class="stat you"><small>Yours</small><b class="money">${money(allNet * pct.you)}</b></div>`;
}

function renderMoneyDayEntries(date) {
  const items = moneyState.entries.filter((e) => e.date === date);
  const box = $('#money-day-entries');
  if (!items.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="day-entries-title">Logged on ${escapeHtml(formatDate(date))}</div>` +
    items.map((e) => {
      const fee = Number(e.fee) || 0;
      const detail = fee > 0
        ? `${methodLabel(e.method)} — ${money(fee)} fee, you got ${money((Number(e.amount) || 0) - fee)}`
        : methodLabel(e.method);
      return `
      <div class="day-entry">
        <span class="de-amt money">${money(e.amount)}</span>
        <span class="de-note">${escapeHtml(e.note || '')}<small class="de-method">${escapeHtml(detail)}</small></span>
        ${e.clientId
          ? '<span class="de-linked" title="Logged by a client payment. Change it in the Clients tab.">from Clients</span>'
          : `<button class="btn btn-sm btn-danger" data-del="${e.id}">Delete</button>`}
      </div>`;
    }).join('');
  box.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.del;
      try {
        await api(`/api/income/${id}`, { method: 'DELETE' });
        moneyState.entries = moneyState.entries.filter((x) => String(x.id) !== String(id));
        renderMoney();
        renderMoneyDayEntries(date);
        toast('Deleted');
      } catch (err) { toast(err.message, true); }
    });
  });
}

function renderMoneyNetPreview() {
  renderNetLine($('#mf-net'), $('#mf-amount').value, $('#mf-method').value);
}

function openMoneyModal(date) {
  $('#money-form').reset();
  $('#money-form-error').hidden = true;
  $('#mf-date').value = date || localToday();
  // reset() wipes the select back to its first option, so restore the
  // remembered choice after it.
  $('#mf-method').value = lastUsedMethod();
  renderMoneyNetPreview();
  renderMoneyDayEntries($('#mf-date').value);
  $('#money-modal').hidden = false;
  $('#mf-amount').focus();
}

(function initMoneyMethods() {
  const sel = $('#mf-method');
  if (!sel) return;
  populateMethodSelect(sel);
  sel.addEventListener('change', () => {
    rememberMethod(sel.value);
    renderMoneyNetPreview();
  });
  $('#mf-amount')?.addEventListener('input', renderMoneyNetPreview);
})();

$('#money-add')?.addEventListener('click', () => openMoneyModal(null));
$('#money-prev')?.addEventListener('click', () => { moneyState.month = shiftMonth(moneyState.month, -1); renderMoney(); });
$('#money-next')?.addEventListener('click', () => { moneyState.month = shiftMonth(moneyState.month, 1); renderMoney(); });
$('#money-calendar')?.addEventListener('click', (e) => {
  const td = e.target.closest('td[data-date]');
  if (td) openMoneyModal(td.dataset.date);
});
$('#mf-date')?.addEventListener('change', () => renderMoneyDayEntries($('#mf-date').value));
$('#money-modal-close')?.addEventListener('click', () => { $('#money-modal').hidden = true; });
$('#money-modal-cancel')?.addEventListener('click', () => { $('#money-modal').hidden = true; });
$('#money-modal')?.addEventListener('click', (e) => { if (e.target === $('#money-modal')) $('#money-modal').hidden = true; });

$('#money-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const date = $('#mf-date').value;
  const amount = Number($('#mf-amount').value || 0);
  const note = $('#mf-note').value.trim();
  const payMethod = $('#mf-method').value;
  const fee = feeFor(amount, payMethod);
  const errEl = $('#money-form-error');
  errEl.hidden = true;
  if (!date) { errEl.textContent = 'Pick a date.'; errEl.hidden = false; return; }
  if (!(amount > 0)) { errEl.textContent = 'Enter an amount bigger than 0.'; errEl.hidden = false; return; }
  try {
    const { entry } = await api('/api/income', {
      method: 'POST',
      body: { date, amount, note, method: payMethod, fee },
    });
    moneyState.entries.push(entry);
    moneyState.month = date.slice(0, 7); // jump the calendar to the month you logged
    $('#mf-amount').value = '';
    $('#mf-note').value = '';
    renderMoneyNetPreview();
    $('#mf-amount').focus();
    renderMoney();
    renderMoneyDayEntries(date);
    toast(fee > 0 ? `Added ${money(amount)} — ${money(amount - fee)} after fees` : `Added ${money(amount)}`);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});

// ------------------------------------------------- Refine (edit in place)

// One-click polish pass: adds animations/hover/scroll-reveal without touching
// the content — the "Make it interactive" button runs this preset refine.
const ENHANCE_INSTRUCTION =
  'Add tasteful interactivity and visual polish WITHOUT changing the wording, images, colors, or overall layout: smooth scroll-reveal animations as sections enter the viewport, subtle hover effects on buttons, links, cards, and images, a sticky header that condenses slightly on scroll, and gentle transitions throughout. Keep it elegant and fast — no gaudy or distracting motion and no autoplay audio. Honor prefers-reduced-motion for accessibility, and keep all existing text and structure intact.';

// ------------------------------------------------- Art styles (restyle a site)
// Each entry carries a real design brief, not just a name: the model needs
// specific fonts, colours, shapes and mood to produce a genuinely different
// look. `swatch` is only for the picker's own thumbnail.

// Six styles that used to be here asked for exactly what the design rules ban
// (frosted-glass blur, neon glow, purple gradients, chrome gradient type, stock
// photography) and so made the model choose between the two. They are gone.
const ART_STYLES = [
  // ---- Clean ----
  { key: 'minimalist', name: 'Minimalist', group: 'Clean', blurb: 'Huge white space, almost no colour', swatch: ['#ffffff', '#111111', '#e5e5e5'],
    brief: 'Extreme restraint. Near-white background, near-black text, at most one muted accent used sparingly. Very generous white space — double the padding you would normally use. A refined sans-serif or a quiet grotesque, tight letter-spacing on headings. No shadows, no gradients, no rounded corners beyond 2px. Thin 1px hairline dividers instead of boxes and cards. Let emptiness do the work.' },
  { key: 'swiss', name: 'Swiss / Grid', group: 'Clean', blurb: 'Strict grid, precise, ordered', swatch: ['#f2f2f0', '#d32011', '#1a1a1a'],
    brief: 'International Typographic Style. A visible, strictly enforced column grid — align everything to it. Helvetica-like neue-grotesque type, flush left, ragged right, never centred. One bold primary colour (classic Swiss red or similar) against off-white and black. Large type-size contrast between headline and body. Rectangular blocks, hard edges, mathematical spacing. Order and precision above decoration.' },
  { key: 'scandinavian', name: 'Scandinavian', group: 'Clean', blurb: 'Light, airy, soft neutrals', swatch: ['#f7f5f2', '#a8b5a6', '#3d3a35'],
    brief: 'Nordic calm. Warm off-white and pale birch tones, soft sage or dusty blue accents, gentle warm grey text — never pure black. Light, humanist sans-serif with comfortable line-height. Soft 8–12px rounded corners, very subtle shadows. Airy spacing, natural light feeling, uncluttered. Understated and quietly premium.' },
  { key: 'corporate', name: 'Corporate Clean', group: 'Clean', blurb: 'Blue, safe, trustworthy', swatch: ['#ffffff', '#0b5cab', '#4a5568'],
    brief: 'Established professional-services look. Confident corporate blue as the primary, cool neutral greys, white background. Clear sans-serif, sensible sizes, strong readable hierarchy. Cards with light borders and soft shadows, 6px radii, tidy icon-led feature rows. Structured and predictable in a reassuring way — this should look like a company that has been in business twenty years.' },

  // ---- Bold ----
  { key: 'brutalist', name: 'Brutalist', group: 'Bold', blurb: 'Raw, harsh, unpolished on purpose', swatch: ['#ffffff', '#000000', '#0000ee'],
    brief: 'Raw web brutalism. Stark white background, pure black text, default-blue underlined links. Monospace or plain system type at unapologetic sizes. Thick 3–4px solid black borders on everything, zero border radius, zero shadows. Visible structure, exposed boxes, deliberately unrefined spacing. Loud oversized headings. It should feel hand-built and confrontational rather than designed.' },
  { key: 'neobrutalist', name: 'Neo-Brutalist', group: 'Bold', blurb: 'Thick outlines, hard shadows, bright', swatch: ['#ffde59', '#000000', '#ff5c8a'],
    brief: 'Modern neo-brutalism. Saturated flat primaries and candy brights on cream or white. Every card, button and image gets a heavy 3px black outline and a hard offset drop shadow (e.g. 6px 6px 0 #000) with no blur. Chunky geometric sans-serif, very heavy weights. Slight playful rotations on some elements. Buttons visibly "press" on hover by shifting toward their shadow. Bold, graphic and confident.' },
  { key: 'typographic', name: 'Bold Typographic', group: 'Bold', blurb: 'Giant letters are the design', swatch: ['#111111', '#f5f5f0', '#ff4b1f'],
    brief: 'Type as the entire design. The headline should be enormous — filling most of the viewport — in a heavy display face with very tight tracking and negative leading where lines stack. Minimal imagery; words carry everything. High contrast, mostly two tones plus one hot accent. Text set at dramatic size jumps. Sections separated by scale changes rather than boxes.' },
  { key: 'maximalist', name: 'Maximalist', group: 'Bold', blurb: 'Packed, layered, loud', swatch: ['#e63946', '#f7b32b', '#12c2e9'],
    brief: 'More is more. Clashing saturated colours, layered patterned backgrounds, overlapping elements, multiple contrasting typefaces used together. Decorative borders, stickers, badges and shapes filling negative space. Dense and energetic — but keep text legible over its background at all times. Every section should feel like a different poster while remaining one site.' },

  // ---- Retro ----
  { key: 'vintage70s', name: 'Vintage 70s', group: 'Retro', blurb: 'Burnt orange, brown, old signage', swatch: ['#e07a3f', '#7a4419', '#f2e3c9'],
    brief: '1970s Americana. Burnt orange, mustard, avocado and deep brown on warm cream. Rounded chunky retro display type for headings (think old motel and gas-station signage), warm serif or slab for body. Thick rounded pill shapes, arched section tops, concentric stripe motifs. Subtle grain or paper texture. Warm, sun-faded and nostalgic.' },
  { key: 'artdeco', name: 'Art Deco', group: 'Retro', blurb: 'Gold, geometric, 1920s luxury', swatch: ['#0e1b2a', '#c9a227', '#f4f1e8'],
    brief: '1920s Deco glamour. Deep navy or black grounds with metallic gold and cream. Strong symmetry, stepped geometric ornament, sunburst and chevron motifs, thin gold rules framing sections. High-contrast elegant display serif with wide letter-spacing for headings, refined serif body. Vertical emphasis, arched and fan-shaped forms. Opulent and formal.' },
  { key: 'memphis', name: 'Memphis', group: 'Retro', blurb: '80s squiggles and clashing shapes', swatch: ['#ff5c8a', '#2ec4f1', '#ffd23f'],
    brief: '1980s Memphis Group postmodernism. Bright clashing pastels and primaries on white. Scattered geometric confetti — squiggles, zigzags, dots, triangles, wavy lines — as decorative background elements. Playful asymmetry, elements rotated slightly off-axis. Bold rounded sans-serif. Terrazzo speckle patterns. Deliberately fun and slightly chaotic.' },

  // ---- Fancy ----
  { key: 'luxury', name: 'Luxury', group: 'Fancy', blurb: 'Black and gold, elegant, spacious', swatch: ['#0a0a0a', '#c9a961', '#f6f3ee'],
    brief: 'High-end boutique. Near-black or deep charcoal ground, warm gold or champagne accents, ivory text. A high-contrast elegant serif (Didone-like) for headings with wide letter-spacing, refined sans for body. Enormous white space, very restrained ornament, thin gold hairlines. Slow, understated hover transitions. Everything should feel expensive and unhurried.' },
  { key: 'editorial', name: 'Editorial', group: 'Fancy', blurb: 'Magazine headlines, column layouts', swatch: ['#faf8f5', '#1a1a1a', '#a4442c'],
    brief: 'Print magazine feature spread. Large expressive serif headlines with a drop cap opening the first paragraph. Multi-column text where appropriate, generous margins, pull-quotes set large in the accent colour. Off-white paper ground, rich black text, one editorial accent (deep red or ink blue). Captions in small italic. Rules and generous leading. Reads like a well-designed magazine.' },
  { key: 'newspaper', name: 'Newspaper', group: 'Fancy', blurb: 'Broadsheet, thin rules, dense', swatch: ['#f4f1ea', '#111111', '#8b0000'],
    brief: 'Broadsheet newspaper. Newsprint-cream ground, dense black serif body type in narrow columns, a heavy blackletter-or-condensed-serif masthead treatment for the business name. Thin black rules separating everything, small-caps section labels, bylines and datelines. Tight leading, justified columns. Deliberately old-print and information-dense.' },

  // ---- Techy ----
  { key: 'darktech', name: 'Dark Tech', group: 'Techy', blurb: 'Dark background, neon accent', swatch: ['#0d1117', '#3fb950', '#c9d1d9'],
    brief: 'Modern developer-product dark mode. Near-black blue-grey ground, elevated surfaces a shade lighter, one vivid accent (electric green or signal orange). Crisp geometric sans, monospace for small labels and numbers. Subtle 1px borders, 8px radii, flat colour with no glows or gradients. Sharp, technical and precise, with the accent used sparingly.' },
  { key: 'blueprint', name: 'Blueprint', group: 'Techy', blurb: 'Grid lines, technical drawing', swatch: ['#0b3d5c', '#7fd4ff', '#e8f4fa'],
    brief: 'Architectural drafting. Deep blueprint-blue ground with a fine white grid overlay. Thin white or pale-cyan line work, technical annotations, dimension lines and measurement ticks as decoration. Monospace or technical sans type, uppercase small labels. Sections framed like drawing sheets with title blocks and revision marks. Precise and engineered.' },

  // ---- Warm ----
  { key: 'handcrafted', name: 'Handcrafted', group: 'Warm', blurb: 'Textured, hand-drawn, cozy', swatch: ['#f2e8d5', '#8c5a2b', '#5a7a4a'],
    brief: 'Artisan and handmade. Warm kraft-paper and cream grounds with subtle paper or linen texture, earthy browns and muted greens. A friendly hand-lettered or brush script for headings paired with a warm serif body. Hand-drawn underlines, wobbly borders, stamp and badge motifs. Slightly imperfect alignment. Feels made by a person, not a factory.' },
  { key: 'organic', name: 'Organic', group: 'Warm', blurb: 'Earth tones, curves, botanical', swatch: ['#f6f1e7', '#5f7a52', '#c47b4f'],
    brief: 'Natural and botanical. Warm sand and cream grounds, sage and olive greens, terracotta accents. Soft organic blob shapes and curved section dividers instead of straight edges — wavy SVG separators between sections. Rounded humanist type. Leaf and plant motifs as subtle decoration. Very large border radii on images. Calm, earthy and alive.' },
  { key: 'illustrated', name: 'Illustrated', group: 'Warm', blurb: 'Drawings carry the page', swatch: ['#fff4e0', '#e8734a', '#2f6b8f'],
    brief: 'Illustration-led. Flat vector-style inline SVG illustrations as the main visual language — simple shapes, bold outlines, a limited friendly palette. Hand-drawn decorative accents, curved dividers, spot illustrations beside each section. Rounded approachable sans-serif. Playful but tidy. Where photos exist keep them, but surround them with illustrated framing.' },
  { key: 'collage', name: 'Collage', group: 'Warm', blurb: 'Layered cut-paper scraps', swatch: ['#f0ebe1', '#d94f37', '#2b4a6f'],
    brief: 'Cut-paper collage. Elements look torn or cut and pasted — irregular clip-path edges, slight rotations, layered overlapping pieces with paper drop shadows. Mixed typography, some pieces looking like they came from different sources. Tape and staple motifs. Muted vintage-paper palette with a couple of bold spot colours. Tactile, scrapbook energy.' },
  { key: 'playful', name: 'Playful', group: 'Warm', blurb: 'Rounded, bright, bouncy', swatch: ['#ffd93d', '#ff6b9d', '#4ecdc4'],
    brief: 'Cheerful and bouncy. Bright friendly primaries and pastels, very rounded everything — 24px+ radii, pill buttons, circular badges. Chunky rounded sans-serif with generous weight. Bouncy easing on hovers, slight scale-up interactions, wiggling accents. Fun geometric shapes in the background. Optimistic and approachable without being childish.' },

  // ---- Heavy ----
  { key: 'industrial', name: 'Industrial', group: 'Heavy', blurb: 'Concrete, metal, thick type', swatch: ['#2b2b2b', '#f0b429', '#8a8a8a'],
    brief: 'Workshop and heavy trade. Concrete grey and charcoal grounds with a subtle concrete or brushed-metal texture, safety-yellow or hazard-orange accents. Heavy condensed uppercase sans-serif, stencil feeling for headings. Hard edges, thick rules, diagonal hazard-stripe dividers, rivet and plate motifs. Utilitarian, rugged and built to last.' },
  { key: 'monochrome', name: 'Monochrome', group: 'Heavy', blurb: 'One colour, top to bottom', swatch: ['#1b2a3a', '#5c7a99', '#dce6f0'],
    brief: 'Single-hue discipline. Choose one colour that suits the trade and build the entire palette from tints and shades of only that hue — background, surfaces, text, buttons, borders. Images treated with a matching duotone or tint. Contrast comes from lightness alone, never from a second colour. One typeface at multiple weights. Cohesive and striking.' },
];

const STYLE_GROUPS = ['Clean', 'Bold', 'Retro', 'Fancy', 'Techy', 'Warm', 'Heavy'];

function styleByKey(key) {
  return ART_STYLES.find((s) => s.key === key) || null;
}

// The whole point: transform the look, keep the site. Anything that took a
// Claude call or a client's real details to produce must survive untouched.
function styleInstruction(style) {
  return `Completely redesign the VISUAL STYLE of this page in the "${style.name}" aesthetic.

${style.name} means: ${style.brief}

Change all of this to match the new style: colour palette, background treatments, fonts (swap the Google Fonts links to ones that fit), type sizes and weights, spacing and rhythm, borders, corner radii, shadows, button and card styling, section dividers, decorative details, hover states, and any illustrative or textural flourishes. Commit fully — the result should look like a different designer built it.

Keep ALL of the following EXACTLY as they are — do not reword, remove, reorder or invent any of it:
- Every word of the existing copy, headings and button labels
- All images and their src URLs, and their alt text
- The same sections in the same order, and the navigation
- The contact form: same fields, same name attributes, no action attribute
- Every phone number and tel: link, and any map embed
- All <head> metadata: title, meta description, Open Graph tags, the JSON-LD structured data block, and the favicon
- The footer's business name, auto-updating copyright year script and privacy line

Return the complete redesigned HTML document.`;
}

async function runBuildRefine(instruction, btn, busyLabel) {
  if (!buildState.html) { toast('Generate a site first', true); return false; }
  if (!instruction) { toast('Type what you want changed first', true); return false; }

  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = busyLabel;
  if (!buildState.siteId) buildState.siteId = extractSiteId(buildState.html) || newSiteId();
  try {
    const res = await api('/api/generate', {
      method: 'POST',
      body: { mode: 'refine', html: buildState.html, instruction, notifyEmail: buildState.notifyEmail || '', siteId: buildState.siteId },
    });
    // If the server didn't re-wire forms (no notify email on hand), keep the
    // existing form wiring from the previous version.
    const newHtml = buildState.notifyEmail ? res.html : preserveForms(buildState.html, res.html);
    buildState.html = newHtml;
    swapFrame($('#build-frame'), newHtml);
    reportSlop(newHtml, '#build-slop', buildState.facts);
    $('#build-link-output').hidden = true; // any earlier link now points at the old version
    toast('Change applied — save a new link to share this version');
    return true;
  } catch (err) {
    toast(err.message, true);
    return false;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// Delegated so it keeps working after the warning box is rewritten.
$('#build-slop').addEventListener('click', (e) => {
  if (!e.target.closest('[data-act="fix-slop"]')) return;
  const r = checkSite(buildState.html, buildState.facts);
  const asks = r.fix.map((f) => f.ask).filter(Boolean);
  if (!asks.length) { reportSlop(buildState.html, '#build-slop', buildState.facts); return; }
  asks.push('Change nothing else. Keep the layout, the structure, every other word, the contact form, the phone links and the head metadata exactly as they are.');
  runBuildRefine(asks.join(' '), e.target, 'Fixing…');
});

$('#build-refine-btn').addEventListener('click', () => {
  const instruction = $('#build-refine-input').value.trim();
  if (!instruction) { toast('Type what you want changed first', true); return; }
  // Only clear the box on success — a failed refine used to wipe what you typed.
  runBuildRefine(instruction, $('#build-refine-btn'), 'Refining…').then((ok) => {
    if (ok) $('#build-refine-input').value = '';
  });
});

$('#build-enhance')?.addEventListener('click', () => {
  runBuildRefine(ENHANCE_INSTRUCTION, $('#build-enhance'), 'Enhancing…');
});

// Multi-page: refine the page currently being viewed.
async function runMultiRefine(instruction, btn, busyLabel) {
  const cur = multiState.current;
  if (!cur || !multiState.pages[cur]) { toast('Generate or open a site first', true); return false; }
  if (!instruction) { toast('Type what you want changed first', true); return false; }

  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = busyLabel;
  if (!multiState.siteId) multiState.siteId = extractSiteId(multiState.pages[cur]) || newSiteId();
  try {
    const res = await api('/api/generate', {
      method: 'POST',
      body: { mode: 'refine', html: multiState.pages[cur], instruction, notifyEmail: multiState.notifyEmail || '', siteId: multiState.siteId },
    });
    multiState.pages[cur] = multiState.notifyEmail ? res.html : preserveForms(multiState.pages[cur], res.html);
    showMultiPage(cur);
    $('#multi-link-output').hidden = true;
    const title = multiState.defs.find((d) => d.filename === cur)?.title || cur;
    toast(`“${title}” updated — save a new link to share it`);
    return true;
  } catch (err) {
    toast(err.message, true);
    return false;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

$('#multi-refine-btn').addEventListener('click', () => {
  const instruction = $('#multi-refine-input').value.trim();
  if (!instruction) { toast('Type what you want changed first', true); return; }
  runMultiRefine(instruction, $('#multi-refine-btn'), 'Refining…').then((ok) => {
    if (ok) $('#multi-refine-input').value = '';
  });
});

$('#multi-enhance')?.addEventListener('click', () => {
  runMultiRefine(ENHANCE_INSTRUCTION, $('#multi-enhance'), 'Enhancing…');
});

// ---- "Add their info": paste what the owner told you, straight into the site ----
// Pre-built demos are made from whatever Google knew, which is thin — a name, a
// phone, an address. Once the owner actually talks to you, this folds their real
// details in without you having to describe every change by hand.

const clientInfoState = { target: 'build' };

function clientInfoInstruction(raw) {
  const info = String(raw).trim().slice(0, 6000);
  return `The business has now given us their real details. Update this page to use them.

Here is exactly what they said, verbatim:
"""
${info}
"""

How to apply it:
- Use ONLY facts stated above. Do not invent, embellish, guess or infer anything that is not written there. If they did not mention it, do not add it.
- Where the page currently shows placeholder, generic or guessed content that the text above corrects — services offered, opening hours, years in business, owner or staff names, service area, specialities, certifications, guarantees, pricing — replace it with what they actually said.
- Work genuinely new information into the sections where it naturally belongs. Only add a brand-new section if something important has nowhere sensible to go.
- Update the LocalBusiness JSON-LD block to match: openingHours, address, telephone, areaServed — but only for values actually given above.
- Where their information contradicts what is currently on the page, their information wins.
- Testimonials stay generic unless real reviews were included above. Never turn a fact into a fake quote.

Do NOT change the visual design. Same colours, fonts, layout, section order, images, spacing and styling. This is a content update, not a redesign. Keep the contact form, phone links, map embed, footer and all head metadata working exactly as they are.

Return the complete updated HTML document.`;
}

function openClientInfo(target) {
  if (target === 'build' && !buildState.html) { toast('Generate a site first', true); return; }
  if (target === 'multi' && !(multiState.current && multiState.pages[multiState.current])) {
    toast('Generate or open a site first', true); return;
  }
  clientInfoState.target = target;
  const pages = target === 'multi' ? Object.keys(multiState.pages).length : 1;
  $('#clientinfo-sub').textContent = pages > 1
    ? `Paste whatever the owner told you — hours, services, how long they've been open, anything. It updates all ${pages} pages, so it uses ${pages} credits.`
    : "Paste whatever the owner told you — hours, services, how long they've been open, anything. It goes into the site and replaces the guessed bits. Uses 1 credit.";
  $('#clientinfo-error').hidden = true;
  $('#clientinfo-text').value = '';
  $('#clientinfo-modal').hidden = false;
  $('#clientinfo-text').focus();
}

async function applyClientInfo() {
  const raw = $('#clientinfo-text').value.trim();
  const errEl = $('#clientinfo-error');
  if (raw.length < 15) {
    errEl.textContent = 'Paste a bit more — a line or two at least, so there is something to work with.';
    errEl.hidden = false;
    return;
  }
  const instruction = clientInfoInstruction(raw);
  const target = clientInfoState.target;
  $('#clientinfo-modal').hidden = true;

  if (target === 'build') {
    const ok = await runBuildRefine(instruction, $('#build-info'), 'Adding their info…');
    if (ok) toast('Their details are in — read it over and check nothing is wrong');
    return;
  }

  const filenames = Object.keys(multiState.pages);
  if (!confirm(`Add their info to all ${filenames.length} pages? This uses ${filenames.length} credits — one per page.`)) return;

  const btn = $('#multi-info');
  const label = btn.textContent;
  btn.disabled = true;
  if (!multiState.siteId) multiState.siteId = extractSiteId(multiState.pages[filenames[0]]) || newSiteId();

  let done = 0;
  let failed = 0;
  try {
    for (const filename of filenames) {
      btn.textContent = `Updating ${done + 1}/${filenames.length}…`;
      try {
        const res = await api('/api/generate', {
          method: 'POST',
          body: {
            mode: 'refine',
            html: multiState.pages[filename],
            instruction,
            notifyEmail: multiState.notifyEmail || '',
            siteId: multiState.siteId,
          },
        });
        multiState.pages[filename] = multiState.notifyEmail
          ? res.html
          : preserveForms(multiState.pages[filename], res.html);
      } catch (err) {
        failed++;
        toast(`${filename}: ${err.message}`, true);
      }
      done++;
    }
    showMultiPage(multiState.current);
    $('#multi-link-output').hidden = true;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }

  if (failed === filenames.length) toast('Nothing was updated — the site is unchanged', true);
  else toast(failed
    ? `Updated, but ${failed} page${failed === 1 ? '' : 's'} failed — try those again`
    : `All ${filenames.length} pages updated with their details`);
}

$('#build-info')?.addEventListener('click', () => openClientInfo('build'));
$('#multi-info')?.addEventListener('click', () => openClientInfo('multi'));
$('#clientinfo-apply')?.addEventListener('click', applyClientInfo);
$('#clientinfo-cancel')?.addEventListener('click', () => { $('#clientinfo-modal').hidden = true; });
$('#clientinfo-close')?.addEventListener('click', () => { $('#clientinfo-modal').hidden = true; });
$('#clientinfo-modal')?.addEventListener('click', (e) => {
  if (e.target === $('#clientinfo-modal')) $('#clientinfo-modal').hidden = true;
});

// ---- Style picker: swap a finished site's whole look ----
// Built for the sales moment — show the demo, let the client say "not my
// colours", and change the entire look in front of them.

const styleState = { target: 'build', current: { build: null, multi: null } };

function renderStyleGrid(filter = '') {
  const q = filter.trim().toLowerCase();
  const matches = ART_STYLES.filter((s) =>
    !q || s.name.toLowerCase().includes(q) || s.blurb.toLowerCase().includes(q) || s.group.toLowerCase().includes(q));
  const grid = $('#style-grid');

  if (!matches.length) {
    grid.innerHTML = '<p class="muted">No styles match that.</p>';
    return;
  }

  const active = styleState.current[styleState.target];
  grid.innerHTML = STYLE_GROUPS
    .map((group) => {
      const inGroup = matches.filter((s) => s.group === group);
      if (!inGroup.length) return '';
      return `<div class="style-group-label">${escapeHtml(group)}</div>` + inGroup.map((s) => `
        <button type="button" class="style-card${s.key === active ? ' is-current' : ''}" data-style="${s.key}">
          <span class="style-swatch" aria-hidden="true">
            ${s.swatch.map((c) => `<i style="background:${escapeHtml(c)}"></i>`).join('')}
          </span>
          <span class="style-text">
            <strong>${escapeHtml(s.name)}</strong>
            <small>${escapeHtml(s.blurb)}</small>
          </span>
          ${s.key === active ? '<span class="style-current-tag">Current</span>' : ''}
        </button>`).join('');
    })
    .join('');

  grid.querySelectorAll('.style-card').forEach((card) => {
    card.addEventListener('click', () => applyStyle(card.dataset.style));
  });
}

function openStyleModal(target) {
  if (target === 'build' && !buildState.html) { toast('Generate a site first', true); return; }
  if (target === 'multi' && !(multiState.current && multiState.pages[multiState.current])) {
    toast('Generate or open a site first', true); return;
  }
  styleState.target = target;
  const pageCount = target === 'multi' ? Object.keys(multiState.pages).length : 1;
  $('#style-modal-sub').textContent = pageCount > 1
    ? `The words, photos and sections stay the same — only the look changes. This restyles all ${pageCount} pages, so it uses ${pageCount} credits.`
    : 'The words, photos and sections stay exactly the same — only the look changes. Uses 1 credit.';
  $('#style-search').value = '';
  renderStyleGrid();
  $('#style-modal').hidden = false;
}

async function applyStyle(key) {
  const style = styleByKey(key);
  if (!style) return;
  const target = styleState.target;
  $('#style-modal').hidden = true;

  if (target === 'build') {
    const btn = $('#build-style');
    const ok = await runBuildRefine(styleInstruction(style), btn, 'Restyling…');
    // On failure runBuildRefine has already said why — don't overwrite that
    // with a success message, and don't mark a style the site isn't in.
    if (!ok) return;
    styleState.current.build = key;
    toast(`Restyled — ${style.name}`);
    return;
  }

  // Multi-page: every page has to change or the site stops matching itself.
  const filenames = Object.keys(multiState.pages);
  if (!confirm(`Restyle all ${filenames.length} pages to "${style.name}"? This uses ${filenames.length} credits — one per page.`)) return;

  const btn = $('#multi-style');
  const label = btn.textContent;
  btn.disabled = true;
  if (!multiState.siteId) multiState.siteId = extractSiteId(multiState.pages[filenames[0]]) || newSiteId();

  let done = 0;
  let failed = 0;
  try {
    for (const filename of filenames) {
      btn.textContent = `Restyling ${done + 1}/${filenames.length}…`;
      try {
        const res = await api('/api/generate', {
          method: 'POST',
          body: {
            mode: 'refine',
            html: multiState.pages[filename],
            instruction: styleInstruction(style),
            notifyEmail: multiState.notifyEmail || '',
            siteId: multiState.siteId,
          },
        });
        multiState.pages[filename] = multiState.notifyEmail
          ? res.html
          : preserveForms(multiState.pages[filename], res.html);
      } catch (err) {
        failed++;
        toast(`${filename}: ${err.message}`, true);
      }
      done++;
    }

    // If every page failed the site is untouched, so don't record the style.
    if (failed < filenames.length) styleState.current.multi = key;
    showMultiPage(multiState.current);
    $('#multi-link-output').hidden = true;
  } finally {
    // Always give the button back, even if rendering threw — otherwise it
    // stays stuck on "Restyling 3/4…" until the page is reloaded.
    btn.disabled = false;
    btn.textContent = label;
  }

  if (failed === filenames.length) {
    toast('Restyle failed — the site is unchanged', true);
  } else {
    toast(failed
      ? `Restyled, but ${failed} page${failed === 1 ? '' : 's'} failed — try those again`
      : `All ${filenames.length} pages restyled — ${style.name}`);
  }
}

$('#build-style')?.addEventListener('click', () => openStyleModal('build'));
$('#multi-style')?.addEventListener('click', () => openStyleModal('multi'));
$('#style-search')?.addEventListener('input', (e) => renderStyleGrid(e.target.value));
$('#style-modal-close')?.addEventListener('click', () => { $('#style-modal').hidden = true; });
$('#style-modal-cancel')?.addEventListener('click', () => { $('#style-modal').hidden = true; });
$('#style-modal')?.addEventListener('click', (e) => {
  if (e.target === $('#style-modal')) $('#style-modal').hidden = true;
});

// ------------------------------------------------- Device preview toggle

function wireDevice(toggleId, frameId) {
  const toggle = $(toggleId);
  if (!toggle) return;
  toggle.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      toggle.querySelectorAll('button').forEach((x) => x.classList.toggle('is-active', x === b));
      $(frameId).classList.toggle('is-mobile', b.dataset.device === 'mobile');
    });
  });
}
wireDevice('#build-device', '#build-frame');
wireDevice('#multi-device', '#multi-frame');

// ------------------------------------------------- Proposal / Invoice

const INVOICE_FROM_KEY = 'forge-invoice-from';
let invoiceDocHtml = '';

async function initInvoice() {
  if (!$('#inv-date').value) $('#inv-date').value = localToday();
  try {
    const saved = JSON.parse(localStorage.getItem(INVOICE_FROM_KEY) || '{}');
    if (saved.name && !$('#inv-from-name').value) $('#inv-from-name').value = saved.name;
    if (saved.contact && !$('#inv-from-contact').value) $('#inv-from-contact').value = saved.contact;
  } catch { /* ignore */ }

  if (!clientState.clients.length) {
    try { await loadClients(); } catch { /* ignore */ }
  }
  const sel = $('#inv-client');
  const chosen = sel.value;
  sel.innerHTML = '<option value="">— none —</option>' +
    clientState.clients.map((c) => `<option value="${c.id}">${escapeHtml(c.companyName)}</option>`).join('');
  sel.value = chosen;
}

$('#inv-client').addEventListener('change', () => {
  const c = clientState.clients.find((x) => x.id === Number($('#inv-client').value));
  if (!c) return;
  $('#inv-to-name').value = c.companyName;
  $('#inv-to-contact').value = c.ownerName || '';
  $('#inv-to-email').value = c.email || c.phone || '';
  $('#inv-upfront').value = c.amountPaid || 0;
  $('#inv-monthly').value = c.monthlyFee || 0;
});

function buildInvoiceDoc(d) {
  const heading = d.type === 'invoice' ? 'Invoice' : 'Proposal';
  const rows = [];
  if (d.upfront > 0) rows.push(['One-time', escapeHtml(d.desc), money(d.upfront)]);
  if (d.monthly > 0) rows.push(['Recurring', 'Website maintenance &amp; hosting', `${money(d.monthly)} / month`]);
  if (!rows.length) rows.push(['One-time', escapeHtml(d.desc), money(0)]);
  const rowHtml = rows.map((r) => `<tr><td class="k">${r[0]}</td><td>${r[1]}</td><td class="amt">${r[2]}</td></tr>`).join('');
  const dueLine = d.upfront > 0 ? `<div class="due">Due today: <strong>${money(d.upfront)}</strong></div>` : '';
  const notes = d.notes ? `<div class="notes"><h4>Notes</h4><p>${escapeHtml(d.notes).replace(/\n/g, '<br>')}</p></div>` : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${heading} — ${escapeHtml(d.toName)}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:Georgia,'Times New Roman',serif;color:#1a1a1a;background:#fff;margin:0;padding:48px;line-height:1.5}
  .doc{max-width:720px;margin:0 auto}
  .top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #c2410c;padding-bottom:18px;margin-bottom:26px}
  .brand{font-size:1.4rem;font-weight:bold}
  .brand small{display:block;font-size:0.8rem;color:#666;font-weight:normal;margin-top:4px}
  h1{font-size:1.9rem;margin:0;color:#c2410c;letter-spacing:0.02em;text-align:right}
  .meta{text-align:right;font-size:0.9rem;color:#555;margin-top:4px}
  .parties{margin-bottom:26px;font-size:0.95rem}
  .parties h4{margin:0 0 4px;font-size:0.72rem;text-transform:uppercase;letter-spacing:0.08em;color:#999}
  table{width:100%;border-collapse:collapse;margin-bottom:14px}
  th,td{text-align:left;padding:11px 10px;border-bottom:1px solid #e6e6e6}
  th{font-size:0.72rem;text-transform:uppercase;letter-spacing:0.06em;color:#999}
  td.k{color:#999;font-size:0.82rem;width:96px}
  td.amt,th.amt{text-align:right;white-space:nowrap;font-weight:bold}
  .due{text-align:right;font-size:1.1rem;margin-top:8px}
  .notes{margin-top:26px;font-size:0.9rem;color:#444}
  .notes h4{font-size:0.72rem;text-transform:uppercase;letter-spacing:0.08em;color:#999;margin:0 0 6px}
  .foot{margin-top:44px;padding-top:16px;border-top:1px solid #e6e6e6;font-size:0.85rem;color:#999;text-align:center}
  @media print{body{padding:0}}
</style></head><body><div class="doc">
  <div class="top">
    <div class="brand">${escapeHtml(d.fromName)}${d.fromContact ? `<small>${escapeHtml(d.fromContact)}</small>` : ''}</div>
    <div><h1>${heading}</h1><div class="meta">${escapeHtml(formatDate(d.date))}</div></div>
  </div>
  <div class="parties">
    <h4>${d.type === 'invoice' ? 'Bill to' : 'Prepared for'}</h4>
    ${escapeHtml(d.toName)}${d.toContact ? `<br>${escapeHtml(d.toContact)}` : ''}${d.toEmail ? `<br>${escapeHtml(d.toEmail)}` : ''}
  </div>
  <table><thead><tr><th>Type</th><th>Description</th><th class="amt">Amount</th></tr></thead><tbody>${rowHtml}</tbody></table>
  ${dueLine}
  ${notes}
  <div class="foot">Thank you for your business.</div>
</div></body></html>`;
}

$('#invoice-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const data = {
    type: $('#inv-type').value,
    date: $('#inv-date').value || localToday(),
    fromName: $('#inv-from-name').value.trim() || 'Your Business',
    fromContact: $('#inv-from-contact').value.trim(),
    toName: $('#inv-to-name').value.trim() || 'Client',
    toContact: $('#inv-to-contact').value.trim(),
    toEmail: $('#inv-to-email').value.trim(),
    desc: $('#inv-desc').value.trim() || 'Website design & setup',
    upfront: Number($('#inv-upfront').value || 0),
    monthly: Number($('#inv-monthly').value || 0),
    notes: $('#inv-notes').value.trim(),
  };
  storeSet(INVOICE_FROM_KEY, JSON.stringify({ name: data.fromName, contact: data.fromContact }));
  invoiceDocHtml = buildInvoiceDoc(data);
  $('#inv-frame').srcdoc = invoiceDocHtml;
  $('#invoice-output').hidden = false;
  $('#invoice-output').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

$('#inv-print').addEventListener('click', () => {
  const w = $('#inv-frame').contentWindow;
  if (w) { w.focus(); w.print(); }
});
$('#inv-download').addEventListener('click', () => {
  if (invoiceDocHtml) downloadFile(`${$('#inv-type').value}.html`, invoiceDocHtml);
});

// ------------------------------------------------- Emails (maintenance / welcome)
// Client-side only, no AI call — pulls from clientState (same data the
// Clients tab uses) and the "from" name/contact already saved by Invoice.

const EMAIL_TEMPLATES = {
  maintenance: {
    label: 'Monthly maintenance fee',
    subject: (c) => `Monthly website maintenance — ${c.companyName}`,
    body: (c, from) => [
      `Hi ${c.ownerName || 'there'},`,
      '',
      `Just a friendly reminder that this month's website maintenance fee (${money(c.monthlyFee || 0)}) is due. This covers hosting, upkeep, and any small updates to ${c.companyName}'s site.`,
      '',
      "Let me know if you'd like anything changed while I'm in there!",
      '',
      'Thanks,',
      from.name + (from.contact ? `\n${from.contact}` : ''),
    ].join('\n'),
  },
  welcome: {
    label: 'First website / welcome',
    subject: (c) => `${c.companyName}'s new website is live!`,
    body: (c, from) => {
      const lines = [
        `Hi ${c.ownerName || 'there'},`,
        '',
        `Great news — ${c.companyName}'s new website is live! Take a look and let me know if you'd like anything changed.`,
        '',
      ];
      if (c.monthlyFee > 0) {
        lines.push(
          `Quick note: hosting & maintenance is ${money(c.monthlyFee)}/month, which covers updates and keeps everything running smoothly.`,
          ''
        );
      }
      lines.push("Thanks again for the opportunity to build this for you!", '', 'Thanks,', from.name + (from.contact ? `\n${from.contact}` : ''));
      return lines.join('\n');
    },
  },
};

const emailState = { type: null };
let currentEmailClient = null;

async function initEmails() {
  if (!clientState.clients.length) {
    try { await loadClients(); } catch { /* ignore */ }
  }
  $('#emails-empty').hidden = clientState.clients.length > 0;
}

function emailFromInfo() {
  const from = { name: 'Your Business', contact: '' };
  try {
    const saved = JSON.parse(localStorage.getItem(INVOICE_FROM_KEY) || '{}');
    if (saved.name) from.name = saved.name;
    if (saved.contact) from.contact = saved.contact;
  } catch { /* ignore */ }
  return from;
}

function openEmailPicker(type) {
  if (!clientState.clients.length) { toast('Add a client first — Clients tab', true); return; }
  emailState.type = type;
  const list = $('#email-client-list');
  list.innerHTML = clientState.clients.map((c) => `
    <button type="button" class="email-client-row" data-id="${c.id}">
      <strong>${escapeHtml(c.companyName)}</strong>
      <span>${escapeHtml(c.email || c.phone || 'no contact on file')}</span>
    </button>`).join('');
  list.querySelectorAll('.email-client-row').forEach((btn) => {
    btn.addEventListener('click', () => {
      const c = clientState.clients.find((x) => x.id === Number(btn.dataset.id));
      $('#email-client-modal').hidden = true;
      if (c) generateEmail(c);
    });
  });
  $('#email-client-modal').hidden = false;
}

function generateEmail(client) {
  const tpl = EMAIL_TEMPLATES[emailState.type];
  if (!tpl) return;
  const from = emailFromInfo();
  currentEmailClient = client;
  $('#email-output-title').textContent = `${tpl.label} — ${client.companyName}`;
  $('#email-subject').value = tpl.subject(client, from);
  $('#email-body').value = tpl.body(client, from);
  $('#email-body').dispatchEvent(new Event('input'));
  $('#email-output').hidden = false;
  $('#email-output').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('#email-type-maintenance').addEventListener('click', () => openEmailPicker('maintenance'));
$('#email-type-welcome').addEventListener('click', () => openEmailPicker('welcome'));
$('#email-client-modal-cancel').addEventListener('click', () => { $('#email-client-modal').hidden = true; });
$('#email-client-modal').addEventListener('click', (e) => {
  if (e.target === $('#email-client-modal')) $('#email-client-modal').hidden = true;
});

$('#email-copy').addEventListener('click', () => {
  copyText(`Subject: ${$('#email-subject').value.trim()}\n\n${$('#email-body').value}`);
});

$('#email-open-mail').addEventListener('click', () => {
  const to = (currentEmailClient && currentEmailClient.email) || '';
  const subject = $('#email-subject').value.trim();
  const body = $('#email-body').value;
  window.location.href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
});

$('#email-start-over').addEventListener('click', () => {
  $('#email-output').hidden = true;
  currentEmailClient = null;
});

// ---------------------------------------------------------------- theme

const THEME_KEY = 'forge-theme';

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = $('#theme-toggle');
  if (btn) btn.textContent = theme === 'light' ? '☀️' : '🌙';
}

// Restore the saved choice on load (default dark).
applyTheme(storeGet(THEME_KEY) === 'light' ? 'light' : 'dark');

$('#theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  storeSet(THEME_KEY, next);
  applyTheme(next);
});

// ------------------------------------------------- Download all (.zip)
// Minimal, dependency-free ZIP writer (store method, no compression). Local
// business sites are tiny, so skipping compression keeps the code small and
// the output is a fully valid .zip every OS opens.

function crc32(bytes) {
  let crc = ~0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
function concatBytes(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function makeZip(files) {
  const u16 = (n) => new Uint8Array([n & 255, (n >> 8) & 255]);
  const u32 = (n) => new Uint8Array([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]);
  const DOS_TIME = 0;
  const DOS_DATE = ((2021 - 1980) << 9) | (1 << 5) | 1; // 2021-01-01, a valid date so Windows is happy
  const enc = new TextEncoder();
  const locals = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = f.bytes;
    const crc = crc32(data);
    const local = concatBytes([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(DOS_TIME), u16(DOS_DATE),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0),
      name, data,
    ]);
    locals.push(local);
    central.push(concatBytes([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(DOS_TIME), u16(DOS_DATE),
      u32(crc), u32(data.length), u32(data.length), u16(name.length),
      u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name,
    ]));
    offset += local.length;
  }
  const centralBytes = concatBytes(central);
  const eocd = concatBytes([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(centralBytes.length), u32(offset), u16(0),
  ]);
  return concatBytes([...locals, centralBytes, eocd]);
}
function downloadBytes(filename, bytes, type) {
  const blob = new Blob([bytes], { type: type || 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

const btnDownloadAll = $('#multi-download-all');
if (btnDownloadAll) {
  btnDownloadAll.addEventListener('click', () => {
    const names = Object.keys(multiState.pages || {}).filter((n) => multiState.pages[n]);
    if (!names.length) { toast('Generate a site first', true); return; }
    const enc = new TextEncoder();
    const files = names.map((n) => ({ name: n, bytes: enc.encode(multiState.pages[n]) }));
    downloadBytes('site.zip', makeZip(files), 'application/zip');
    toast(`Downloaded all ${files.length} pages as site.zip`);
  });
}

// ------------------------------------------------- Replace photos
// Swap stock images for the client's real photos, entirely in the browser.
// Uploaded files are shrunk with a canvas so the page stays small/fast, then
// embedded as a data URI so the site stays self-contained after download.

function fileToResizedDataUrl(file, maxDim) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const scale = maxDim / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
    img.src = url;
  });
}

// photosTarget abstracts which builder (single-page or multi-page/current
// page) the modal is currently editing, so one modal + one code path serves
// both without duplicating the swap logic.
let photosTarget = null; // { getHtml(), setHtml(html), label }

function replaceImageAt(index, newSrc) {
  if (!photosTarget) return;
  const doc = new DOMParser().parseFromString(photosTarget.getHtml(), 'text/html');
  const imgs = doc.querySelectorAll('img');
  if (!imgs[index]) return;
  imgs[index].setAttribute('src', newSrc);
  const html = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
  photosTarget.setHtml(html);
  toast('Photo replaced — save a new link to share this version');
  renderPhotosList();
}

function renderPhotosList() {
  const doc = new DOMParser().parseFromString(photosTarget.getHtml(), 'text/html');
  const imgs = Array.from(doc.querySelectorAll('img'));
  const list = $('#photos-list');
  $('#photos-sub').textContent = photosTarget.label
    ? `Editing photos on: ${photosTarget.label}. Upload a photo or paste a link to replace any stock image — shrunk automatically so the site stays fast.`
    : 'Upload a photo from your computer or paste a link to replace any stock image. Photos are shrunk automatically so the site stays fast.';
  if (!imgs.length) {
    list.innerHTML = '<p class="muted">This page doesn\'t use any &lt;img&gt; photos to swap — its images may be CSS backgrounds. You can ask for a photo with the Refine box instead.</p>';
    return;
  }
  list.innerHTML = imgs.map((img, i) => `
    <div class="photo-row">
      <img class="photo-thumb" src="${escapeHtml(img.getAttribute('src') || '')}" alt="" loading="lazy">
      <div class="photo-ctl">
        <div class="photo-alt">${escapeHtml(img.getAttribute('alt') || '(no description)')}</div>
        <label class="btn btn-sm btn-primary">Upload a photo<input type="file" accept="image/*" hidden data-i="${i}"></label>
        <input type="url" class="photo-url" placeholder="…or paste an image link + press Enter" data-i="${i}">
      </div>
    </div>`).join('');
  list.querySelectorAll('input[type=file]').forEach((inp) => {
    inp.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const dataUrl = await fileToResizedDataUrl(file, 1600);
        replaceImageAt(Number(inp.dataset.i), dataUrl);
      } catch { toast('Could not read that image file', true); }
    });
  });
  list.querySelectorAll('input.photo-url').forEach((inp) => {
    inp.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const u = inp.value.trim();
      if (u) replaceImageAt(Number(inp.dataset.i), u);
    });
  });
}

function openPhotosForBuild() {
  if (!buildState.html) { toast('Generate a site first', true); return; }
  photosTarget = {
    getHtml: () => buildState.html,
    setHtml: (html) => {
      buildState.html = html;
      showInFrame($('#build-frame'), html);
      $('#build-link-output').hidden = true;
    },
    label: null,
  };
  renderPhotosList();
  $('#photos-modal').hidden = false;
}

function openPhotosForMulti() {
  const cur = multiState.current;
  if (!cur || !multiState.pages[cur]) { toast('Generate or open a site first', true); return; }
  const title = multiState.defs.find((d) => d.filename === cur)?.title || cur;
  photosTarget = {
    getHtml: () => multiState.pages[cur],
    setHtml: (html) => {
      multiState.pages[cur] = html;
      showMultiPage(cur);
      $('#multi-link-output').hidden = true;
    },
    label: `${title} page (switch pages behind this modal, then reopen Photos for another page)`,
  };
  renderPhotosList();
  $('#photos-modal').hidden = false;
}

$('#build-photos')?.addEventListener('click', openPhotosForBuild);
$('#multi-photos')?.addEventListener('click', openPhotosForMulti);
$('#photos-close')?.addEventListener('click', () => { $('#photos-modal').hidden = true; });
$('#photos-modal')?.addEventListener('click', (e) => {
  if (e.target === $('#photos-modal')) $('#photos-modal').hidden = true;
});

// ------------------------------------------------- Client handoff sheet
// A printable "how your website works" doc to hand a client at delivery.
// Pure client-side (no AI cost), pulls your own name/contact from the same
// place the invoice tool saves it.

function businessNameFromHtml(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html || '');
  return (m ? m[1] : '').trim().replace(/\s+/g, ' ') || 'Your new website';
}
function buildHandoffDoc(businessName) {
  let from = { name: 'Your web designer', contact: '' };
  try {
    const saved = JSON.parse(localStorage.getItem(INVOICE_FROM_KEY) || '{}');
    if (saved.name) from = { name: saved.name, contact: saved.contact || '' };
  } catch { /* ignore */ }
  const contactLine = from.contact
    ? `${escapeHtml(from.name)} — ${escapeHtml(from.contact)}`
    : escapeHtml(from.name);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your website — quick guide</title>
<style>
  *{box-sizing:border-box}
  body{font-family:Georgia,'Times New Roman',serif;color:#1a1a1a;background:#fff;margin:0;padding:48px;line-height:1.6}
  .doc{max-width:720px;margin:0 auto}
  h1{color:#c2410c;font-size:1.9rem;margin:0 0 4px;border-bottom:3px solid #c2410c;padding-bottom:14px}
  .sub{color:#666;margin:0 0 26px}
  h2{font-size:1.15rem;margin:26px 0 6px}
  p{margin:6px 0}
  ol{margin:6px 0 6px 20px}
  .box{background:#f7f4f0;border:1px solid #e6ddd3;border-radius:8px;padding:16px 18px;margin:14px 0}
  .foot{margin-top:40px;padding-top:16px;border-top:1px solid #e6e6e6;color:#666;font-size:0.9rem}
  @media print{body{padding:0}}
</style></head><body><div class="doc">
  <h1>${escapeHtml(businessName)}</h1>
  <p class="sub">A quick guide to your new website — please keep this handy.</p>

  <h2>📬 Your contact form</h2>
  <p>When someone fills out the contact form on your site, the message is emailed straight to you — no app or login needed.</p>
  <div class="box">
    <strong>One-time setup (important):</strong> the very first time your form is used, you'll get a single email titled <em>"Confirm your email"</em>. Click the button inside it once to switch your form on. After that, every message arrives automatically. If you don't see it, check your spam folder.
  </div>

  <h2>📱 Sharing your site</h2>
  <p>Your website works on phones, tablets, and computers. Share the link on your Google listing, Facebook, business cards, and anywhere customers find you.</p>

  <h2>✏️ Need a change?</h2>
  <p>Want to update your hours, add a photo, change your prices, or add a page? Just reach out — changes are quick and easy.</p>
  <div class="box">Your website was built and is maintained by:<br><strong>${contactLine}</strong></div>

  <div class="foot">Thank you for your business. Here's to more customers finding you online. 🚀</div>
</div></body></html>`;
}
function openHandoff(businessName) {
  const doc = buildHandoffDoc(businessName);
  const w = window.open('', '_blank');
  if (w) { w.document.write(doc); w.document.close(); toast('Client sheet opened — Print or Save as PDF to hand over'); }
  else { downloadFile('client-website-guide.html', doc); toast('Client sheet downloaded'); }
}
$('#build-handoff')?.addEventListener('click', () => {
  if (!buildState.html) { toast('Generate a site first', true); return; }
  openHandoff(businessNameFromHtml(buildState.html));
});
$('#multi-handoff')?.addEventListener('click', () => {
  const home = multiState.pages && multiState.pages['index.html'];
  if (!home) { toast('Generate a site first', true); return; }
  openHandoff(businessNameFromHtml(home));
});

// ------------------------------------------------- Go Live helper
function openInfo(bodyHtml) {
  $('#info-body').innerHTML = bodyHtml;
  $('#info-modal').hidden = false;
}
$('#golive-btn')?.addEventListener('click', () => openInfo(`
  <h2>🚀 Putting a finished site online</h2>
  <p class="muted">The 5 steps to take a site you've sold and make it live on the internet.</p>
  <ol class="golive-steps">
    <li><strong>Get the files.</strong> Open the site and click <em>Download HTML</em> (or <em>Download all (.zip)</em> for a multi-page site).</li>
    <li><strong>Get the domain.</strong> Either use the client's existing domain, or buy one — easiest inside Cloudflare (Domain Registration), sold at cost.</li>
    <li><strong>Upload the files.</strong> In Cloudflare → <em>Workers &amp; Pages</em> → <em>Create</em> → <em>Pages</em> → <em>Upload assets</em>. Drag the file(s) in and deploy — it goes live on a free <em>*.pages.dev</em> link.</li>
    <li><strong>Connect the domain.</strong> In that project → <em>Custom domains</em> → <em>Set up a domain</em> → type the client's domain. If it was bought at Cloudflare, this is basically one click.</li>
    <li><strong>Done.</strong> It's on the real internet. Each new client = repeat these 5 steps in a new project.</li>
  </ol>
  <p class="muted" style="margin-top:14px">Stuck on a real one? Come back and I'll walk you through it screen by screen.</p>
`));
$('#info-close')?.addEventListener('click', () => { $('#info-modal').hidden = true; });
$('#info-modal')?.addEventListener('click', (e) => {
  if (e.target === $('#info-modal')) $('#info-modal').hidden = true;
});

// ---------------------------------------------------------------- boot

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    $('#client-modal').hidden = true;
    $('#prospect-modal').hidden = true;
    $('#detail-modal').hidden = true;
    $('#photos-modal').hidden = true;
    $('#info-modal').hidden = true;
    $('#money-modal').hidden = true;
    $('#email-client-modal').hidden = true;
    $('#style-modal').hidden = true;
    $('#clientinfo-modal').hidden = true;
    $('#paymethod-cancel')?.click(); // resolves its pending promise, then closes
  }
});
// Note: #batch-modal is deliberately excluded from Escape — closing it early
// while a batch is mid-run should be a deliberate Cancel click, not a stray key.
