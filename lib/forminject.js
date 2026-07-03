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
  // Robust handler: hooks each form's submit event AND click events on its
  // buttons, so it works whether the AI used <button type="submit">, a plain
  // <button>, or <button type="button">. A per-form guard prevents double
  // sends. On success the form is replaced with a thank-you message.
  const script =
    `${START}<script>(function(){var T=${t},E=${e};` +
    `function send(f){if(f.getAttribute('data-forge-sent'))return;` +
    `var hpEl=f.querySelector('[name=_hp]');if(hpEl&&hpEl.value)return;` +
    `f.setAttribute('data-forge-sent','1');var data={token:T};` +
    `var els=f.querySelectorAll('input,textarea,select');` +
    `for(var j=0;j<els.length;j++){var el=els[j];if(el.name&&el.name!=='_hp'&&el.type!=='submit'&&el.type!=='button')data[el.name]=el.value;}` +
    `var btn=f.querySelector('button[type=submit],input[type=submit],button');var old=btn?btn.innerHTML:'';` +
    `if(btn){btn.disabled=true;btn.innerHTML='Sending…';}` +
    `fetch(E,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})` +
    `.then(function(r){return r.json().catch(function(){return{};});})` +
    `.then(function(res){if(res&&res.ok===false)throw new Error(res.error||'failed');` +
    `f.innerHTML='<div style="padding:22px;text-align:center;font-size:1.1rem;line-height:1.5">' +
    '\\u2705 Thanks! Your message has been sent \\u2014 we\\'ll be in touch shortly.</div>';})` +
    `.catch(function(){f.removeAttribute('data-forge-sent');if(btn){btn.disabled=false;btn.innerHTML=old;}` +
    `alert('Sorry, something went wrong sending your message. Please call us instead.');});}` +
    `var forms=document.querySelectorAll('form');` +
    `for(var i=0;i<forms.length;i++){(function(f){if(f.getAttribute('data-forge'))return;f.setAttribute('data-forge','1');` +
    `var hp=document.createElement('input');hp.type='text';hp.name='_hp';hp.tabIndex=-1;hp.setAttribute('autocomplete','off');` +
    `hp.setAttribute('aria-hidden','true');hp.style.position='absolute';hp.style.left='-9999px';f.appendChild(hp);` +
    `f.addEventListener('submit',function(ev){ev.preventDefault();send(f);});` +
    `var btns=f.querySelectorAll('button,input[type=submit],input[type=button]');` +
    `for(var k=0;k<btns.length;k++){btns[k].addEventListener('click',function(ev){` +
    `var ty=(this.getAttribute('type')||'').toLowerCase();if(ty===''||ty==='submit')return;` +
    `ev.preventDefault();send(f);});}` +
    `})(forms[i]);}})();</script>${END}`;
  return clean.includes('</body>') ? clean.replace('</body>', `${script}</body>`) : clean + script;
}
