// A small deterministic cascade evaluator for the class/attribute surface rules
// under test. At-rules are evaluated recursively; specificity and source order
// decide the winning declaration, including the actual concatenated CSS order.
function split(source, delimiter) {
  let depth = 0, start = 0; const parts = [];
  for (let i = 0; i < source.length; i++) {
    if ('(['.includes(source[i])) depth++;
    if (')]'.includes(source[i])) depth--;
    if (!depth && source[i] === delimiter) { parts.push(source.slice(start, i)); start = i + 1; }
  }
  parts.push(source.slice(start)); return parts.map(value => value.trim()).filter(Boolean);
}
function specificity(selector) {
  let extra = 0;
  selector = selector.replace(/:is\(([^()]*)\)/g, (_, choices) => { extra += Math.max(...split(choices, ',').map(specificity)); return ''; });
  return extra + (selector.match(/#[\w-]+/g)?.length ?? 0) * 100
    + (selector.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/g)?.length ?? 0) * 10;
}
function compoundMatches(selector, node) {
  let valid = true;
  selector = selector.replace(/:is\(([^()]*)\)/g, (_, choices) => {
    if (!split(choices, ',').some(choice => compoundMatches(choice, node))) valid = false;
    return '';
  });
  selector = selector.replace(/\.([\w-]+)/g, (_, name) => { if (!node.classes.includes(name)) valid = false; return ''; });
  selector = selector.replace(/\[([\w-]+)(?:="([^"]*)")?\]/g, (_, key, value) => {
    if (!(key in node.attributes) || value !== undefined && node.attributes[key] !== value) valid = false;
    return '';
  });
  return valid && !selector.trim(); // Reject states/pseudos/types outside this surface contract.
}
function matches(selector, node, ancestors) {
  const parts = split(selector, ' ');
  if (!compoundMatches(parts.pop(), node)) return false;
  let index = ancestors.length - 1;
  while (parts.length) {
    const part = parts.pop();
    while (index >= 0 && !compoundMatches(part, ancestors[index])) index--;
    if (index-- < 0) return false;
  }
  return true;
}
export function surfaceCascade(source, preference, material, codingMode = true) {
  const node = { classes: ['cx-surface', ...(codingMode ? ['cx-coding-mode-menu'] : [])], attributes: { 'data-floating': 'true', 'data-material': material } };
  const ancestors = codingMode ? [{ classes: ['coldx-shell'], attributes: {} }, { classes: [], attributes: { 'data-slot': 'root' } }] : [];
  const result = new Map(); let order = 0;
  function visit(css) {
    let start = 0;
    while (start < css.length) {
      const open = css.indexOf('{', start); if (open < 0) return;
      const head = css.slice(start, open).trim(); let depth = 1, end = open + 1;
      for (; end < css.length && depth; end++) { if (css[end] === '{') depth++; if (css[end] === '}') depth--; }
      const body = css.slice(open + 1, end - 1); start = end;
      if (head.startsWith('@supports')) { visit(body); continue; }
      if (head.startsWith('@media')) { if (split(head.slice(6), ',').some(query => query === `(${preference})`)) visit(body); continue; }
      if (head.startsWith('@')) continue;
      for (const selector of split(head, ',')) {
        if (!matches(selector, node, ancestors)) continue;
        const score = specificity(selector);
        for (const declaration of body.split(';')) {
          const colon = declaration.indexOf(':'); if (colon < 0) continue;
          const property = declaration.slice(0, colon).trim(), value = declaration.slice(colon + 1).trim();
          const previous = result.get(property); order++;
          if (!previous || score > previous.score || score === previous.score && order > previous.order) result.set(property, { value, score, order, selector });
        }
      }
    }
  }
  visit(source.replace(/\/\*[\s\S]*?\*\//g, ''));
  return Object.fromEntries([...result].map(([property, winner]) => [property, winner.value]));
}
