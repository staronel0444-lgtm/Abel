// A one-line safety net for images. If a picture on a generated site fails to
// load — a stock photo that was taken down, a mistyped address — the browser
// would show its broken-image icon and the alt text in the middle of the
// design. This hides the element instead, leaving whatever background the page
// drew behind it. It goes first in <head> so it is listening before any image
// is requested, and it is wrapped in markers so re-wiring never stacks copies.

const START = '<!--forge-guard-start-->';
const END = '<!--forge-guard-end-->';
const BLOCK_RE = new RegExp(`${START}[\\s\\S]*?${END}`, 'g');

const SCRIPT =
  "document.addEventListener('error',function(e){var t=e.target;" +
  "if(t&&t.tagName==='IMG'&&!t.getAttribute('data-forge-missing')){" +
  "t.setAttribute('data-forge-missing','1');t.style.visibility='hidden';}},true);";

export function injectGuard(html) {
  const doc = String(html || '').replace(BLOCK_RE, '');
  const m = /<head[^>]*>/i.exec(doc);
  if (!m) return doc;
  const at = m.index + m[0].length;
  return doc.slice(0, at) + `${START}<script>${SCRIPT}</script>${END}` + doc.slice(at);
}
