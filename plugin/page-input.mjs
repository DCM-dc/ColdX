const SOURCE_RECOVERY = 'Prefer omitting html and htmlBase64 and build arbitrary DOM in script with document.createElement, appending to #coldx-root. Alternatively resubmit the original HTML markup as UTF-8 Base64 in htmlBase64 and omit html. Do not encode a JSON tag tree, escaped entities or prose.';

function text(value, name, limit, optional = false) {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || value.length > limit) throw new Error(`${name} must be a string of at most ${limit} characters.`);
  return value;
}

/** Shared by the executing tool and its replay fold; never repairs damaged source. */
export function normalizePageInput(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Page arguments must be an object.');
  const title = text(args.title, 'title', 200).trim();
  if (!title) throw new Error('Page title must not be blank.');
  const subtitle = text(args.subtitle, 'subtitle', 1000, true);
  const css = text(args.css, 'css', 200_000, true);
  const script = text(args.script, 'script', 200_000, true);
  const hasHtml = args.html !== undefined;
  const hasBase64 = args.htmlBase64 !== undefined;
  if (hasHtml && hasBase64) throw new Error(`Supply exactly one of html or htmlBase64, never both. ${SOURCE_RECOVERY}`);
  let html;
  if (!hasHtml && !hasBase64) {
    if (!script.trim()) throw new Error(`A page requires non-empty script, html or htmlBase64. ${SOURCE_RECOVERY}`);
    html = '<div id="coldx-root"></div>';
  } else if (hasBase64) {
    const encoded = text(args.htmlBase64, 'htmlBase64', 2_000_000);
    if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
      throw new Error(`htmlBase64 must be canonical padded Base64. ${SOURCE_RECOVERY}`);
    }
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) throw new Error(`htmlBase64 contains invalid Base64. ${SOURCE_RECOVERY}`);
    try { html = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error(`htmlBase64 must decode to valid UTF-8. ${SOURCE_RECOVERY}`); }
  } else html = text(args.html, 'html', 500_000);
  if (html.length > 500_000) throw new Error('Decoded HTML must be at most 500000 characters.');
  const trimmed = html.trim();
  let isJsonContainer = false;
  if (/^[\[{]/.test(trimmed)) {
    try { const value = JSON.parse(trimmed); isJsonContainer = value !== null && typeof value === 'object'; } catch {}
  }
  if (isJsonContainer || !/<[a-z][a-z0-9:-]*(?:\s[^<>]*?)?\s*\/?>/i.test(trimmed)) {
    throw new Error(`html must contain real HTML markup, not a JSON/XML tag object, escaped markup or plain text. ${SOURCE_RECOVERY}`);
  }
  if (args.waitForInput !== undefined && typeof args.waitForInput !== 'boolean') throw new Error('waitForInput must be a boolean.');
  return { title, subtitle, html, css, script, waitForInput: args.waitForInput !== false };
}
