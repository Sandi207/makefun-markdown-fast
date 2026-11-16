// The block scan owns all state for one document. Inline output is delayed so
// definitions later in the document can resolve links in earlier paragraphs.

const blockNames = new Set('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul'.split(' '));
const literalNames = new Set(['pre', 'script', 'style', 'textarea']);

function isSpace(c) {
  return c === undefined || Number.isNaN(c) || c === 32 || c >= 9 && c <= 13 || c === 160 || c === 5760 || c >= 8192 && c <= 8202 || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
}

function asciiPunctuation(c) {
  return c >= 33 && c <= 47 || c >= 58 && c <= 64 || c >= 91 && c <= 96 || c >= 123 && c <= 126;
}

function punctuation(c) {
  if (c < 128) return asciiPunctuation(c);
  if (c >= 161 && c <= 191 && c !== 170 && c !== 181 && c !== 186 || c === 215 || c === 247) return true;
  return c >= 8192 && c <= 8303 || c >= 8352 && c <= 8399 || c >= 8448 && c <= 11263 || c >= 11776 && c <= 11903 || c >= 12289 && c <= 12351 || c >= 65040 && c <= 65135 || c >= 65281 && c <= 65312 || c >= 65339 && c <= 65344 || c >= 65371 && c <= 65381 || c >= 0x1f000 && c <= 0x1faff;
}

function letter(c) {
  return c >= 65 && c <= 90 || c >= 97 && c <= 122;
}

function digit(c) {
  return c >= 48 && c <= 57;
}

function word(c) {
  return letter(c) || digit(c) || c === 95;
}

function entityAt(s, at) {
  let p = at + 1;
  if (s.charCodeAt(p) === 35) {
    p++;
    const hex = (s.charCodeAt(p) | 32) === 120;
    if (hex) p++;
    const begin = p;
    while (p < s.length) {
      const c = s.charCodeAt(p);
      if (!(digit(c) || hex && ((c | 32) >= 97 && (c | 32) <= 102))) break;
      p++;
    }
    if (p === begin || p - begin > (hex ? 6 : 7) || s.charCodeAt(p) !== 59) return null;
    let value = Number.parseInt(s.slice(begin, p), hex ? 16 : 10);
    if (!value || value > 0x10ffff || value >= 0xd800 && value <= 0xdfff) value = 0xfffd;
    return { end: p + 1, value };
  }
  const begin = p;
  while (word(s.charCodeAt(p))) p++;
  return p > begin && s.charCodeAt(p) === 59 ? { end: p + 1, value: -1 } : null;
}

function escapeHtml(s, all = false, numbers = false) {
  let out = '', start = 0;
  for (let p = 0; p < s.length; p++) {
    let c = s.charCodeAt(p), replacement;
    if (c === 38) {
      const entity = all ? null : entityAt(s, p);
      if (entity) {
        if (numbers && entity.value >= 0) {
          out += s.slice(start, p) + escapeHtml(String.fromCodePoint(entity.value), true);
          p = entity.end - 1;
          start = p + 1;
        } else p = entity.end - 1;
        continue;
      }
      replacement = '&amp;';
    } else if (c === 60) replacement = '&lt;';
    else if (c === 62) replacement = '&gt;';
    else if (c === 34) replacement = '&quot;';
    else if (c === 39) replacement = '&#39;';
    else continue;
    out += s.slice(start, p) + replacement;
    start = p + 1;
  }
  return start ? out + s.slice(start) : s;
}

function unescapeSlashes(s) {
  let out = '', start = 0;
  for (let p = 0; p + 1 < s.length; p++) {
    if (s.charCodeAt(p) === 92 && asciiPunctuation(s.charCodeAt(p + 1))) {
      out += s.slice(start, p) + s[p + 1];
      p++;
      start = p + 1;
    }
  }
  return start ? out + s.slice(start) : s;
}

function urlAttribute(s) {
  try {
    const encoded = encodeURI(s);
    let result = '', at = 0, p;
    while ((p = encoded.indexOf('%25', at)) >= 0) {
      result += encoded.slice(at, p) + '%';
      at = p + 3;
    }
    return escapeHtml(at ? result + encoded.slice(at) : encoded);
  } catch {
    return null;
  }
}

function labelKey(s) {
  let out = '', pending = false;
  for (let p = 0; p < s.length; p++) {
    if (isSpace(s.charCodeAt(p))) pending = out.length > 0;
    else {
      if (pending) out += ' ';
      out += s[p];
      pending = false;
    }
  }
  return out.toLowerCase().toUpperCase().toLowerCase();
}

function sourceLines(s) {
  const result = [];
  let start = 0;
  for (let p = 0; p < s.length; p++) {
    const c = s.charCodeAt(p);
    if (c === 10 || c === 13) {
      result.push({ text: s.slice(start, p), newline: true });
      if (c === 13 && s.charCodeAt(p + 1) === 10) p++;
      start = p + 1;
    }
  }
  if (start < s.length) result.push({ text: s.slice(start), newline: false });
  return result;
}

function indentation(s) {
  let p = 0, columns = 0;
  while (p < s.length) {
    const c = s.charCodeAt(p);
    if (c === 32) columns++;
    else if (c === 9) columns += 4 - columns % 4;
    else break;
    p++;
  }
  return { p, columns, blank: p === s.length };
}

function removeIndent(s, amount) {
  let p = 0, col = 0;
  while (p < s.length && col < amount) {
    const c = s.charCodeAt(p);
    if (c === 32) col++;
    else if (c === 9) col += 4 - col % 4;
    else break;
    p++;
  }
  return (col > amount ? ' '.repeat(col - amount) : '') + s.slice(p);
}

function removeFenceIndent(s, amount) {
  let p = 0;
  while (p < amount && (s.charCodeAt(p) === 32 || s.charCodeAt(p) === 9)) p++;
  return s.slice(p);
}

function expandLeading(s) {
  let p = 0, col = 0, out = '';
  while (p < s.length) {
    const c = s.charCodeAt(p);
    if (c === 32) { out += ' '; col++; }
    else if (c === 9) { const n = 4 - col % 4; out += ' '.repeat(n); col += n; }
    else break;
    p++;
  }
  return out + s.slice(p);
}

function joinLines(lines, from, to, terminal = false) {
  let out = '';
  for (let p = from; p < to; p++) out += lines[p].text + (p + 1 < to || terminal && lines[p].newline ? '\n' : '');
  return out;
}

function heading(s) {
  const ind = indentation(s);
  if (ind.columns > 3 || s.charCodeAt(ind.p) !== 35) return null;
  let p = ind.p;
  while (s.charCodeAt(p) === 35) p++;
  const level = p - ind.p;
  if (level > 6 || p < s.length && s.charCodeAt(p) !== 32 && s.charCodeAt(p) !== 9) return null;
  let text = s.slice(p).trim();
  let end = text.length;
  while (end && text.charCodeAt(end - 1) === 35) end--;
  if (end < text.length && (!end || text.charCodeAt(end - 1) === 32 || text.charCodeAt(end - 1) === 9)) text = text.slice(0, end).trimEnd();
  return { level, text };
}

function underline(s) {
  const ind = indentation(s);
  if (ind.columns > 3) return 0;
  const mark = s.charCodeAt(ind.p);
  if (mark !== 45 && mark !== 61) return 0;
  let p = ind.p;
  while (s.charCodeAt(p) === mark) p++;
  while (s.charCodeAt(p) === 32 || s.charCodeAt(p) === 9) p++;
  return p === s.length ? mark === 61 ? 1 : 2 : 0;
}

function thematic(s) {
  const ind = indentation(s);
  if (ind.columns > 3) return false;
  const mark = s.charCodeAt(ind.p);
  if (mark !== 42 && mark !== 45 && mark !== 95) return false;
  let count = 0;
  for (let p = ind.p; p < s.length; p++) {
    const c = s.charCodeAt(p);
    if (c === mark) count++;
    else if (c !== 32 && c !== 9) return false;
  }
  return count >= 3;
}

function fence(s) {
  const ind = indentation(s);
  if (ind.columns > 3) return null;
  const mark = s.charCodeAt(ind.p);
  if (mark !== 96 && mark !== 126) return null;
  let p = ind.p;
  while (s.charCodeAt(p) === mark) p++;
  if (p - ind.p < 3) return null;
  const info = s.slice(p).trim();
  if (mark === 96 && info.indexOf('`') >= 0) return null;
  return { mark, count: p - ind.p, indent: ind.columns, info };
}

function fencePrefix(s) {
  const ind = indentation(s);
  if (ind.columns > 3) return false;
  const c = s.charCodeAt(ind.p);
  return (c === 96 || c === 126) && s.charCodeAt(ind.p + 1) === c && s.charCodeAt(ind.p + 2) === c;
}

function listMarker(s) {
  const ind = indentation(s);
  if (ind.columns > 3) return null;
  let p = ind.p, ordered = false, number = 1;
  const first = s.charCodeAt(p);
  if (first === 42 || first === 43 || first === 45) p++;
  else if (digit(first)) {
    const begin = p;
    while (digit(s.charCodeAt(p))) p++;
    if (p - begin > 9 || s.charCodeAt(p) !== 46 && s.charCodeAt(p) !== 41) return null;
    ordered = true;
    number = Number(s.slice(begin, p));
    p++;
  } else return null;
  const end = p;
  if (p < s.length && s.charCodeAt(p) !== 32 && s.charCodeAt(p) !== 9) return null;
  let col = ind.columns + end - ind.p;
  const before = col;
  while (s.charCodeAt(p) === 32 || s.charCodeAt(p) === 9) {
    col += s.charCodeAt(p) === 9 ? 4 - col % 4 : 1;
    p++;
  }
  const width = col - before;
  const padding = p === s.length || !width || width > 4 ? 1 : width;
  const text = (width > 4 ? ' '.repeat(width - 1) : '') + s.slice(p);
  return { ordered, number, style: s.charCodeAt(end - 1), indent: ind.columns, contentIndent: before + padding, text, empty: p === s.length };
}

function quoteLine(s) {
  const ind = indentation(s);
  if (ind.columns > 3 || s.charCodeAt(ind.p) !== 62) return null;
  let p = ind.p + 1, remaining = '';
  if (s.charCodeAt(p) === 32) p++;
  else if (s.charCodeAt(p) === 9) {
    remaining = ' '.repeat(3 - (ind.columns + 1) % 4);
    p++;
  }
  let col = ind.columns + p - ind.p;
  if (remaining) col = 4;
  while (s.charCodeAt(p) === 32 || s.charCodeAt(p) === 9) {
    const n = s.charCodeAt(p) === 9 ? 4 - col % 4 : 1;
    remaining += ' '.repeat(n); col += n; p++;
  }
  return remaining + s.slice(p);
}

function inlineTag(s, at) {
  if (s.charCodeAt(at) !== 60) return null;
  if (s.startsWith('<!--', at)) {
    if (s.startsWith('<!-->', at)) return { end: at + 5, name: '', closing: false };
    if (s.startsWith('<!--->', at)) return { end: at + 6, name: '', closing: false };
    const p = s.indexOf('-->', at + 4);
    return p >= 0 ? { end: p + 3, name: '', closing: false } : null;
  }
  if (s.startsWith('<?', at)) {
    const p = s.indexOf('?>', at + 2);
    return p >= 0 ? { end: p + 2, name: '', closing: false } : null;
  }
  if (s.startsWith('<![CDATA[', at)) {
    const p = s.indexOf(']]>', at + 9);
    return p >= 0 ? { end: p + 3, name: '', closing: false } : null;
  }
  if (s.charCodeAt(at + 1) === 33 && letter(s.charCodeAt(at + 2))) {
    const p = s.indexOf('>', at + 3);
    return p >= 0 ? { end: p + 1, name: '', closing: false } : null;
  }
  let p = at + 1;
  const closing = s.charCodeAt(p) === 47;
  if (closing) p++;
  if (!letter(s.charCodeAt(p))) return null;
  const begin = p++;
  while (letter(s.charCodeAt(p)) || digit(s.charCodeAt(p)) || s.charCodeAt(p) === 45) p++;
  const name = s.slice(begin, p).toLowerCase();
  if (closing) {
    while (isSpace(s.charCodeAt(p)) && p < s.length) p++;
    return s.charCodeAt(p) === 62 ? { end: p + 1, name, closing } : null;
  }
  for (;;) {
    const before = p;
    while (isSpace(s.charCodeAt(p)) && p < s.length) p++;
    if (s.charCodeAt(p) === 62) return { end: p + 1, name, closing };
    if (s.charCodeAt(p) === 47 && s.charCodeAt(p + 1) === 62) return { end: p + 2, name, closing, selfClosing: true };
    if (p === before || p >= s.length) return null;
    const c = s.charCodeAt(p);
    if (!letter(c) && c !== 95 && c !== 58) return null;
    p++;
    while (word(s.charCodeAt(p)) || s.charCodeAt(p) === 46 || s.charCodeAt(p) === 58 || s.charCodeAt(p) === 45) p++;
    const endName = p;
    while (isSpace(s.charCodeAt(p)) && p < s.length) p++;
    if (s.charCodeAt(p) !== 61) { p = endName; continue; }
    p++;
    while (isSpace(s.charCodeAt(p)) && p < s.length) p++;
    const q = s.charCodeAt(p);
    if (q === 34 || q === 39) {
      p = s.indexOf(String.fromCharCode(q), p + 1);
      if (p < 0) return null;
      p++;
    } else {
      const beginValue = p;
      while (p < s.length) {
        const v = s.charCodeAt(p);
        if (isSpace(v) || v === 62) break;
        if (v === 34 || v === 39 || v === 61 || v === 60 || v === 96) return null;
        p++;
      }
      if (p === beginValue) return null;
    }
  }
}

function htmlBlock(s, interrupt = false) {
  const ind = indentation(s);
  if (ind.columns > 3 || s.charCodeAt(ind.p) !== 60) return null;
  const rest = s.slice(ind.p);
  if (rest.startsWith('<!--')) return { close: '-->' };
  if (rest.startsWith('<?')) return { close: '?>' };
  if (rest.startsWith('<![CDATA[')) return { close: ']]>' };
  if (rest.charCodeAt(1) === 33 && rest.charCodeAt(2) >= 65 && rest.charCodeAt(2) <= 90) return { close: '>' };
  let p = 1;
  if (rest.charCodeAt(p) === 47) p++;
  const begin = p;
  while (letter(rest.charCodeAt(p)) || digit(rest.charCodeAt(p))) p++;
  const name = rest.slice(begin, p).toLowerCase();
  const boundary = rest.charCodeAt(p);
  if (boundary !== 62 && boundary !== 47 && !isSpace(boundary)) return null;
  if (literalNames.has(name) && rest.charCodeAt(1) !== 47) return { literal: name };
  if (blockNames.has(name)) return { blank: true };
  if (!interrupt) {
    const tag = inlineTag(rest, 0);
    if (tag && !rest.slice(tag.end).trim()) return { blank: true };
  }
  return null;
}

function splitCells(s) {
  let text = s.trim(), result = [], begin = 0;
  if (text.charCodeAt(0) === 124) begin = 1;
  let last = begin;
  for (let p = begin; p < text.length; p++) {
    if (text.charCodeAt(p) !== 124) continue;
    let q = p - 1;
    while (q >= 0 && text.charCodeAt(q) === 92) q--;
    if ((p - q - 1) % 2) continue;
    result.push(text.slice(last, p).trim());
    last = p + 1;
  }
  if (last < text.length || text.charCodeAt(text.length - 1) !== 124) result.push(text.slice(last).trim());
  for (let p = 0; p < result.length; p++) {
    let cell = result[p], out = '', from = 0;
    for (let q = 0; q + 1 < cell.length; q++) {
      if (cell.charCodeAt(q) === 92 && cell.charCodeAt(q + 1) === 124) {
        out += cell.slice(from, q) + '|'; q++; from = q + 1;
      }
    }
    if (from) result[p] = out + cell.slice(from);
  }
  return result;
}

function tableAt(lines, at) {
  if (at + 1 >= lines.length || indentation(lines[at].text).columns > 3 || indentation(lines[at + 1].text).columns > 3) return null;
  const delimiter = lines[at + 1].text;
  if (delimiter.indexOf('|') < 0 && lines[at].text.indexOf('|') < 0) return null;
  const cells = splitCells(delimiter), alignment = [];
  if (!cells.length) return null;
  for (const cell of cells) {
    let p = 0;
    const left = cell.charCodeAt(p) === 58;
    if (left) p++;
    const begin = p;
    while (cell.charCodeAt(p) === 45) p++;
    if (p === begin) return null;
    const right = cell.charCodeAt(p) === 58;
    if (right) p++;
    if (p !== cell.length) return null;
    alignment.push(left && right ? 'center' : right ? 'right' : left ? 'left' : '');
  }
  const header = splitCells(lines[at].text);
  return header.length === alignment.length ? { header, alignment } : null;
}

function destination(s, at, definition = false) {
  let p = at;
  if (s.charCodeAt(p) === 60) {
    p++;
    const begin = p;
    while (p < s.length) {
      const c = s.charCodeAt(p);
      if (c === 92 && asciiPunctuation(s.charCodeAt(p + 1))) { p += 2; continue; }
      if (c === 62) return { value: s.slice(begin, p), end: p + 1 };
      if (c === 60 || c === 10 || c === 13) return null;
      p++;
    }
    return null;
  }
  const begin = p;
  let depth = 0;
  while (p < s.length) {
    const c = s.charCodeAt(p);
    if (c === 92 && asciiPunctuation(s.charCodeAt(p + 1))) { p += 2; continue; }
    if (c === 32 || c === 9 || c === 10 || c === 13 || c < 32) break;
    if (c === 40) depth++;
    if (c === 41) { if (!depth) break; depth--; }
    if (c === 60) break;
    p++;
  }
  if (depth || definition && p === begin) return null;
  return { value: s.slice(begin, p), end: p };
}

function titleAt(s, at) {
  const q = s.charCodeAt(at), close = q === 40 ? 41 : q;
  if (q !== 34 && q !== 39 && q !== 40) return null;
  let p = at + 1;
  while (p < s.length) {
    const c = s.charCodeAt(p);
    if (c === 92 && asciiPunctuation(s.charCodeAt(p + 1))) { p += 2; continue; }
    if (c === close) return { value: s.slice(at + 1, p), end: p + 1 };
    if (c === 10) {
      let next = p + 1;
      while (s.charCodeAt(next) === 32 || s.charCodeAt(next) === 9) next++;
      if (s.charCodeAt(next) === 10) return null;
    }
    if (q === 40 && c === 40) return null;
    p++;
  }
  return null;
}

function definitionAt(lines, at) {
  const line = lines[at].text, ind = indentation(line);
  if (ind.columns > 3 || line.charCodeAt(ind.p) !== 91) return null;
  let endLine = at;
  while (endLine + 1 < lines.length && endLine - at < 40 && !indentation(lines[endLine + 1].text).blank) endLine++;
  const s = joinLines(lines, at, endLine + 1);
  let p = ind.p + 1;
  const begin = p;
  while (p < s.length) {
    const c = s.charCodeAt(p);
    if (c === 92 && asciiPunctuation(s.charCodeAt(p + 1))) { p += 2; continue; }
    if (c === 91) return null;
    if (c === 93) break;
    p++;
  }
  if (s.charCodeAt(p) !== 93 || s.charCodeAt(p + 1) !== 58) return null;
  const key = labelKey(s.slice(begin, p));
  if (!key) return null;
  p += 2;
  while (isSpace(s.charCodeAt(p)) && p < s.length) p++;
  const dest = destination(s, p, true);
  if (!dest) return null;
  p = dest.end;
  const destEnd = p;
  let spaceEnd = p;
  while (isSpace(s.charCodeAt(spaceEnd)) && spaceEnd < s.length) spaceEnd++;
  const title = spaceEnd > p ? titleAt(s, spaceEnd) : null;
  let usedTitle = false;
  if (title) {
    let q = title.end;
    while (s.charCodeAt(q) === 32 || s.charCodeAt(q) === 9) q++;
    if (q === s.length || s.charCodeAt(q) === 10) { p = q; usedTitle = true; }
    else if (s.slice(destEnd, spaceEnd).indexOf('\n') < 0) return null;
  }
  if (!usedTitle) {
    p = destEnd;
    while (s.charCodeAt(p) === 32 || s.charCodeAt(p) === 9) p++;
    if (p < s.length && s.charCodeAt(p) !== 10) return null;
  }
  let consumed = 1;
  for (let q = 0; q < p; q++) if (s.charCodeAt(q) === 10) consumed++;
  return { key, href: unescapeSlashes(dest.value), title: usedTitle ? unescapeSlashes(title.value) : '', consumed };
}

function interrupts(lines, at, paragraph = true, allowTable = true) {
  const s = lines[at].text;
  if (lines[at].lazy) return false;
  if (indentation(s).blank) return !s.length || lines[at].newline;
  if (heading(s) || fence(s) || thematic(s) || quoteLine(s) !== null || htmlBlock(s, paragraph)) return true;
  const marker = listMarker(s);
  if (marker && (!paragraph || !marker.empty && (!marker.ordered || marker.number === 1))) return true;
  return allowTable && tableAt(lines, at) !== null;
}

function scanBlocks(lines, references, nested = false) {
  const nodes = [];
  let at = 0, gap = false;
  let codeContinuation = nested;
  function add(node) {
    node.beforeBlank = gap;
    nodes.push(node);
    gap = false;
  }
  while (at < lines.length) {
    const s = lines[at].text, ind = indentation(s);
    if (ind.blank) { gap = true; at++; continue; }
    if (ind.columns >= 4) {
      let end = at, last = at;
      while (end < lines.length) {
        const d = indentation(lines[end].text);
        if (!d.blank && d.columns < 4) break;
        if (!d.blank) last = end + 1;
        end++;
      }
      let text = '';
      for (let p = at; p < last; p++) text += removeIndent(lines[p].text, 4) + '\n';
      add({ kind: 'code', text, info: '' });
      at = last;
      continue;
    }
    const opening = fence(s);
    if (opening) {
      let end = at + 1, text = '', closed = false;
      for (; end < lines.length; end++) {
        const line = lines[end].text, d = indentation(line);
        let p = d.p;
        while (line.charCodeAt(p) === opening.mark) p++;
        if (d.columns <= 3 && p - d.p >= opening.count && !line.slice(p).trim()) { closed = true; break; }
        text += (opening.mark === 96 ? removeFenceIndent(line, opening.indent) : line) + (lines[end].newline ? '\n' : '');
      }
      if (text.endsWith('\n')) text = text.slice(0, -1);
      if (text) {
        if (text.endsWith('\n')) text = text.slice(0, -1);
        text += '\n';
      }
      add({ kind: 'code', text, info: opening.info });
      at = end + (closed ? 1 : 0);
      continue;
    }
    const h = heading(s);
    if (h) { add({ kind: 'heading', ...h }); at++; continue; }
    if (thematic(s)) { add({ kind: 'hr' }); at++; continue; }
    const quote = quoteLine(s);
    if (quote !== null) {
      const inner = [];
      let end = at, lazy = false, quoteFence = null, quoteHtml = null, fenceLevel = 0, htmlLevel = 0;
      let plainContinuation = false, indentedContinuation = false;
      while (end < lines.length) {
        const q = quoteLine(lines[end].text);
        if (q !== null) {
          if (indentedContinuation && inner.length) inner[inner.length - 1].text += '\n';
          plainContinuation = false;
          indentedContinuation = false;
          inner.push({ text: q, newline: lines[end].newline });
          let deepest = q, level = 0;
          for (;;) {
            const deeper = quoteLine(deepest);
            if (deeper === null) break;
            deepest = deeper;
            level++;
          }
          if (quoteFence && level < fenceLevel) quoteFence = null;
          if (quoteHtml && level < htmlLevel) quoteHtml = null;
          const d = indentation(deepest);
          const f = fence(deepest);
          if (quoteFence) {
            if (f && f.mark === quoteFence.mark && f.count >= quoteFence.count && !f.info) quoteFence = null;
            lazy = false;
          } else if (f) { quoteFence = f; fenceLevel = level; lazy = false; }
          else if (quoteHtml) {
            if (quoteHtml.blank && d.blank || quoteHtml.close && deepest.indexOf(quoteHtml.close) >= 0 || quoteHtml.literal && deepest.toLowerCase().indexOf('</' + quoteHtml.literal + '>') >= 0) quoteHtml = null;
            lazy = false;
          } else {
            quoteHtml = htmlBlock(deepest);
            htmlLevel = level;
            if (quoteHtml && (quoteHtml.close && deepest.indexOf(quoteHtml.close) >= 0 || quoteHtml.literal && deepest.toLowerCase().indexOf('</' + quoteHtml.literal + '>') >= 0)) quoteHtml = null;
            lazy = !d.blank && !heading(deepest) && !thematic(deepest) && !htmlBlock(deepest) && d.columns < 4;
          }
          end++;
          continue;
        }
        if (!lazy || interrupts(lines, end, false)) break;
        const d = indentation(lines[end].text);
        const takeCodeIndent = !plainContinuation && !lines[end].lazy && d.columns >= 4;
        if (!takeCodeIndent && !lines[end].lazy) {
          if (indentedContinuation && inner.length) inner[inner.length - 1].text += '\n';
          plainContinuation = true;
          indentedContinuation = false;
        }
        let lazyText = takeCodeIndent ? removeIndent(lines[end].text, 4) : lines[end].text;
        if (takeCodeIndent) indentedContinuation = true;
        if (underline(lazyText) === 1) lazyText = '    ' + lazyText;
        inner.push({ text: lazyText, newline: lines[end].newline, lazy: true });
        end++;
      }
      if (inner.length) inner[inner.length - 1].newline = false;
      add({ kind: 'quote', children: scanBlocks(inner, references, false) });
      nested = false;
      at = end;
      continue;
    }
    const marker = listMarker(s);
    if (marker) {
      const items = [];
      let end = at, loose = false, trailingGap = false;
      while (end < lines.length) {
        const current = listMarker(lines[end].text);
        if (!current || current.ordered !== marker.ordered || current.style !== marker.style || thematic(lines[end].text)) break;
        const content = [{ text: current.text, newline: lines[end].newline }];
        let p = end + 1, blank = false;
        let lastBlank = false;
        let previousLine = current.text;
        let previousCode = indentation(current.text).columns >= 4;
        while (p < lines.length) {
          const line = lines[p].text, d = indentation(line);
          const next = listMarker(line);
          if (next && d.columns < current.contentIndent) break;
          if (d.blank) {
            content.push({ text: '', newline: lines[p].newline }); blank = true; lastBlank = true; p++; continue;
          }
          if (current.empty && lastBlank) break;
          if (d.columns >= current.contentIndent) {
            const trimmed = removeIndent(expandLeading(line), current.contentIndent);
            content.push({ text: trimmed, newline: lines[p].newline, lazy: !!lines[p].lazy });
            previousLine = trimmed;
            previousCode = indentation(trimmed).columns >= 4;
            blank = false;
            lastBlank = false;
            p++;
            continue;
          }
          if (blank || current.empty || fencePrefix(previousLine) || fencePrefix(line) || heading(previousLine) || thematic(previousLine) || htmlBlock(previousLine, true) || previousCode || interrupts(lines, p)) break;
          content.push({ text: line, newline: lines[p].newline, lazy: !!lines[p].lazy });
          previousLine = line;
          previousCode = false;
          lastBlank = false;
          p++;
        }
        const next = p < lines.length && !thematic(lines[p].text) ? listMarker(lines[p].text) : null;
        trailingGap = lastBlank;
        if (lastBlank && next && next.ordered === marker.ordered && next.style === marker.style) loose = true;
        while (content.length && indentation(content[content.length - 1].text).blank) content.pop();
        if (content.length) {
          const finalLine = content[content.length - 1];
          finalLine.text = finalLine.text.trimEnd();
          finalLine.newline = !!(lastBlank && next && next.ordered === marker.ordered && next.style === marker.style);
        }
        let task = false, checked = false, taskLength = 0;
        if (content.length) {
          const first = content[0].text;
          if (first.charCodeAt(0) === 91 && first.charCodeAt(2) === 93 && (first.charCodeAt(1) === 32 || (first.charCodeAt(1) | 32) === 120) && isSpace(first.charCodeAt(3))) {
            task = true; checked = (first.charCodeAt(1) | 32) === 120;
            let q = 3;
            while (first.charCodeAt(q) === 32 || first.charCodeAt(q) === 9) q++;
            taskLength = q;
          }
        }
        const children = scanBlocks(content, references, true);
        if (task && children.length && children[0].kind === 'paragraph') children[0].text = children[0].text.slice(taskLength);
        for (let child = 1; child < children.length; child++) if (children[child].beforeBlank) loose = true;
        if (children.looseDefinition) loose = true;
        items.push({ children, task, checked });
        end = p;
      }
      add({ kind: 'list', ordered: marker.ordered, start: marker.number, loose, items });
      nested = codeContinuation = false;
      gap = trailingGap;
      at = end;
      continue;
    }
    const html = htmlBlock(s);
    if (html) {
      let end = at;
      if (html.blank) {
        while (end < lines.length && !indentation(lines[end].text).blank) end++;
      } else {
        for (; end < lines.length; end++) {
          const line = lines[end].text;
          if (html.close && line.indexOf(html.close) >= 0 || html.literal && line.toLowerCase().indexOf('</' + html.literal + '>') >= 0) { end++; break; }
        }
      }
      let htmlText = joinLines(lines, at, end, true);
      if (end < lines.length && indentation(lines[end].text).blank && (html.blank || !lines[end].text.length) && htmlText.endsWith('\n')) htmlText = htmlText.slice(0, -1);
      add({ kind: 'html', text: htmlText });
      at = end;
      continue;
    }
    const def = definitionAt(lines, at);
    if (def) {
      if (gap && nodes.length) nodes.looseDefinition = true;
      if (!references.has(def.key)) references.set(def.key, { href: def.href, title: def.title });
      at += def.consumed;
      continue;
    }
    const table = tableAt(lines, at);
    if (table) {
      let end = at + 2;
      const rows = [];
      while (end < lines.length) {
        const rowIndent = indentation(lines[end].text);
        if (rowIndent.blank) {
          if (lines[end].text.indexOf('\t') < 0) break;
          if (!rows.length && (end + 1 === lines.length || interrupts(lines, end + 1))) break;
        } else if (rowIndent.columns >= 4 || interrupts(lines, end, !nested, false)) break;
        const cells = splitCells(lines[end].text);
        cells.length = table.header.length;
        for (let p = 0; p < cells.length; p++) if (cells[p] === undefined) cells[p] = '';
        rows.push(cells); end++;
      }
      add({ kind: 'table', ...table, rows });
      at = end;
      continue;
    }
    let end = at + 1, level = 0;
    const parts = [s];
    while (end < lines.length) {
      level = lines[end].lazy ? 0 : underline(lines[end].text);
      if (level) break;
      if (interrupts(lines, end, !nested)) break;
      const line = lines[end].text;
      if (codeContinuation && !lines[end].lazy && indentation(line).columns >= 4) {
        let codeEnd = end, lastCode = end;
        while (codeEnd < lines.length) {
          const d = indentation(lines[codeEnd].text);
          if (!d.blank && d.columns < 4) break;
          if (!d.blank) lastCode = codeEnd + 1;
          codeEnd++;
        }
        let codeText = '';
        for (let q = end; q < lastCode; q++) codeText += removeIndent(lines[q].text, 4) + (lines[q].newline ? '\n' : '');
        if (lastCode < codeEnd && codeText.endsWith('\n')) codeText = codeText.slice(0, -1);
        parts.push(codeText);
        end = lastCode;
        continue;
      }
      parts.push(line);
      end++;
    }
    if (level) {
      add({ kind: 'heading', level, text: parts.join('\n').trim() });
      end++;
    } else add({ kind: 'paragraph', text: parts.join('\n') });
    at = end;
  }
  return nodes;
}

function matchingBracket(s, at, balancedCode = false) {
  let depth = 0;
  for (let p = at + 1; p < s.length; p++) {
    const c = s.charCodeAt(p);
    if (c === 92 && asciiPunctuation(s.charCodeAt(p + 1))) { p++; continue; }
    if (c === 60) {
      const tag = autoLink(s, p) ?? inlineTag(s, p);
      if (tag) { p = tag.end - 1; continue; }
    }
    if (c === 96 && balancedCode !== 2 && depth === 0) {
      let q = p;
      while (s.charCodeAt(q) === 96) q++;
      const run = q - p;
      if (!balancedCode) {
        if (run >= 2 && s.charCodeAt(q) === 93) { p = q - 1; continue; }
        const next = s.indexOf('`', q);
        if (next < 0) return -1;
        let tail = next + 1;
        while (s.charCodeAt(tail) === 96) tail++;
        p = tail - 1;
        continue;
      }
      let end = q;
      while ((end = s.indexOf('`', end)) >= 0) {
        let tail = end;
        while (s.charCodeAt(tail) === 96) tail++;
        if (tail - end === run) { p = tail - 1; break; }
        end = tail;
      }
      if (end >= 0) continue;
      return -1;
    }
    if (c === 91) depth++;
    if (c === 93) { if (!depth) return p; depth--; }
  }
  return -1;
}

function linkAt(s, at, references, image, balancedCode = false) {
  const opening = image ? at + 1 : at;
  const closing = matchingBracket(s, opening, balancedCode);
  if (closing < 0) return null;
  const text = s.slice(opening + 1, closing);
  let p = closing + 1;
  if (s.charCodeAt(p) === 40) {
    p++;
    while (p < s.length && (s.charCodeAt(p) === 32 || s.charCodeAt(p) === 9 || s.charCodeAt(p) === 10 || s.charCodeAt(p) === 13)) p++;
    const dest = destination(s, p);
    if (dest) {
      p = dest.end;
      const endDest = p;
      while (p < s.length && (s.charCodeAt(p) === 32 || s.charCodeAt(p) === 9 || s.charCodeAt(p) === 10 || s.charCodeAt(p) === 13)) p++;
      let title = null;
      if (p > endDest) title = titleAt(s, p);
      if (title) {
        p = title.end;
        while (isSpace(s.charCodeAt(p)) && p < s.length) p++;
      }
      if (s.charCodeAt(p) === 41) return { text, href: unescapeSlashes(dest.value), title: title ? unescapeSlashes(title.value) : '', end: p + 1, image, inline: true };
    }
  }
  p = closing + 1;
  let key = text;
  if (s.charCodeAt(p) === 91) {
    const end = matchingBracket(s, p, balancedCode);
    if (end >= 0) {
      const ref = s.slice(p + 1, end);
      if (ref) key = ref;
      p = end + 1;
    }
  }
  const reference = references.get(labelKey(key));
  return reference ? { text, ...reference, end: p, image } : null;
}

function emailEnd(s, at, angle = false, emphasisEnd = false) {
  let p = at;
  while (p < s.length) {
    const c = s.charCodeAt(p);
    if (word(c) || c === 46 || c === 43 || c === 45 || angle && (c === 33 || c === 35 || c === 36 || c === 37 || c === 38 || c === 39 || c === 42 || c === 47 || c === 61 || c === 63 || c === 94 || c === 96 || c === 123 || c === 124 || c === 125 || c === 126)) p++;
    else break;
  }
  if (p === at || s.charCodeAt(p) !== 64) return -1;
  p++;
  const domain = p;
  let dots = 0;
  while (p < s.length && (word(s.charCodeAt(p)) || s.charCodeAt(p) === 45 || s.charCodeAt(p) === 46)) {
    if (s.charCodeAt(p) === 46) dots++;
    p++;
  }
  while (s.charCodeAt(p - 1) === 46) { dots--; p--; }
  if (emphasisEnd) while (s.charCodeAt(p - 1) === 95) p--;
  if (p === domain || !angle && !dots || s.charCodeAt(p - 1) === 45 || s.charCodeAt(p - 1) === 95) return -1;
  return p;
}

function autoLink(s, at) {
  let p = at + 1;
  if (s.charCodeAt(at) !== 60) return null;
  const email = emailEnd(s, p, true);
  if (email >= 0 && s.charCodeAt(email) === 62) {
    const text = s.slice(p, email);
    return { end: email + 1, href: 'mailto:' + text, text };
  }
  if (!letter(s.charCodeAt(p))) return null;
  const begin = p++;
  while (letter(s.charCodeAt(p)) || digit(s.charCodeAt(p)) || s.charCodeAt(p) === 43 || s.charCodeAt(p) === 45 || s.charCodeAt(p) === 46) p++;
  if (p - begin < 2 || p - begin > 32 || s.charCodeAt(p) !== 58) return null;
  for (p++; p < s.length; p++) {
    const c = s.charCodeAt(p);
    if (c === 62) { const text = s.slice(begin, p); return { end: p + 1, href: text, text }; }
    if (c === 60 || isSpace(c) || c < 32) return null;
  }
  return null;
}

function bareLink(s, at, emphasisEnd = false) {
  let prefix = '', www = false, emailPrefix = false, xmpp = false;
  const first = s.charCodeAt(at) | 32;
  if (first === 104 && s.slice(at, at + 7).toLowerCase() === 'http://') prefix = s.slice(at, at + 7);
  else if (first === 104 && s.slice(at, at + 8).toLowerCase() === 'https://') prefix = s.slice(at, at + 8);
  else if (first === 102 && s.slice(at, at + 6).toLowerCase() === 'ftp://') prefix = s.slice(at, at + 6);
  else if (first === 119 && s.startsWith('www.', at)) { prefix = 'www.'; www = true; }
  else if (first === 109 && s.startsWith('mailto:', at)) { prefix = 'mailto:'; emailPrefix = true; }
  else if (first === 120 && s.startsWith('xmpp:', at)) { prefix = 'xmpp:'; emailPrefix = true; xmpp = true; }
  if (emailPrefix) {
    let end = emailEnd(s, at + prefix.length);
    if (end < 0) return null;
    if (xmpp && s.charCodeAt(end) === 47) {
      end++;
      while (end < s.length && (word(s.charCodeAt(end)) || s.charCodeAt(end) === 64 || s.charCodeAt(end) === 46 || s.charCodeAt(end) === 45)) end++;
    }
    const text = s.slice(at, end);
    return { end, href: text, text };
  }
  if (prefix) {
    let end = at + prefix.length;
    const begin = end;
    while (end < s.length && !isSpace(s.charCodeAt(end)) && s.charCodeAt(end) !== 60) end++;
    if (end === begin) return null;
    const urlLimit = end;
    let finalBalancedClose = -1;
    for (let q = at; q < urlLimit; q++) {
      if (s.charCodeAt(q) !== 40) continue;
      const close = s.indexOf(')', q + 1);
      if (close >= 0 && close < urlLimit) { finalBalancedClose = close; q = close; }
      else { end = q; break; }
    }
    for (;;) {
      const c = s.charCodeAt(end - 1);
      if (c === 46 || c === 44 || c === 58 || c === 59 || c === 33 || c === 63 || c === 34 || c === 39 || c === 42 || c === 95 || c === 126) { end--; continue; }
      if (c === 41) {
        if (end - 1 === finalBalancedClose) break;
        let balance = 0;
        for (let q = at; q < end; q++) { if (s.charCodeAt(q) === 40) balance++; else if (s.charCodeAt(q) === 41) balance--; }
        if (balance < 0) { end--; continue; }
      }
      break;
    }
    const amp = s.lastIndexOf('&', end - 1);
    if (amp >= begin) {
      const entity = entityAt(s, amp);
      if (entity && entity.end === end + 1 && s.charCodeAt(end) === 59) end = amp;
    }
    if (end <= begin) return null;
    const text = s.slice(at, end);
    return { end, text, href: www ? 'http://' + text : text };
  }
  if (word(s.charCodeAt(at))) {
    const end = emailEnd(s, at, false, emphasisEnd);
    if (end >= 0) { const text = s.slice(at, end); return { end, text, href: 'mailto:' + text }; }
  }
  return null;
}

function inlineMask(s, references) {
  if (s.indexOf('`') < 0 && s.indexOf('[') < 0 && s.indexOf('<') < 0) return null;
  const protectedText = new Uint8Array(s.length);
  // Resolved references shield their labels before raw backtick spans are found.
  for (let p = 0; p < s.length; p++) {
    const c = s.charCodeAt(p);
    if (c === 92 && asciiPunctuation(s.charCodeAt(p + 1))) { p++; continue; }
    const image = c === 33 && s.charCodeAt(p + 1) === 91;
    if (c === 91 || image) {
      const candidate = linkAt(s, p, references, image);
      if (candidate && !candidate.inline) {
        let nested = false, collapsed = false;
        for (let q = 0; q < candidate.text.length; q++) {
          if (candidate.text.charCodeAt(q) === 92) { q++; continue; }
          if (candidate.text.charCodeAt(q) !== 91) continue;
          nested = true;
          const closing = matchingBracket(candidate.text, q, 2);
          if (closing >= 0 && candidate.text.charCodeAt(closing + 1) === 91 && candidate.text.charCodeAt(closing + 2) === 93) collapsed = true;
        }
        if (!nested || collapsed) {
          protectedText.fill(1, p, candidate.end);
          p = candidate.end - 1;
        }
      }
    }
  }
  for (let p = 0; p < s.length; p++) {
    if (protectedText[p]) continue;
    const c = s.charCodeAt(p);
    if (c === 92 && asciiPunctuation(s.charCodeAt(p + 1))) { p++; continue; }
    if (c !== 96) continue;
    let endRun = p + 1;
    while (s.charCodeAt(endRun) === 96) endRun++;
    const count = endRun - p;
    let close = endRun;
    while ((close = s.indexOf('`', close)) >= 0) {
      let tail = close + 1;
      while (s.charCodeAt(tail) === 96) tail++;
      if (!protectedText[close] && tail - close === count) { protectedText.fill(1, p, tail); p = tail - 1; break; }
      close = tail;
    }
    if (close < 0) p = endRun - 1;
  }
  for (let p = 0; p < s.length; p++) {
    if (protectedText[p]) continue;
    const c = s.charCodeAt(p);
    if (c === 92 && asciiPunctuation(s.charCodeAt(p + 1))) { p++; continue; }
    if (c === 60) {
      const tag = autoLink(s, p) ?? inlineTag(s, p);
      if (tag) { protectedText.fill(1, p, tag.end); p = tag.end - 1; continue; }
    }
    const image = c === 33 && s.charCodeAt(p + 1) === 91;
    if (c !== 91 && !image) continue;
    const candidate = linkAt(s, p, references, image, 2);
    if (!candidate?.inline) continue;
    let nested = false;
    for (let q = 0; q < candidate.text.length; q++) {
      if (candidate.text.charCodeAt(q) === 92) { q++; continue; }
      if (candidate.text.charCodeAt(q) === 91) { nested = true; break; }
    }
    if (!nested) { protectedText.fill(1, p, candidate.end); p = candidate.end - 1; }
  }
  return protectedText;
}

function delimiterSides(s, at, end, mark, opening = false) {
  // Leftover delimiters keep the flanking character of their original run.
  if (opening) while (s.charCodeAt(at - 1) === mark) at--;
  const previous = s.charCodeAt(at - 1);
  const before = previous >= 0xdc00 && previous <= 0xdfff ? s.codePointAt(at - 2) : previous;
  const after = s.codePointAt(end);
  const beforePunctuation = (opening || mark === 95 || before !== 126) && punctuation(before);
  const afterPunctuation = (opening || mark === 95 || after !== 126) && punctuation(after);
  const left = !isSpace(after) && (!afterPunctuation || isSpace(before) || beforePunctuation);
  const right = !isSpace(before) && (!beforePunctuation || isSpace(after) || afterPunctuation);
  return {
    open: mark === 95 ? left && (!right || beforePunctuation) : left,
    close: mark === 95 ? right && (!left || afterPunctuation) : right,
  };
}

function emphasisAt(s, at, mask, recursion = 0) {
  const mark = s.charCodeAt(at);
  let startEnd = at + 1;
  while (s.charCodeAt(startEnd) === mark) startEnd++;
  const count = startEnd - at;
  if (!delimiterSides(s, at, startEnd, mark, true).open) return null;
  let balance = count;
  let middle = 0;
  const ambiguous = [];
  for (let p = startEnd; p < s.length; p++) {
    if (s.charCodeAt(p) === 92 && asciiPunctuation(s.charCodeAt(p + 1))) { p++; continue; }
    const otherMark = s.charCodeAt(p);
    if ((otherMark === 42 || otherMark === 95) && otherMark !== mark && recursion < 40 && !(mask && mask[p])) {
      const inner = emphasisAt(s, p, mask, recursion + 1);
      if (inner) {
        let hasClose = false;
        for (let q = inner.begin; q < inner.finish; q++) {
          if (s.charCodeAt(q) !== mark || mask && mask[q]) continue;
          let tail = q + 1;
          while (s.charCodeAt(tail) === mark) tail++;
          if (delimiterSides(s, q, tail, mark).close) { hasClose = true; break; }
          q = tail - 1;
        }
        if (!hasClose) { p = inner.end - 1; continue; }
      }
    }
    if (s.charCodeAt(p) !== mark || mask && mask[p]) continue;
    let tail = p + 1;
    while (s.charCodeAt(tail) === mark) tail++;
    const length = tail - p, sides = delimiterSides(s, p, tail, mark);
    if (sides.close) {
      const restricted = sides.open && (count + length) % 3 === 0 && (count % 3 !== 0 || length % 3 !== 0);
      if (restricted) {
        // A run blocked by the rule of three stays literal in this match.
        middle += length;
      } else {
        if (!sides.open && length >= count && balance > length && ambiguous.length) {
          let pending = 0;
          for (const run of ambiguous) pending += run;
          if (balance === count + pending) { balance -= pending; ambiguous.length = 0; }
        }
        const available = balance;
        balance -= length;
        if (ambiguous.length && ambiguous[ambiguous.length - 1] === length) ambiguous.pop();
        if (balance <= 0) {
          const consumed = Math.min(length, available + middle);
          const usable = Math.min(count, consumed);
          const width = usable % 2 ? 1 : 2;
          return { begin: at + width, finish: p + consumed - width, end: p + consumed, tag: width === 1 ? 'em' : 'strong' };
        }
      }
    } else if (sides.open) balance += length;
    p = tail - 1;
  }
  return null;
}

function canSplitRun(s, at, end, mask) {
  const mark = s.charCodeAt(at), count = end - at;
  if (count === 1) return true;
  for (let p = end; p < s.length; p++) {
    if (s.charCodeAt(p) === 92 && asciiPunctuation(s.charCodeAt(p + 1))) { p++; continue; }
    if (s.charCodeAt(p) !== mark) continue;
    let tail = p + 1;
    while (s.charCodeAt(tail) === mark) tail++;
    const sides = delimiterSides(s, p, tail, mark);
    if (!(mask && mask[p])) {
      if (sides.close && tail - p >= count) return false;
      if (sides.open && sides.close && (count + tail - p) % 3 === 0 && (count % 3 !== 0 || (tail - p) % 3 !== 0)) return false;
      if (sides.close) return tail - p < count;
    }
    p = tail - 1;
  }
  return false;
}

function deletionAt(s, at, mask) {
  if (mask && mask[at]) return null;
  let openingEnd = at + 1;
  while (s.charCodeAt(openingEnd) === 126) openingEnd++;
  const width = openingEnd - at;
  const before = s.charCodeAt(at - 1), after = s.charCodeAt(openingEnd);
  if (width > 2 || isSpace(after) || punctuation(after) && !isSpace(before) && !punctuation(before)) return null;
  let nesting = 1;
  for (let p = openingEnd; p < s.length; p++) {
    if (s.charCodeAt(p) === 92 && asciiPunctuation(s.charCodeAt(p + 1))) { p++; continue; }
    if (s.charCodeAt(p) !== 126) continue;
    let tail = p + 1;
    while (s.charCodeAt(tail) === 126) tail++;
    const previous = s.charCodeAt(p - 1), next = s.charCodeAt(tail);
    if (tail - p === width && !(mask && mask[p])) {
      const closes = !isSpace(previous) && (!punctuation(previous) || isSpace(next) || punctuation(next));
      const opens = !isSpace(next) && (!punctuation(next) || isSpace(previous) || punctuation(previous));
      if (closes && --nesting === 0) return { begin: openingEnd, finish: p, end: tail, tag: 'del' };
      if (!closes && opens) nesting++;
    }
    p = tail - 1;
  }
  return null;
}

function unescapeLabelBrackets(s) {
  let out = '', start = 0;
  for (let p = 0; p + 1 < s.length; p++) {
    if (s.charCodeAt(p) !== 92) continue;
    const next = s.charCodeAt(p + 1);
    if (next === 91 || next === 93) { out += s.slice(start, p) + s[p + 1]; p++; start = p + 1; }
    else if (next === 92) p++;
  }
  return start ? out + s.slice(start) : s;
}

function containsLink(nodes) {
  for (const node of nodes) {
    if (node.kind === 'link') return true;
    if (node.kind === 'emphasis' && containsLink(node.children)) return true;
  }
  return false;
}

function inlineNodes(s, references, inLink = false, depth = 0, documentState = null) {
  const nodes = [];
  const mask = inlineMask(s, references);
  let p = 0, begin = 0, anchor = inLink || !!documentState?.anchor, raw = '';
  function flush(to) {
    if (to > begin) nodes.push({ kind: 'text', text: s.slice(begin, to), raw: !!raw });
  }
  while (p < s.length) {
    const c = s.charCodeAt(p);
    if (c === 92 && (asciiPunctuation(s.charCodeAt(p + 1)) || s.charCodeAt(p + 1) === 10)) {
      flush(p);
      if (s.charCodeAt(p + 1) === 10) {
        nodes.push({ kind: 'br' }); p += 2;
        while (s.charCodeAt(p) === 32 || s.charCodeAt(p) === 9) p++;
      } else { nodes.push({ kind: 'text', text: s[p + 1], escaped: true, raw: !!raw }); p += 2; }
      begin = p; continue;
    }
    if (c === 32) {
      let q = p;
      while (s.charCodeAt(q) === 32) q++;
      if (q - p >= 2 && s.charCodeAt(q) === 10) {
        flush(p); nodes.push({ kind: 'br' }); p = q + 1;
        while (s.charCodeAt(p) === 32 || s.charCodeAt(p) === 9) p++;
        begin = p; continue;
      }
    }
    if (c === 96) {
      let q = p;
      while (s.charCodeAt(q) === 96) q++;
      const count = q - p;
      let end = q, close = -1;
      while ((end = s.indexOf('`', end)) >= 0) {
        let tail = end;
        while (s.charCodeAt(tail) === 96) tail++;
        if (tail - end === count) { close = end; break; }
        end = tail;
      }
      if (close >= 0) {
        flush(p);
        let text = s.slice(q, close);
        if (text.indexOf('\n') >= 0) text = text.split('\n').join(' ');
        if (text.startsWith(' ') && text.endsWith(' ') && text.trim()) text = text.slice(1, -1);
        nodes.push({ kind: 'code', text });
        p = close + count; begin = p; continue;
      }
      p = q; continue;
    }
    if ((c === 91 || c === 33 && s.charCodeAt(p + 1) === 91) && depth < 100) {
      const image = c === 33;
      const link = linkAt(s, p, references, image);
      if (link) {
        const children = inlineNodes(unescapeLabelBrackets(link.text), references, !image, depth + 1);
        const nestedLink = !image && containsLink(children);
        if (!nestedLink) {
          flush(p); nodes.push({ kind: image ? 'image' : 'link', href: link.href, title: link.title, children });
          p = link.end; begin = p; continue;
        }
      }
    }
    if (c === 60) {
      const autolink = autoLink(s, p);
      if (autolink) {
        flush(p); nodes.push({ kind: 'autolink', ...autolink }); p = autolink.end; begin = p; continue;
      }
      const tag = inlineTag(s, p);
      if (tag) {
        flush(p); nodes.push({ kind: 'html', text: s.slice(p, tag.end) });
        if (tag.name === 'a') {
          if (tag.closing) anchor = false;
          else if (isSpace(s.charCodeAt(p + 2))) anchor = true;
        }
        if (tag.name === 'pre' || tag.name === 'code' || tag.name === 'kbd' || tag.name === 'script') raw = tag.closing ? '' : tag.name;
        p = tag.end; begin = p; continue;
      }
    }
    if ((c === 42 || c === 95) && depth < 100) {
      const emphasis = emphasisAt(s, p, mask);
      if (emphasis) {
        flush(p);
        const childState = { anchor };
        const children = inlineNodes(s.slice(emphasis.begin, emphasis.finish), references, inLink, depth + 1, childState);
        anchor = childState.anchor;
        nodes.push({ kind: 'emphasis', tag: emphasis.tag, children });
        p = emphasis.end; begin = p; continue;
      }
      let runEnd = p + 1;
      while (s.charCodeAt(runEnd) === c) runEnd++;
      p = !delimiterSides(s, p, runEnd, c, true).open || !canSplitRun(s, p, runEnd, mask) ? runEnd : p + 1;
      continue;
    }
    if (c === 126 && depth < 100) {
      const deletion = deletionAt(s, p, mask);
      if (deletion) {
        flush(p);
        const childState = { anchor };
        const children = inlineNodes(s.slice(deletion.begin, deletion.finish), references, inLink, depth + 1, childState);
        anchor = childState.anchor;
        nodes.push({ kind: 'emphasis', tag: 'del', children });
        p = deletion.end; begin = p; continue;
      }
      let q = p + 1;
      while (s.charCodeAt(q) === 126) q++;
      p = q; continue;
    }
    if (!anchor && !raw && (letter(c) || digit(c) || c === 95) && (p === begin || !word(s.charCodeAt(p - 1)) && s.charCodeAt(p - 1) !== 46 && s.charCodeAt(p - 1) !== 45)) {
      const autolink = bareLink(s, p);
      if (autolink) { flush(p); nodes.push({ kind: 'autolink', ...autolink }); p = autolink.end; begin = p; continue; }
    }
    p++;
  }
  flush(p);
  if (documentState) documentState.anchor = anchor;
  return nodes;
}

function renderInlineNodes(nodes, textOnly = false) {
  let out = '';
  for (const node of nodes) {
    if (node.kind === 'text') out += node.raw ? node.text : escapeHtml(node.text, !!node.escaped, !node.escaped);
    else if (node.kind === 'delimiter') out += (textOnly ? '' : node.prefix) + node.text.slice(0, node.remaining) + (textOnly ? '' : node.suffix);
    else if (node.kind === 'code') out += (textOnly ? '' : '<code>') + escapeHtml(node.text, true) + (textOnly ? '' : '</code>');
    else if (node.kind === 'html') { if (!textOnly) out += node.text; }
    else if (node.kind === 'br') out += textOnly ? '\n' : '<br>';
    else if (node.kind === 'emphasis') out += (textOnly ? '' : '<' + node.tag + '>') + renderInlineNodes(node.children, textOnly) + (textOnly ? '' : '</' + node.tag + '>');
    else if (node.kind === 'image') {
      const text = renderInlineNodes(node.children, true);
      if (textOnly) out += text;
      else {
        const href = urlAttribute(node.href);
        if (href === null) out += text;
        else out += '<img src="' + href + '" alt="' + text + '"' + (node.title ? ' title="' + escapeHtml(node.title) + '"' : '') + '>';
      }
    } else if (node.kind === 'link' || node.kind === 'autolink') {
      const text = node.kind === 'autolink' ? escapeHtml(node.text, true) : renderInlineNodes(node.children, textOnly);
      const href = urlAttribute(node.href);
      out += textOnly || href === null ? text : '<a href="' + href + '"' + (node.title ? ' title="' + escapeHtml(node.title) + '"' : '') + '>' + text + '</a>';
    }
  }
  return out;
}

function inline(s, references, documentState) {
  return renderInlineNodes(inlineNodes(s, references, false, 0, documentState));
}

function renderBlocks(nodes, references, tight = false, documentState = { anchor: false }) {
  let out = '';
  for (const node of nodes) {
    if (node.kind === 'paragraph') out += (tight ? '' : '<p>') + inline(node.text, references, documentState) + (tight ? '' : '</p>\n');
    else if (node.kind === 'heading') out += '<h' + node.level + '>' + inline(node.text, references, documentState) + '</h' + node.level + '>\n';
    else if (node.kind === 'hr') out += '<hr>\n';
    else if (node.kind === 'code') {
      let end = 0;
      while (end < node.info.length && !isSpace(node.info.charCodeAt(end))) end++;
      const language = unescapeSlashes(node.info.slice(0, end));
      out += '<pre><code' + (language ? ' class="language-' + escapeHtml(language) + '"' : '') + '>' + escapeHtml(node.text, true) + '</code></pre>\n';
    } else if (node.kind === 'html') out += node.text;
    else if (node.kind === 'quote') out += '<blockquote>\n' + renderBlocks(node.children, references, false, documentState) + '</blockquote>\n';
    else if (node.kind === 'list') {
      const tag = node.ordered ? 'ol' : 'ul';
      out += '<' + tag + (node.ordered && node.start !== 1 ? ' start="' + node.start + '"' : '') + '>\n';
      for (const item of node.items) {
        let body = renderBlocks(item.children, references, !node.loose, documentState);
        if (item.task) {
          const box = '<input' + (item.checked ? ' checked=""' : '') + ' disabled="" type="checkbox"> ';
          if (node.loose && body.startsWith('<p>')) body = '<p>' + box + body.slice(3);
          else body = box + body;
        }
        out += '<li>' + body + '</li>\n';
      }
      out += '</' + tag + '>\n';
    } else if (node.kind === 'table') {
      out += '<table>\n<thead>\n<tr>\n';
      for (let p = 0; p < node.header.length; p++) out += '<th' + (node.alignment[p] ? ' align="' + node.alignment[p] + '"' : '') + '>' + inline(node.header[p], references, documentState) + '</th>\n';
      out += '</tr>\n</thead>\n';
      if (node.rows.length) {
        out += '<tbody>';
        for (const row of node.rows) {
          out += '<tr>\n';
          for (let p = 0; p < row.length; p++) out += '<td' + (node.alignment[p] ? ' align="' + node.alignment[p] + '"' : '') + '>' + inline(row[p], references, documentState) + '</td>\n';
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      out += '</table>\n';
    }
  }
  return out;
}

export function parse(markdown) {
  const references = new Map();
  return renderBlocks(scanBlocks(sourceLines(markdown), references), references);
}
