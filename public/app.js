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
  const v = Number(n) || 0;
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

// ---------------------------------------------------------------- tabs

const panels = ['build', 'multi', 'leads', 'history', 'clients', 'revenue'];

function switchTab(name) {
  for (const p of panels) {
    $(`#panel-${p}`).classList.toggle('is-active', p === name);
  }
  document.querySelectorAll('.tab-btn').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.tab === name);
  });
  if (name === 'history') loadHistory();
  if (name === 'clients') loadClients();
  if (name === 'revenue') loadRevenue();
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
  loadPreviewList();
  return res;
}

async function loadPreviewList() {
  const box = $('#preview-list');
  try {
    const { previews } = await api('/api/previews');
    if (!previews.length) {
      box.innerHTML = '<p class="muted">No preview links yet.</p>';
      return;
    }
    box.innerHTML = previews.map((p) => `
      <div class="preview-row" data-id="${escapeHtml(p.id)}">
        <span class="p-title">${escapeHtml(p.title || '(untitled site)')}</span>
        <span class="p-meta">${p.kind === 'multi' ? 'multi-page' : 'single page'} · ${escapeHtml(formatDate(p.createdAt))}</span>
        <span class="spacer"></span>
        <a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">Open</a>
        <button class="btn btn-sm" data-act="copy">Copy link</button>
        <button class="btn btn-sm btn-danger" data-act="delete">Delete</button>
      </div>`).join('');
    box.querySelectorAll('.preview-row').forEach((row) => {
      const id = row.dataset.id;
      const url = location.origin + (previews.find((p) => p.id === id)?.url || '');
      row.querySelector('[data-act="copy"]').addEventListener('click', () => copyText(url));
      row.querySelector('[data-act="delete"]').addEventListener('click', async () => {
        if (!confirm('Delete this preview link? Anyone holding the URL will lose access.')) return;
        try {
          await api(`/api/previews/${id}`, { method: 'DELETE' });
          toast('Preview link deleted');
          loadPreviewList();
        } catch (err) { toast(err.message, true); }
      });
    });
  } catch {
    box.innerHTML = '<p class="muted">Could not load preview links.</p>';
  }
}

$('#preview-manager').addEventListener('toggle', (e) => {
  if (e.target.open) loadPreviewList();
});

// ------------------------------------------------- Section 1: single page

const buildState = { html: null, placeId: null };

async function generateSingle(prompt, placeId = null) {
  const errEl = $('#build-error');
  errEl.hidden = true;
  $('#build-result').hidden = true;
  $('#build-link-output').hidden = true;
  $('#build-loading').hidden = false;
  $('#build-generate').disabled = true;

  try {
    const context = extractKeywords(prompt);
    const res = await api('/api/generate', {
      method: 'POST',
      body: { mode: 'page', prompt, context },
    });
    buildState.html = res.html;
    buildState.placeId = placeId;
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

// ------------------------------------------------- Section 2: multi-page

const multiState = { pages: {}, defs: [], current: null, placeId: null };

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
        body: { mode: 'page', prompt, context, brand: brandRes.brand, page, pages: defs },
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

// ---------------------------------------------------------------- boot

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    $('#client-modal').hidden = true;
    $('#detail-modal').hidden = true;
  }
});
