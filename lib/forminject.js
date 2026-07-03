// Wires up a generated site's contact form(s) to Forge without depending on
// how the AI structured the form. We append a small, self-contained script
// that intercepts every <form> submit, POSTs the fields to Forge's
// /api/contact (with the signed token), and shows a success message.
//
// The block is wrapped in marker comments so it can be cleanly stripped and
// re-injected (e.g. across a refine) without stacking duplicates.

const START = '<!--forge-forms-start-->';
const END = '<!--forge-forms-end-->';
const BLOCK_RE = new RegExp(`${START}[\\s\\S]*?${END}`, 'g');

export function stripForms(html) {
  return String(html || '').replace(BLOCK_RE, '');
}

export function injectForms(html, token, endpoint) {
  const clean = stripForms(html);
  const t = JSON.stringify(token);
  const e = JSON.stringify(endpoint);
  const script =
    `${START}<script>(function(){var T=${t},E=${e};var forms=document.querySelectorAll('form');` +
    `for(var i=0;i<forms.length;i++){(function(f){if(f.getAttribute('data-forge'))return;f.setAttribute('data-forge','1');` +
    `var hp=document.createElement('input');hp.type='text';hp.name='_hp';hp.tabIndex=-1;hp.setAttribute('autocomplete','off');` +
    `hp.setAttribute('aria-hidden','true');hp.style.position='absolute';hp.style.left='-9999px';f.appendChild(hp);` +
    `f.addEventListener('submit',function(ev){ev.preventDefault();var data={token:T};var els=f.querySelectorAll('input,textarea,select');` +
    `for(var j=0;j<els.length;j++){var el=els[j];if(el.name&&el.type!=='submit'&&el.type!=='button')data[el.name]=el.value;}` +
    `var btn=f.querySelector('button[type=submit],input[type=submit],button');var old=btn?btn.innerHTML:'';` +
    `if(btn){btn.disabled=true;btn.innerHTML='Sending…';}` +
    `fetch(E,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})` +
    `.then(function(r){return r.json().catch(function(){return{};});})` +
    `.then(function(res){if(res&&res.ok===false)throw new Error(res.error||'failed');` +
    `f.innerHTML='<div style="padding:22px;text-align:center;font-size:1.1rem;line-height:1.5">' +
    '\\u2705 Thanks! Your message has been sent \\u2014 we\\'ll be in touch shortly.</div>';})` +
    `.catch(function(){if(btn){btn.disabled=false;btn.innerHTML=old;}` +
    `alert('Sorry, something went wrong sending your message. Please call us instead.');});});` +
    `})(forms[i]);}})();</script>${END}`;
  return clean.includes('</body>') ? clean.replace('</body>', `${script}</body>`) : clean + script;
}
