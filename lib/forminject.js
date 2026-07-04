// Wires up a generated site's contact form(s) so a submission is emailed to the
// business owner automatically — the visitor just clicks submit and stays on
// the page. We append a small script that intercepts every <form> submit,
// gathers the fields, and POSTs them to FormSubmit (a free form-to-email
// service) addressed to the owner's inbox. If that request ever fails, it
// falls back to opening the visitor's own email app with the message
// pre-filled (a "mailto:" handoff) so a message is never silently lost.
//
// FormSubmit requires the owner to confirm their address once (they get a
// one-time activation email on the first-ever submission); after that every
// submission is delivered. Nothing here depends on Forge staying online, so
// the form keeps working after the site is downloaded onto the client's domain.
//
// The block is wrapped in marker comments so it can be cleanly stripped and
// re-injected (e.g. across a refine) without stacking duplicates.

const START = '<!--forge-forms-start-->';
const END = '<!--forge-forms-end-->';
const BLOCK_RE = new RegExp(`${START}[\\s\\S]*?${END}`, 'g');

export function stripForms(html) {
  return String(html || '').replace(BLOCK_RE, '');
}

// email: where form submissions should go (the business owner's inbox).
// businessName: used in the email subject so multiple sites are distinguishable.
export function injectForms(html, email, businessName) {
  const clean = stripForms(html);
  const to = JSON.stringify(String(email || ''));
  const biz = JSON.stringify(String(businessName || ''));
  // Robust handler: hooks each form's submit event AND click events on its
  // buttons, so it works whether the AI used <button type="submit">, a plain
  // <button>, or <button type="button">. A per-form guard prevents double
  // sends.
  const script =
    `${START}<script>(function(){var TO=${to},BIZ=${biz};` +
    `var ENDPOINT='https://formsubmit.co/ajax/'+encodeURIComponent(TO);` +
    `function label(el){var n=el.getAttribute('placeholder')||el.getAttribute('aria-label')||'';` +
    `if(!n&&el.id){var l=document.querySelector('label[for="'+el.id+'"]');if(l)n=l.textContent;}` +
    `if(!n)n=el.name;return String(n||'').trim();}` +
    `function collect(f){var els=f.querySelectorAll('input,textarea,select');var out=[];` +
    `for(var j=0;j<els.length;j++){var el=els[j];var ty=(el.type||'').toLowerCase();` +
    `if(!el.name||el.name==='_hp'||ty==='submit'||ty==='button'||ty==='hidden')continue;` +
    `if((ty==='checkbox'||ty==='radio')&&!el.checked)continue;` +
    `var v=String(el.value||'').trim();if(!v)continue;out.push({name:el.name,label:label(el),value:v});}return out;}` +
    `function subjectLine(){return 'New enquiry from your website'+(BIZ?(' \\u2014 '+BIZ):'');}` +
    `function done(f){f.innerHTML='<div style="padding:22px;text-align:center;font-size:1.05rem;line-height:1.6">' +
    '\\u2705 Thanks! Your message has been sent \\u2014 we\\'ll be in touch shortly.</div>';}` +
    `function mailtoFallback(f,items){var lines=[];for(var i=0;i<items.length;i++)lines.push(items[i].label+': '+items[i].value);` +
    `var url='mailto:'+encodeURIComponent(TO)+'?subject='+encodeURIComponent(subjectLine())+'&body='+encodeURIComponent(lines.join('\\n')+'\\n');` +
    `window.location.href=url;var safe=url.replace(/&/g,'&amp;').replace(/"/g,'&quot;');` +
    `f.innerHTML='<div style="padding:22px;text-align:center;font-size:1.05rem;line-height:1.6">' +
    '\\u2705 Thanks! Your email app should open with your message ready to send.<br>' +
    'If it did not open, <a href="'+safe+'">click here to email us</a>.</div>';}` +
    `function send(f){if(f.getAttribute('data-forge-sent'))return;` +
    `var hpEl=f.querySelector('[name=_hp]');if(hpEl&&hpEl.value)return;` +
    `var items=collect(f);if(!items.length){alert('Please fill in your details first.');return;}` +
    `f.setAttribute('data-forge-sent','1');` +
    `var btn=f.querySelector('button[type=submit],input[type=submit],button');var old=btn?btn.innerHTML:'';` +
    `if(btn){btn.disabled=true;btn.innerHTML='Sending\\u2026';}` +
    `var payload={_subject:subjectLine(),_template:'table',_captcha:'false'};` +
    `for(var i=0;i<items.length;i++)payload[items[i].name]=items[i].value;` +
    `fetch(ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(payload)})` +
    `.then(function(r){if(!r.ok)throw new Error('http '+r.status);return r;})` +
    `.then(function(){done(f);})` +
    `.catch(function(){f.removeAttribute('data-forge-sent');mailtoFallback(f,items);});}` +
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
