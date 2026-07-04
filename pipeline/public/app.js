'use strict';

const $ = (id) => document.getElementById(id);
const api = async (path, body) => {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---- app state (persisted so a refresh doesn't lose a build) ----
const STORE = 'pipeline.lastRun';
let state = loadState();

function loadState() {
  try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; }
}
function saveState() {
  try { localStorage.setItem(STORE, JSON.stringify(state)); } catch { /* quota */ }
}

// ---- tabs ----
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    const tab = btn.dataset.tab;
    $('tab-build').classList.toggle('hidden', tab !== 'build');
    $('tab-call').classList.toggle('hidden', tab !== 'call');
    if (tab === 'call') primeCallContext();
  });
});

// ---- pipeline step tracker ----
const STEPS = [
  { id: 'brief', name: 'Prompt Engineer — write brief' },
  { id: 'generate', name: 'Website Generator — build site' },
  { id: 'enhance', name: 'Design Enhancer — polish & animate' },
  { id: 'qa', name: 'QA Auditor — final check' },
];
function renderSteps(statuses = {}) {
  $('steps').innerHTML = STEPS.map((s, i) => {
    const st = statuses[s.id] || 'pending';
    const mark = st === 'done' ? '✓' : st === 'error' ? '✕' : st === 'running' ? '' : i + 1;
    const sub = statuses[s.id + '_sub'] ? `<span class="s-sub">${esc(statuses[s.id + '_sub'])}</span>` : '';
    return `<div class="step ${st}"><span class="dot">${mark}</span><span class="s-name">${esc(s.name)}</span>${sub}</div>`;
  }).join('');
}
renderSteps();

// ---- main build flow ----
$('run').addEventListener('click', runPipeline);

async function runPipeline() {
  const input = {
    businessName: $('businessName').value.trim(),
    serviceType: $('serviceType').value.trim(),
    phone: $('phone').value.trim(),
    address: $('address').value.trim(),
    reviews: $('reviews').value.trim(),
    competitors: $('competitors').value.split(/\n+/).map((s) => s.trim()).filter(Boolean),
  };
  if (!input.businessName || !input.serviceType) {
    $('run-note').innerHTML = '<span class="err">Business name and service type are required.</span>';
    return;
  }
  $('run').disabled = true;
  $('run-note').textContent = 'Running the pipeline…';
  $('out-empty').classList.add('hidden');
  ['out-preview', 'out-qa', 'out-brief'].forEach((id) => $(id).classList.add('hidden'));

  const status = {};
  const set = (id, st, sub) => { status[id] = st; if (sub !== undefined) status[id + '_sub'] = sub; renderSteps(status); };

  try {
    state = { input, createdAt: Date.now() };

    // Stage 1 — brief
    set('brief', 'running');
    const pe = await api('/api/prompt-engineer', input);
    state.brief = pe.brief;
    state.competitorsFetched = pe.competitorsFetched;
    showBrief(pe.brief);
    const okc = (pe.competitorsFetched || []).filter((c) => c.ok).length;
    set('brief', 'done', pe.competitorsFetched?.length ? `${okc}/${pe.competitorsFetched.length} sites read` : 'done');

    // Stage 2 — generate (single + multi in parallel)
    set('generate', 'running', 'single + multi');
    const [single, multi] = await Promise.all([
      api('/api/website-generator', { brief: state.brief, version: 'single' }),
      api('/api/website-generator', { brief: state.brief, version: 'multi' }).catch((e) => ({ error: e.message })),
    ]);
    state.singleHtml = single.html;
    state.multiFiles = multi && multi.files ? multi.files : null;
    set('generate', 'done', state.multiFiles ? `single + ${Object.keys(state.multiFiles).length} pages` : 'single-page');

    // Stage 3 — enhance the single-page (primary deliverable)
    set('enhance', 'running');
    const enh = await api('/api/design-enhancer', { html: state.singleHtml });
    state.enhancedHtml = enh.html;
    showPreview(state.enhancedHtml);
    set('enhance', 'done');

    // Stage 4 — QA
    set('qa', 'running');
    const qa = await api('/api/qa-auditor', { html: state.enhancedHtml, brief: state.brief });
    state.qa = qa;
    showQa(qa);
    set('qa', qa.ready ? 'done' : 'done', qa.ready ? 'ready ✓' : `${qa.issues.length} issue(s)`);

    saveState();
    $('run-note').innerHTML = qa.ready
      ? '<span style="color:var(--green)">Done — site is ready to sell.</span>'
      : 'Done — QA flagged some items below. Review, or use “Regenerate with fixes”.';
  } catch (err) {
    for (const s of STEPS) if (status[s.id] === 'running') set(s.id, 'error', 'failed');
    $('run-note').innerHTML = '<span class="err">' + esc(err.message) + '</span>';
  } finally {
    $('run').disabled = false;
  }
}

// ---- output renderers ----
function showBrief(brief) {
  $('brief').textContent = brief;
  $('out-brief').classList.remove('hidden');
}

function showPreview(html) {
  const frame = $('preview');
  frame.srcdoc = html;
  $('out-preview').classList.remove('hidden');
  $('dl-multi').classList.toggle('hidden', !state.multiFiles);
}

function showQa(qa) {
  const body = $('qa-body');
  if (qa.ready) {
    body.innerHTML = `<span class="badge ok">✓ Ready for client delivery</span>` +
      (qa.summary ? `<p class="muted" style="margin:10px 0 0">${esc(qa.summary)}</p>` : '');
  } else {
    body.innerHTML =
      `<span class="badge warn">${qa.issues.length} issue(s) to review</span>` +
      (qa.summary ? `<p class="muted" style="margin:8px 0">${esc(qa.summary)}</p>` : '') +
      qa.issues.map((i) => `<div class="issue"><div class="who">${esc(i.agent || 'fix')}</div>` +
        `<div class="what">${esc(i.issue)}</div><div class="fix">${esc(i.fix)}</div></div>`).join('') +
      `<button class="ghost" id="regen" style="margin-top:12px">↻ Regenerate with these fixes</button>`;
    const btn = $('regen');
    if (btn) btn.addEventListener('click', regenerateWithFixes);
  }
  $('out-qa').classList.remove('hidden');
}

// Feed QA issues back to the generator + enhancer, then re-QA (one pass).
async function regenerateWithFixes() {
  const btn = $('regen');
  if (btn) { btn.disabled = true; btn.textContent = 'Regenerating…'; }
  const fixes = state.qa.issues.map((i) => `- (${i.agent}) ${i.issue} → ${i.fix}`).join('\n');
  const status = { brief: 'done', generate: 'running' };
  renderSteps(status);
  try {
    const briefPlus = `${state.brief}\n\nQA FIXES TO APPLY IN THIS REVISION:\n${fixes}`;
    const single = await api('/api/website-generator', { brief: briefPlus, version: 'single' });
    status.generate = 'done'; status.enhance = 'running'; renderSteps(status);
    const enh = await api('/api/design-enhancer', { html: single.html });
    state.singleHtml = single.html; state.enhancedHtml = enh.html;
    showPreview(state.enhancedHtml);
    status.enhance = 'done'; status.qa = 'running'; renderSteps(status);
    const qa = await api('/api/qa-auditor', { html: state.enhancedHtml, brief: state.brief });
    state.qa = qa; showQa(qa);
    status.qa = 'done'; renderSteps(status);
    saveState();
  } catch (err) {
    $('run-note').innerHTML = '<span class="err">' + esc(err.message) + '</span>';
  }
}

// ---- preview controls ----
$('v-desktop').addEventListener('click', () => $('frame-wrap').classList.remove('mobile'));
$('v-mobile').addEventListener('click', () => $('frame-wrap').classList.add('mobile'));
$('open-tab').addEventListener('click', () => {
  if (!state.enhancedHtml) return;
  const blob = new Blob([state.enhancedHtml], { type: 'text/html' });
  window.open(URL.createObjectURL(blob), '_blank');
});
$('dl-single').addEventListener('click', () => download('index.html', state.enhancedHtml));
$('dl-multi').addEventListener('click', () => {
  if (!state.multiFiles) return;
  // No zip lib on the page — download each file in turn.
  Object.entries(state.multiFiles).forEach(([name, html], i) => setTimeout(() => download(name, html), i * 350));
});
function download(name, content) {
  if (!content) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: 'text/html' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---- restore last run on load ----
(function restore() {
  if (!state || !state.input) return;
  const i = state.input;
  $('businessName').value = i.businessName || '';
  $('serviceType').value = i.serviceType || '';
  $('phone').value = i.phone || '';
  $('address').value = i.address || '';
  $('reviews').value = i.reviews || '';
  $('competitors').value = (i.competitors || []).join('\n');
  if (state.brief) showBrief(state.brief);
  if (state.enhancedHtml) { showPreview(state.enhancedHtml); $('out-empty').classList.add('hidden'); }
  if (state.qa) showQa(state.qa);
})();

// ================= LIVE CALL ASSIST =================
function primeCallContext() {
  const el = $('callContext');
  if (el.value.trim() || !state.input) return;
  const i = state.input;
  const pages = state.multiFiles ? Object.keys(state.multiFiles).join(', ') : 'single-page';
  el.value =
    `Business: ${i.businessName} — ${i.serviceType}${i.address ? ` (${i.address})` : ''}.` +
    `${i.phone ? ` Phone: ${i.phone}.` : ''}\n` +
    `Website built: ${pages}. Sections: hero, services, testimonials (from real reviews), contact with click-to-call.\n` +
    `Brief used:\n${state.brief || '(run a build first)'}\n\n` +
    `Add your pricing and timeline here so I stay factual (e.g. $500 upfront + $50/mo, live in 3 days).`;
}

const transcriptEl = () => $('transcript');
function addTurn(role, text, cls) {
  const first = transcriptEl().querySelector('.muted');
  if (first) first.remove();
  const div = document.createElement('div');
  div.className = `turn ${cls}`;
  div.innerHTML = `<div class="role">${esc(role)}</div><div class="text">${esc(text)}</div>`;
  transcriptEl().appendChild(div);
  transcriptEl().scrollTop = transcriptEl().scrollHeight;
  return div;
}

async function askAssistant(clientText) {
  addTurn('Client', clientText, 'client');
  const pending = addTurn('Suggested reply', '…thinking', 'suggest');
  try {
    const ctx = $('callContext').value.trim() || 'No build context yet.';
    const data = await api('/api/live-call-assistant', { context: ctx, transcript: clientText });
    pending.querySelector('.text').textContent = data.suggestion;
  } catch (err) {
    pending.querySelector('.text').innerHTML = '<span class="err">' + esc(err.message) + '</span>';
  }
}

$('send').addEventListener('click', sendClient);
$('clientSays').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendClient(); });
function sendClient() {
  const v = $('clientSays').value.trim();
  if (!v) return;
  $('clientSays').value = '';
  askAssistant(v);
}

// Optional voice capture via the browser's Web Speech API (no server, no key).
(function setupMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const mic = $('mic');
  if (!SR) { mic.disabled = true; $('mic-note').textContent = 'Voice capture not supported in this browser — type instead.'; return; }
  const rec = new SR();
  rec.continuous = true; rec.interimResults = false; rec.lang = 'en-US';
  let on = false;
  rec.onresult = (e) => {
    const t = e.results[e.results.length - 1][0].transcript.trim();
    if (t) askAssistant(t);
  };
  rec.onerror = (e) => { $('mic-note').textContent = 'Mic error: ' + e.error; };
  rec.onend = () => { if (on) rec.start(); };
  mic.addEventListener('click', () => {
    on = !on;
    mic.classList.toggle('on', on);
    $('mic-note').textContent = on ? 'Listening… speak the client’s question, a suggestion appears automatically.' : '';
    if (on) rec.start(); else rec.stop();
  });
})();
