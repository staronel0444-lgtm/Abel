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

function localToday() {
  return new Date().toLocaleDateString('sv'); // YYYY-MM-DD
}
function localCurrentMonth() {
  return localToday().slice(0, 7); // YYYY-MM
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

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok) {
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
  return data;
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
  return cleaned.includes('</body>') ? cleaned.replace('</body>', `${m[0]}</body>`) : cleaned + m[0];
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

const panels = ['build', 'multi', 'sites', 'leads', 'history', 'clients', 'revenue', 'invoice', 'traffic', 'money'];

function switchTab(name) {
  for (const p of panels) {
    $(`#panel-${p}`).classList.toggle('is-active', p === name);
  }
  document.querySelectorAll('.tab-btn').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.tab === name);
  });
  if (name === 'sites') loadSites();
  if (name === 'history') loadHistory();
  if (name === 'clients') loadClients();
  if (name === 'revenue') loadRevenue();
  if (name === 'invoice') initInvoice();
  if (name === 'traffic') loadTraffic();
  if (name === 'money') loadMoney();
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

// My Sites gallery — backed by the same saved previews, shown as live
// thumbnails with open-in-builder / copy / delete.
async function loadSites() {
  const grid = $('#sites-grid');
  try {
    const { previews } = await api('/api/previews');
    $('#sites-empty').hidden = previews.length > 0;
    grid.innerHTML = previews.map((p) => `
      <div class="site-card" data-id="${escapeHtml(p.id)}" data-kind="${escapeHtml(p.kind)}" data-url="${escapeHtml(p.url)}">
        <div class="site-thumb"><iframe src="${escapeHtml(p.url)}" scrolling="no" tabindex="-1" title="preview"></iframe></div>
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
            buildState.placeId = null;
            buildState.siteId = extractSiteId(data.html) || null;
            $('#build-frame').srcdoc = data.html;
            $('#build-frame').classList.remove('is-mobile');
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

const buildState = { html: null, placeId: null, notifyEmail: '', siteId: null };

async function generateSingle(prompt, placeId = null) {
  const errEl = $('#build-error');
  errEl.hidden = true;
  $('#build-result').hidden = true;
  $('#build-link-output').hidden = true;
  $('#build-loading').hidden = false;
  $('#build-generate').disabled = true;

  const notifyEmail = ($('#build-notify-email')?.value || '').trim();
  const siteId = newSiteId();
  try {
    const context = extractKeywords(prompt);
    const res = await api('/api/generate', {
      method: 'POST',
      body: { mode: 'page', prompt, context, notifyEmail, siteId },
    });
    buildState.html = res.html;
    buildState.placeId = placeId;
    buildState.notifyEmail = notifyEmail;
    buildState.siteId = siteId;
    $('#build-frame').srcdoc = res.html;
    $('#build-result').hidden = false;
    toast('Site generated');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  } finally {
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
    $('#build-frame').srcdoc = res.html;
    $('#build-link-output').hidden = true;
    toast('Contact email set — free, no credits used');
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

// ---- Prompt helper: paste raw business info -> a strong prompt (no AI, free).
function makePromptFromInfo(raw, { multiPage = false } = {}) {
  const text = String(raw || '').replace(/\r/g, '').trim();
  if (!text) return '';
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  let name = (lines[0] || 'this business').replace(/\s+/g, ' ').slice(0, 120);
  // Strip a trailing rating/review count if it landed on the name line.
  name = name.replace(/\s+[0-5](\.\d)?\s*(★|stars?)?\s*\(?[\d,]+\)?\s*(reviews?)?\s*$/i, '').trim() || name;

  const phone = (text.match(/(\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4})/) || [])[1];
  const email = (text.match(/[\w.+-]+@[\w-]+\.[\w.]+/) || [])[0];
  const loc = (text.match(/\b([A-Z][A-Za-z .'\-]+,\s*[A-Z]{2})\b/) || [])[1];
  const rating = (text.match(/\b([0-5](?:\.\d)?)\s*(?:★|stars?\b)/i) || [])[1]
    || (text.match(/\b([1-5]\.\d)\b/) || [])[1];
  const reviews = (text.match(/([\d,]{1,7})\s*(?:reviews?|ratings?)/i) || [])[1]
    || (text.match(/\(([\d,]{2,7})\)/) || [])[1];

  const kind = multiPage ? 'multi-page website (with separate pages for things like About, Services, and Contact)' : 'single-page website';
  const thing = multiPage ? 'site' : 'page';
  const bits = [];
  bits.push(`Create a professional, modern, mobile-friendly ${kind} for ${name}${loc ? `, located in ${loc}` : ''}.`);
  if (phone) bits.push(`Feature the phone number ${phone} prominently in the header with a click-to-call button.`);
  if (rating && reviews) bits.push(`Highlight their ${rating}-star rating from ${reviews} reviews as social proof in a testimonials section.`);
  else if (rating) bits.push(`Highlight their ${rating}-star rating as social proof.`);
  if (email) bits.push(`Show the email ${email} in the contact section.`);
  bits.push(`Include a strong hero with a clear call to action, a services section, a why-choose-us section (local, trusted, reliable), a "find us" section with a map if there's an address, and a contact section with a quote-request form.`);
  bits.push(`Use a clean, professional color scheme that fits the business (the colors can be fine-tuned later). The goal of the ${thing} is to make the phone ring.`);

  const details = `\n\nUse these real business details for accurate, specific copy — do not invent facts:\n${text}`;
  return (bits.join(' ') + details).slice(0, 5800);
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
  return html.includes('</body>') ? html.replace('</body>', shim + '</body>') : html + shim;
}

window.addEventListener('message', (e) => {
  if (e.data && e.data.forgePage && multiState.pages[e.data.forgePage]) {
    showMultiPage(e.data.forgePage);
  }
});

function showMultiPage(filename) {
  multiState.current = filename;
  $('#multi-frame').srcdoc = withNavShim(multiState.pages[filename]);
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
  const siteId = newSiteId();
  multiState.siteId = siteId;

  try {
    // Pass 1 — one shared brand/style summary for the whole site.
    $('#multi-status').textContent = 'Locking the brand direction for the whole site…';
    const brandRes = await api('/api/generate', {
      method: 'POST',
      body: { mode: 'brand', prompt, pages: defs },
    });

    // Pass 2 — every page gets the same brand brief, so styling/tone/nav
    // stay consistent across the site.
    $('#multi-status').textContent = `Generating ${defs.length} pages with a shared brand…`;
    const context = extractKeywords(prompt);
    const results = await Promise.allSettled(defs.map((page) =>
      api('/api/generate', {
        method: 'POST',
        body: { mode: 'page', prompt, context, brand: brandRes.brand, page, pages: defs, notifyEmail, siteId },
      }).then((res) => {
        statuses[page.filename] = 'done';
        setProgress(defs, statuses);
        return { page, html: res.html };
      }).catch((err) => {
        statuses[page.filename] = 'fail';
        setProgress(defs, statuses);
        throw Object.assign(err, { page });
      })
    ));

    const failed = results.filter((r) => r.status === 'rejected');
    const pages = {};
    for (const r of results) {
      if (r.status === 'fulfilled') pages[r.value.page.filename] = r.value.html;
    }

    if (failed.length) {
      const names = failed.map((r) => r.reason.page.title).join(', ');
      throw new Error(`${failed.length} page(s) failed (${names}): ${failed[0].reason.message}`);
    }

    multiState.pages = pages;
    multiState.defs = defs;
    renderMultiResult();
    toast('Site generated — all pages share one brand');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  } finally {
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

const leadState = { niche: '', leads: [] };

function resolveNiche() {
  const sel = $('#lead-niche').value;
  if (sel !== '__other') return sel;
  return $('#lead-niche-other').value.trim();
}

$('#lead-niche').addEventListener('change', () => {
  $('#lead-niche-other').hidden = $('#lead-niche').value !== '__other';
});

// Auto-generated prompt in the exact format Sections 1/2 consume — built
// from the structured lead fields instead of pasted text.
function buildLeadPrompt(lead, niche) {
  const bits = [];
  bits.push(`Create a professional single-page website for ${lead.name}, a ${niche} business located at ${lead.address || 'a local service area'}.`);
  if (lead.phone) bits.push(`Their phone number is ${lead.phone} — feature it prominently in the header and a click-to-call button.`);
  if (lead.rating && lead.reviewCount) {
    bits.push(`They have a ${lead.rating}-star rating across ${lead.reviewCount} Google reviews — highlight this as social proof with a testimonials section.`);
  }
  bits.push(`Include: a strong hero with a clear call to action, a services section typical for a ${niche}, a why-choose-us section (licensed, local, responsive), and a contact section with a quote-request form.`);
  bits.push(`Tone: trustworthy local ${niche}. The goal of the page is to make the phone ring.`);
  return bits.join(' ');
}

function leadCardHtml(lead, niche, status = 'undecided') {
  const prompt = buildLeadPrompt(lead, niche);
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
      <h3>${escapeHtml(lead.name)}</h3>
      ${badge}
    </div>
    <div class="lead-meta">
      ${lead.category ? `<div>${escapeHtml(lead.category)}</div>` : ''}
      ${lead.address ? `<div>${escapeHtml(lead.address)}</div>` : ''}
      ${lead.phone ? `<div>${escapeHtml(lead.phone)}</div>` : ''}
      ${rating}
    </div>
    <div class="lead-prompt">
      <h4>Auto-generated prompt</h4>
      <p>${escapeHtml(prompt)}</p>
    </div>
    <div class="lead-generate">
      <button class="btn btn-primary" data-act="generate">Generate site</button>
    </div>
    ${decide}`;
}

// Wire up a rendered card's buttons. onDecided(newStatus) lets the caller
// decide what happens after (search results remove the card; History
// re-renders in place so the choice stays visible and changeable).
function wireLeadCard(cardEl, lead, niche, onDecided) {
  const genBtn = cardEl.querySelector('[data-act="generate"]');
  if (genBtn) {
    genBtn.addEventListener('click', () => {
      const prompt = buildLeadPrompt(lead, niche);
      $('#build-prompt').value = prompt;
      $('#build-prompt').dispatchEvent(new Event('input'));
      switchTab('build');
      generateSingle(prompt, lead.placeId);
    });
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

function renderLeadResults(leads, niche) {
  const grid = $('#lead-results');
  grid.innerHTML = '';
  for (const lead of leads) {
    const card = document.createElement('article');
    card.className = 'lead-card';
    card.innerHTML = leadCardHtml(lead, niche, 'undecided');
    wireLeadCard(card, lead, niche, (newStatus) => {
      if (newStatus === 'client' || newStatus === 'no') {
        // Decided → drops out of the active results.
        card.classList.add('is-leaving');
        setTimeout(() => {
          card.remove();
          if (!grid.children.length) $('#lead-empty').hidden = false;
        }, 350);
      }
    });
    grid.appendChild(card);
  }
}

$('#lead-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const zip = $('#lead-zip').value.trim();
  const niche = resolveNiche();
  const errEl = $('#lead-error');
  errEl.hidden = true;
  $('#lead-empty').hidden = true;
  $('#lead-stats').hidden = true;
  $('#lead-results').innerHTML = '';

  if (!zip) { errEl.textContent = 'Enter a ZIP code or address.'; errEl.hidden = false; return; }
  if (!niche) { errEl.textContent = 'Pick a niche (or type a custom one).'; errEl.hidden = false; return; }

  $('#lead-loading').hidden = false;
  $('#lead-search-btn').disabled = true;
  try {
    const res = await api('/api/leads/search', { method: 'POST', body: { zip, niche } });
    leadState.niche = niche;
    leadState.leads = res.leads;

    const s = res.stats;
    $('#lead-stats').textContent =
      `${s.total} businesses found · ${s.withWebsite} already have a website · ${s.dismissed} previously decided · ${res.leads.length} new lead${res.leads.length === 1 ? '' : 's'}`;
    $('#lead-stats').hidden = false;

    if (!res.leads.length) {
      $('#lead-empty').hidden = false;
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

// ------------------------------------------------- Section 3b: History

async function loadHistory() {
  const list = $('#history-list');
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

// ------------------------------------------------- Section 4: Clients

const clientState = { clients: [] };

function openClientModal({ mode, lead = null, client = null, onSaved = null }) {
  const modal = $('#client-modal');
  const form = $('#client-form');
  form.reset();
  $('#client-form-error').hidden = true;
  $('#cf-id').value = client ? client.id : '';
  $('#cf-place-id').value = lead ? lead.placeId : (client?.placeId || '');
  $('#cf-close-date').value = localToday();

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

  const payload = {
    companyName: $('#cf-company').value.trim(),
    ownerName: $('#cf-owner').value.trim(),
    email: $('#cf-email').value.trim(),
    phone: $('#cf-phone').value.trim(),
    address: $('#cf-address').value.trim(),
    amountPaid: Number($('#cf-amount').value || 0),
    monthlyFee: Number($('#cf-monthly').value || 0),
    closeDate: $('#cf-close-date').value,
  };

  const id = $('#cf-id').value;
  const placeId = $('#cf-place-id').value;
  $('#client-form-submit').disabled = true;
  try {
    if (id) {
      await api(`/api/clients/${id}`, { method: 'PUT', body: payload });
      toast('Client updated');
    } else {
      await api('/api/clients', { method: 'POST', body: { ...payload, placeId: placeId || undefined } });
      toast(placeId ? 'Client added — this lead won\'t show up in searches anymore' : 'Client added');
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

function isDueThisMonth(client, month) {
  if (!(client.monthlyFee > 0)) return false;
  const closeMonth = (client.closeDate || '').slice(0, 7);
  // Maintenance cycles start the month after close; upfront covers month 1.
  return month > closeMonth && !client.paidMonths.includes(month);
}

async function markPaid(client) {
  try {
    await api(`/api/clients/${client.id}/payments`, {
      method: 'POST',
      body: { month: localCurrentMonth() },
    });
    toast(`${client.companyName} marked paid for ${formatMonth(localCurrentMonth())}`);
    loadClients();
  } catch (err) {
    toast(err.message, true);
  }
}

function renderClients() {
  const month = localCurrentMonth();
  const due = clientState.clients.filter((c) => isDueThisMonth(c, month));

  const dueBox = $('#clients-due');
  if (due.length) {
    dueBox.hidden = false;
    dueBox.innerHTML = `
      <h3>Due this month — ${escapeHtml(formatMonth(month))} (${due.length})</h3>
      ${due.map((c) => `
        <div class="due-row" data-id="${c.id}">
          <span><strong>${escapeHtml(c.companyName)}</strong> · ${money(c.monthlyFee)}/mo${c.lastPaidMonth ? ` · last paid ${escapeHtml(formatMonth(c.lastPaidMonth))}` : ' · never paid yet'}</span>
          <button class="btn btn-sm btn-primary" data-act="paid">Mark this month paid</button>
        </div>`).join('')}`;
    dueBox.querySelectorAll('.due-row').forEach((row) => {
      const client = clientState.clients.find((c) => c.id === Number(row.dataset.id));
      row.querySelector('[data-act="paid"]').addEventListener('click', () => markPaid(client));
    });
  } else {
    dueBox.hidden = clientState.clients.length === 0;
    dueBox.innerHTML = `<h3>All caught up 🔥</h3><p class="muted" style="margin:0">No maintenance fees due for ${escapeHtml(formatMonth(month))}.</p>`;
  }

  const list = $('#clients-list');
  $('#clients-empty').hidden = clientState.clients.length > 0;
  list.innerHTML = '';
  for (const c of clientState.clients) {
    const paidThisMonth = c.paidMonths.includes(month);
    const card = document.createElement('div');
    card.className = 'client-card';
    card.innerHTML = `
      <div class="client-top">
        <h3>${escapeHtml(c.companyName)}</h3>
        <div class="client-actions">
          ${isDueThisMonth(c, month)
            ? '<button class="btn btn-sm btn-primary" data-act="paid">Mark this month paid</button>'
            : paidThisMonth ? '<span class="badge badge-client">Paid this month</span>' : ''}
          <button class="btn btn-sm" data-act="edit">Edit</button>
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
      </div>`;
    card.querySelector('[data-act="edit"]').addEventListener('click', () => openClientModal({ mode: 'edit', client: c }));
    card.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      if (!confirm(`Delete ${c.companyName}? Their payment history goes too, and the business can show up in Lead Finder again.`)) return;
      try {
        await api(`/api/clients/${c.id}`, { method: 'DELETE' });
        toast('Client removed');
        loadClients();
      } catch (err) { toast(err.message, true); }
    });
    const paidBtn = card.querySelector('[data-act="paid"]');
    if (paidBtn) paidBtn.addEventListener('click', () => markPaid(c));
    list.appendChild(card);
  }
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
  '24h': 'prior 24 hours',
  week: 'prior week',
  month: 'prior 30 days',
  '6months': 'prior 6 months',
  year: 'prior year',
};

let revenueWindow = 'month';

async function loadRevenue() {
  try {
    const res = await api(`/api/revenue?window=${encodeURIComponent(revenueWindow)}`);
    $('#revenue-value').textContent = money(res.total);
    $('#revenue-upfront').textContent = money(res.upfront);
    $('#revenue-monthly').textContent = money(res.monthly);

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
    $('#traffic-empty').hidden = sites.length > 0;
    const totalEl = $('#traffic-total');
    if (totalEl) {
      totalEl.textContent = `${Number(total || 0).toLocaleString()} total visit${total === 1 ? '' : 's'} across ${sites.length} site${sites.length === 1 ? '' : 's'}`;
      totalEl.hidden = sites.length === 0;
    }
    list.innerHTML = sites.map((s) => `
      <div class="traffic-row">
        <span class="t-name">${escapeHtml(s.label || '(untitled site)')}</span>
        <span class="t-views">${Number(s.views || 0).toLocaleString()}<small>visits</small></span>
        <span class="t-date">${s.updatedAt ? 'last: ' + escapeHtml(formatDate(s.updatedAt)) : ''}</span>
      </div>`).join('');
  } catch (err) {
    list.innerHTML = `<p class="inline-error">${escapeHtml(err.message)}</p>`;
  }
}

$('#traffic-refresh')?.addEventListener('click', loadTraffic);

// ------------------------------------------------- Money Tracker (calendar)
// Log income, see it on a month calendar, and auto-split each month + all-time
// into fixed buckets: 40% taxes / 10% Forge / 35% save / 15% self.

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

  // Group this month's entries by day.
  const byDay = {};
  let monthTotal = 0;
  for (const e of moneyState.entries) {
    if ((e.date || '').slice(0, 7) !== ym) continue;
    const amt = Number(e.amount) || 0;
    monthTotal += amt;
    (byDay[e.date] = byDay[e.date] || { sum: 0 }).sum += amt;
  }

  $('#money-month-label').textContent = formatMonth(ym);
  $('#money-month-total').textContent = money(monthTotal);

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

  // Month split summary.
  $('#money-summary').innerHTML =
    `<div class="tot"><small>Made this month</small><b class="money">${money(monthTotal)}</b></div>
     <div class="money-split">${moneySplitHtml(monthTotal)}</div>`;

  // All-time totals.
  const allTotal = moneyState.entries.reduce((a, e) => a + (Number(e.amount) || 0), 0);
  const pct = Object.fromEntries(MONEY_SPLIT.map((s) => [s.key, s.pct]));
  $('#money-alltime').innerHTML = `
    <div class="alltime-title">All-time totals</div>
    <div class="stat"><small>Total made</small><b class="money">${money(allTotal)}</b></div>
    <div class="stat tax"><small>Tax set aside</small><b class="money">${money(allTotal * pct.tax)}</b></div>
    <div class="stat save"><small>Saved &amp; invested</small><b class="money">${money(allTotal * pct.save)}</b></div>
    <div class="stat you"><small>Yours</small><b class="money">${money(allTotal * pct.you)}</b></div>`;
}

function renderMoneyDayEntries(date) {
  const items = moneyState.entries.filter((e) => e.date === date);
  const box = $('#money-day-entries');
  if (!items.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="day-entries-title">Logged on ${escapeHtml(formatDate(date))}</div>` +
    items.map((e) => `
      <div class="day-entry">
        <span class="de-amt money">${money(e.amount)}</span>
        <span class="de-note">${escapeHtml(e.note || '')}</span>
        <button class="btn btn-sm btn-danger" data-del="${e.id}">Delete</button>
      </div>`).join('');
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

function openMoneyModal(date) {
  $('#money-form').reset();
  $('#money-form-error').hidden = true;
  $('#mf-date').value = date || localToday();
  renderMoneyDayEntries($('#mf-date').value);
  $('#money-modal').hidden = false;
  $('#mf-amount').focus();
}

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
  const errEl = $('#money-form-error');
  errEl.hidden = true;
  if (!date) { errEl.textContent = 'Pick a date.'; errEl.hidden = false; return; }
  if (!(amount > 0)) { errEl.textContent = 'Enter an amount bigger than 0.'; errEl.hidden = false; return; }
  try {
    const { entry } = await api('/api/income', { method: 'POST', body: { date, amount, note } });
    moneyState.entries.push(entry);
    moneyState.month = date.slice(0, 7); // jump the calendar to the month you logged
    $('#mf-amount').value = '';
    $('#mf-note').value = '';
    $('#mf-amount').focus();
    renderMoney();
    renderMoneyDayEntries(date);
    toast(`Added ${money(amount)}`);
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

async function runBuildRefine(instruction, btn, busyLabel) {
  if (!buildState.html) { toast('Generate a site first', true); return; }
  if (!instruction) { toast('Type what you want changed first', true); return; }

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
    $('#build-frame').srcdoc = newHtml;
    $('#build-link-output').hidden = true; // any earlier link now points at the old version
    toast('Change applied — save a new link to share this version');
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

$('#build-refine-btn').addEventListener('click', () => {
  const instruction = $('#build-refine-input').value.trim();
  if (!instruction) { toast('Type what you want changed first', true); return; }
  runBuildRefine(instruction, $('#build-refine-btn'), 'Refining…').then(() => { $('#build-refine-input').value = ''; });
});

$('#build-enhance')?.addEventListener('click', () => {
  runBuildRefine(ENHANCE_INSTRUCTION, $('#build-enhance'), 'Enhancing…');
});

// Multi-page: refine the page currently being viewed.
async function runMultiRefine(instruction, btn, busyLabel) {
  const cur = multiState.current;
  if (!cur || !multiState.pages[cur]) { toast('Generate or open a site first', true); return; }
  if (!instruction) { toast('Type what you want changed first', true); return; }

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
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

$('#multi-refine-btn').addEventListener('click', () => {
  const instruction = $('#multi-refine-input').value.trim();
  if (!instruction) { toast('Type what you want changed first', true); return; }
  runMultiRefine(instruction, $('#multi-refine-btn'), 'Refining…').then(() => { $('#multi-refine-input').value = ''; });
});

$('#multi-enhance')?.addEventListener('click', () => {
  runMultiRefine(ENHANCE_INSTRUCTION, $('#multi-enhance'), 'Enhancing…');
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
  localStorage.setItem(INVOICE_FROM_KEY, JSON.stringify({ name: data.fromName, contact: data.fromContact }));
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

// ---------------------------------------------------------------- theme

const THEME_KEY = 'forge-theme';

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = $('#theme-toggle');
  if (btn) btn.textContent = theme === 'light' ? '☀️' : '🌙';
}

// Restore the saved choice on load (default dark).
applyTheme(localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark');

$('#theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  localStorage.setItem(THEME_KEY, next);
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

function replaceImageAt(index, newSrc) {
  const doc = new DOMParser().parseFromString(buildState.html, 'text/html');
  const imgs = doc.querySelectorAll('img');
  if (!imgs[index]) return;
  imgs[index].setAttribute('src', newSrc);
  const html = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
  buildState.html = html;
  $('#build-frame').srcdoc = html;
  $('#build-link-output').hidden = true;
  toast('Photo replaced — save a new link to share this version');
  openPhotos();
}

function openPhotos() {
  if (!buildState.html) { toast('Generate a site first', true); return; }
  const doc = new DOMParser().parseFromString(buildState.html, 'text/html');
  const imgs = Array.from(doc.querySelectorAll('img'));
  const list = $('#photos-list');
  if (!imgs.length) {
    list.innerHTML = '<p class="muted">This site doesn\'t use any &lt;img&gt; photos to swap — its images may be CSS backgrounds. You can ask for a photo with the Refine box instead.</p>';
  } else {
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
  $('#photos-modal').hidden = false;
}

const btnPhotos = $('#build-photos');
if (btnPhotos) btnPhotos.addEventListener('click', openPhotos);
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
    $('#detail-modal').hidden = true;
    $('#photos-modal').hidden = true;
    $('#info-modal').hidden = true;
    $('#money-modal').hidden = true;
  }
});
