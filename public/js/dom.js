// Tiny DOM builders. Text always goes in as text nodes, never as HTML.

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  setProps(el, props);
  append(el, kids);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function s(tag, props, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  setProps(el, props);
  append(el, kids);
  return el;
}

function setProps(el, props) {
  if (!props) return;
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.setAttribute('class', v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
}

function append(el, kids) {
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
}

// 16px status glyphs, drawn with currentColor.
const GLYPHS = {
  ok: ['M3.5 8.4l3 3 6-6.8'],
  warn: ['M8 3.6v5.2', 'M8 11.6v.8'],
  bad: ['M4.6 4.6l6.8 6.8', 'M11.4 4.6l-6.8 6.8'],
  run: ['M12.4 8a4.4 4.4 0 1 1-1.3-3.1', 'M11.6 2.4v2.6H9'],
  idle: ['M4.5 8h7'],
};

export function glyph(level) {
  return s('svg', { class: 'glyph', viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' },
    (GLYPHS[level] || GLYPHS.idle).map((d) => s('path', { d })));
}

// A status tag: glyph + word, so the meaning never depends on colour alone.
export function tag(level, text) {
  return h('span', { class: `tag tag-${level}` }, glyph(level), h('span', null, text));
}
