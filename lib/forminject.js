// Wires up a generated site's contact form(s) so a submission reaches the
// business owner — WITHOUT depending on Forge, a database, or any third-party
// service staying online. We append a small, self-contained script that
// intercepts every <form> submit, gathers the fields, and opens the visitor's
// email app with a pre-filled message addressed to the owner (a "mailto:"
// handoff). Because everything lives inside the page itself, the form keeps
// working after the site is downloaded and hosted on the client's own domain.
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
  // <button>, or <button type="button">. On submit it builds a nicely
  // formatted email to the owner and opens the visitor's mail app; the form is
  // then replaced with a thank-you plus a clickable fallback link.
  const script =
    `${START}<script>(function(){var TO=${to},BIZ=${biz};` +
    `function label(el){var n=el.getAttribute('placeholder')||el.getAttribute('aria-label')||'';` +
    `if(!n&&el.id){var l=document.querySelector('label[for="'+el.id+'"]');if(l)n=l.textContent;}` +
    `if(!n)n=el.name;return String(n||'').trim();}` +
    `function send(f){if(f.getAttribute('data-forge-sent'))return;` +
    `var hpEl=f.querySelector('[name=_hp]');if(hpEl&&hpEl.value)return;` +
    `var els=f.querySelectorAll('input,textarea,select');var lines=[];` +
    `for(var j=0;j<els.length;j++){var el=els[j];var ty=(el.type||'').toLowerCase();` +
    `if(!el.name||el.name==='_hp'||ty==='submit'||ty==='button'||ty==='hidden')continue;` +
    `if((ty==='checkbox'||ty==='radio')&&!el.checked)continue;` +
    `var v=String(el.value||'').trim();if(!v)continue;lines.push(label(el)+': '+v);}` +
    `if(!lines.length){alert('Please fill in your details first.');return;}` +
    `f.setAttribute('data-forge-sent','1');` +
    `var subject='New enquiry from your website'+(BIZ?(' \\u2014 '+BIZ):'');` +
    `var body=lines.join('\\n')+'\\n';` +
    `var url='mailto:'+encodeURIComponent(TO)+'?subject='+encodeURIComponent(subject)+'&body='+encodeURIComponent(body);` +
    `window.location.href=url;` +
    `var safe=url.replace(/&/g,'&amp;').replace(/"/g,'&quot;');` +
    `f.innerHTML='<div style="padding:22px;text-align:center;font-size:1.05rem;line-height:1.6">' +
    '\\u2705 Thanks! Your email app should open with your message ready to send.<br>' +
    'If it did not open, <a href="'+safe+'">click here to email us</a>.</div>';}` +
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
