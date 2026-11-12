// Wires up a generated site's contact form(s). A small script is appended that
// intercepts every <form> submit and does one of two things:
//
// LIVE (an owner email is known): gathers the fields and POSTs them to
// FormSubmit, a free form-to-email service, addressed to the owner's inbox.
// The visitor stays on the page. "Sent" is only shown when FormSubmit says the
// message was accepted — it answers HTTP 200 with success "false" until the
// owner has clicked the activation link in its first email, and a 200 alone
// used to be taken as delivered. Anything short of a confirmed send falls back
// to opening the visitor's own email app with the message filled in, so an
// enquiry is never silently lost.
//
// DEMO (no email yet): the form is a preview being shown to the owner. It
// says so, and says what the live one will do, instead of reloading the page.
//
// Nothing here depends on Forge staying online, so the form keeps working
// after the site is downloaded onto the client's domain.
//
// The block is wrapped in marker comments so it can be cleanly stripped and
// re-injected (e.g. across a refine, or when the email is set later) without
// stacking duplicates.

const START = '<!--forge-forms-start-->';
const END = '<!--forge-forms-end-->';
const BLOCK_RE = new RegExp(`${START}[\\s\\S]*?${END}`, 'g');

export function stripForms(html) {
  return String(html || '').replace(BLOCK_RE, '');
}

// True when the page's form is wired in demo mode (no owner email).
export function isDemoForm(html) {
  return /<!--forge-forms-start--><script>\(function\(\)\{var TO="",/.test(String(html || ''));
}

// Put a block just before the page's last </body>. A function is used as the
// replacement because a replacement *string* gives "$&" and "$'" special
// meanings, and a business called "A$AP Plumbing" would corrupt the script.
export function insertBeforeBodyEnd(html, block) {
  const doc = String(html || '');
  const at = doc.toLowerCase().lastIndexOf('</body>');
  return at === -1 ? doc + block : doc.slice(0, at) + block + doc.slice(at);
}

// A value written into a <script>. JSON alone would let "</script>" in a
// business name close the tag early.
export function scriptString(value) {
  return JSON.stringify(String(value || '')).replace(/</g, '\\u003c');
}

// Everything outside plain ASCII is written as a \uXXXX escape, so the script
// reads the same whatever character set the page ends up being served in.
function asciiOnly(js) {
  return js.replace(/[^\x00-\x7f]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

// The handler, written out in full so it can be read. Hooks each form's submit
// event AND click events on its buttons, so it works whether the page used
// <button type="submit">, a plain <button>, or <button type="button">. A
// per-form guard prevents double sends.
const HANDLER = String.raw`(function(){var TO=__TO__,BIZ=__BIZ__;
var LIVE=!!TO;
var ENDPOINT='https://formsubmit.co/ajax/'+encodeURIComponent(TO);
function label(el){var n=el.getAttribute('placeholder')||el.getAttribute('aria-label')||'';
if(!n&&el.id){var l=document.querySelector('label[for="'+el.id+'"]');if(l)n=l.textContent;}
if(!n)n=el.name;return String(n||'').trim();}
function collect(f){var els=f.querySelectorAll('input,textarea,select');var out=[];
for(var j=0;j<els.length;j++){var el=els[j];var ty=(el.type||'').toLowerCase();
if(!el.name||el.name==='_hp'||ty==='submit'||ty==='button'||ty==='hidden')continue;
if((ty==='checkbox'||ty==='radio')&&!el.checked)continue;
var v=String(el.value||'').trim();if(!v)continue;out.push({name:el.name,label:label(el),value:v});}return out;}
function subjectLine(){return 'New enquiry from your website'+(BIZ?(' — '+BIZ):'');}
function note(f,html){var box=document.createElement('div');box.setAttribute('role','status');
box.style.cssText='padding:1.25em 0;font:inherit;line-height:1.6';box.innerHTML=html;
while(f.firstChild)f.removeChild(f.firstChild);f.appendChild(box);}
function sent(f){note(f,'<strong>Thanks — your message is on its way.</strong><br>We’ll be in touch shortly.');}
function demo(f){note(f,'<strong>This is a preview, so nothing was sent.</strong><br>On the live site this message goes straight to the owner’s inbox.');}
function mailtoFallback(f,items){var lines=[];for(var i=0;i<items.length;i++)lines.push(items[i].label+': '+items[i].value);
var url='mailto:'+encodeURIComponent(TO)+'?subject='+encodeURIComponent(subjectLine())+'&body='+encodeURIComponent(lines.join('\n')+'\n');
var safe=url.replace(/&/g,'&amp;').replace(/"/g,'&quot;');
note(f,'<strong>One more step.</strong> Your email app should open with your message ready to send.<br>If it did not open, <a href="'+safe+'">tap here to email us</a>.');
window.location.href=url;}
function send(f){if(f.getAttribute('data-forge-sent'))return;
var hpEl=f.querySelector('[name=_hp]');if(hpEl&&hpEl.value)return;
var items=collect(f);if(!items.length){alert('Please fill in your details first.');return;}
if(!LIVE){demo(f);return;}
f.setAttribute('data-forge-sent','1');
var btn=f.querySelector('button[type=submit],input[type=submit],button');
if(btn){btn.disabled=true;if(btn.tagName==='BUTTON')btn.textContent='Sending…';}
var payload={_subject:subjectLine(),_template:'table',_captcha:'false'};
for(var i=0;i<items.length;i++)payload[items[i].name]=items[i].value;
var ctl=window.AbortController?new AbortController():null;
var timer=setTimeout(function(){if(ctl)ctl.abort();},15000);
fetch(ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(payload),signal:ctl?ctl.signal:undefined})
.then(function(r){return r.json().catch(function(){return null;}).then(function(d){return{ok:r.ok,d:d};});})
.then(function(x){clearTimeout(timer);
if(!x.ok||!x.d||String(x.d.success)!=='true')throw new Error('not delivered');
sent(f);})
.catch(function(){clearTimeout(timer);f.removeAttribute('data-forge-sent');mailtoFallback(f,items);});}
var forms=document.querySelectorAll('form');
for(var i=0;i<forms.length;i++){(function(f){if(f.getAttribute('data-forge'))return;f.setAttribute('data-forge','1');
var hp=document.createElement('input');hp.type='text';hp.name='_hp';hp.tabIndex=-1;hp.setAttribute('autocomplete','off');
hp.setAttribute('aria-hidden','true');hp.style.position='absolute';hp.style.left='-9999px';f.appendChild(hp);
f.addEventListener('submit',function(ev){ev.preventDefault();send(f);});
var btns=f.querySelectorAll('button,input[type=submit],input[type=button]');
for(var k=0;k<btns.length;k++){btns[k].addEventListener('click',function(ev){
var ty=(this.getAttribute('type')||'').toLowerCase();if(ty===''||ty==='submit')return;
ev.preventDefault();send(f);});}
})(forms[i]);}})();`;

// email: where form submissions should go (the business owner's inbox). Empty
//        wires the form in demo mode.
// businessName: used in the email subject so multiple sites are distinguishable.
export function injectForms(html, email, businessName) {
  const clean = stripForms(html);
  // Functions as replacements for the same reason as insertBeforeBodyEnd.
  const script = HANDLER
    .replace('__TO__', () => scriptString(email))
    .replace('__BIZ__', () => scriptString(businessName));
  return insertBeforeBodyEnd(clean, `${START}<script>${asciiOnly(script)}</script>${END}`);
}
