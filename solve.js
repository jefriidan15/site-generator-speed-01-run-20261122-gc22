// Fast drop-in for makefun-site 1.0.0: builds the same output tree, byte for byte,
// from the same { site, templates, files } input, but without the reference
// program's per-line regexes, token arrays and repeated string concatenation.
//
// Design: one pass over each source, rendering straight into chunk arrays that
// are joined once; inline markup scanned with a single character-class regex
// that jumps between special characters instead of visiting every character;
// slugs memoised per build; templates compiled once per case into a small node
// tree and rendered into chunk arrays. No clock, no environment, no random
// input: the result is a pure function of the input, exactly like the reference.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];

/** Code-unit order, never the locale's. */
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** True for every code unit JavaScript's \s matches. */
function isWs(c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
    c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

// ------------------------------------------------------------------ escaping

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** Append s[lo..hi) to out with & < > " ' escaped, chunk by chunk. */
function escInto(out, s, lo, hi) {
  let i = lo;
  while (i < hi) {
    ESC_RE.lastIndex = i;
    const m = ESC_RE.exec(s);
    if (m === null || m.index >= hi) { out.push(s.slice(i, hi)); return; }
    if (m.index > i) out.push(s.slice(i, m.index));
    out.push(ESC_MAP[s[m.index]]);
    i = m.index + 1;
  }
}

/** The escaped form of a whole string. */
function esc(s) {
  if (s.indexOf('&') === -1 && s.indexOf('<') === -1 && s.indexOf('>') === -1 &&
      s.indexOf('"') === -1 && s.indexOf("'") === -1) return s;
  const out = [];
  escInto(out, s, 0, s.length);
  return out.join('');
}

// ------------------------------------------------------------------ slugs

const MARK_RE = /\p{M}/gu;

/** The slug of text: NFKD, combining marks dropped, A-Z lowered, each run of
 *  characters other than a-z and 0-9 one "-", none at either end, at most 64
 *  characters (a "-" left at the cut dropped), "untitled" when nothing is left.
 *  Pure-ASCII input takes a regex fast path: NFKD is the identity there and
 *  ASCII holds no combining marks. Results are memoised in `cache` for the build. */
const NON_ASCII_RE = /[^\x00-\x7F]/;
const NON_ALNUM_RUN = /[^a-z0-9]+/g;
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let out;
  if (!NON_ASCII_RE.test(text)) {
    out = text.toLowerCase().replace(NON_ALNUM_RUN, '-');
    if (out.charCodeAt(0) === 45) out = out.slice(1);
    out = out.slice(0, 64);
    let end = out.length;
    while (end > 0 && out[end - 1] === '-') end--;
    if (end !== out.length) out = out.slice(0, end);
  } else {
    const plain = text.normalize('NFKD').replace(MARK_RE, '');
    out = '';
    let gap = false;
    for (let i = 0; i < plain.length; i++) {
      const ch = plain[i];
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
    out = out.slice(0, 64);
    let end = out.length;
    while (end > 0 && out[end - 1] === '-') end--;
    if (end !== out.length) out = out.slice(0, end);
  }
  if (out === '') out = 'untitled';
  cache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = slug + '-' + n;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return Number(date.slice(8, 10)) + ' ' + MONTHS[Number(date.slice(5, 7)) - 1] + ' ' + date.slice(0, 4);
}

// ------------------------------------------------------------------ front matter

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) { // "
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // [
  return { value: raw };
}

function isDigit(c) { return c >= '0' && c <= '9'; }

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: 'key "' + key + '": ' + s.error } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw[4] === '-' && raw[7] === '-';
      if (ok) for (let i = 0; i < 10; i++) { if (i === 4 || i === 7) continue; if (!isDigit(raw[i])) { ok = false; break; } }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let i = 0; i < tags.length; i++) {
        tags[i] = tags[i].trim();
        const t = tags[i];
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-')) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = true; // a slug may not open on "-"
      for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (c === '-') { if (prevDash) return { error: 'key "slug": not a slug' }; prevDash = true; }
        else if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) prevDash = false;
        else return { error: 'key "slug": not a slug' };
      }
      if (prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: 'unknown key "' + key + '"' };
  }
}

const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** A source's front matter and body: { data, body }, or { error }. */
function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i] === '---') { close = i; break; }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (line === '') continue;
    let blank = true;
    for (let k = 0; k < line.length; k++) { const c = line[k]; if (c !== ' ' && c !== '\t') { blank = false; break; } }
    if (blank || line.charCodeAt(0) === 35) continue; // blank, or a "#" comment
    // The line must be "key: value": a key of a-z and "_", a colon, one space.
    const colon = line.indexOf(':');
    let key = null;
    let raw = null;
    if (colon > 0) {
      let good = true;
      for (let k = 0; k < colon; k++) { const c = line[k]; if (!((c >= 'a' && c <= 'z') || c === '_')) { good = false; break; } }
      if (good) {
        const rest = line.slice(colon + 1);
        if (rest === '') { key = line.slice(0, colon); raw = ''; }
        else if (rest.charCodeAt(0) === 32) { key = line.slice(0, colon); raw = rest.slice(1); }
      }
    }
    if (key === null) return { error: 'line ' + (i + 1) + ' is not "key: value"' };
    let end = raw.length;
    while (end > 0 && (raw[end - 1] === ' ' || raw[end - 1] === '\t')) end--;
    if (end !== raw.length) raw = raw.slice(0, end);
    if (!KEYS.has(key)) return { error: 'unknown key "' + key + '"' };
    if (Object.hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
    if (raw === '') return { error: 'key "' + key + '" has no value' };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: lines.slice(close + 1).join('\n') };
}

// ------------------------------------------------------------------ markdown

function trimLine(line) {
  const a = line[0];
  const b = line[line.length - 1];
  if (a !== ' ' && a !== '\t' && b !== ' ' && b !== '\t') return line;
  let s = 0;
  let e = line.length;
  while (s < e && (line[s] === ' ' || line[s] === '\t')) s++;
  while (e > s && (line[e - 1] === ' ' || line[e - 1] === '\t')) e--;
  return line.slice(s, e);
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) { const c = line[i]; if (c !== ' ' && c !== '\t') return false; }
  return true;
}

function isLangChar(c) {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '+' || c === '-';
}

/** A fence-opening line's language, or null. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length && isLangChar(line[j])) j++;
  for (let k = j; k < line.length; k++) { const c = line[k]; if (c !== ' ' && c !== '\t') return null; }
  return line.slice(3, j);
}

/** Whether a line closes a fence. */
function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let k = 3; k < line.length; k++) { const c = line[k]; if (c !== ' ' && c !== '\t') return false; }
  return true;
}

/** A heading line's level and text, or null. */
function headingOf(line) {
  let j = 0;
  while (line[j] === '#') j++;
  if (j < 1 || j > 6) return null;
  const c = line[j];
  if (c !== ' ' && c !== '\t') return null;
  const text = trimLine(line.slice(j + 1));
  return text === '' ? null : { depth: j, text };
}

/** Whether a line is a thematic break. */
function isHr(line) {
  if (line.length < 3) return false;
  const c = line[0];
  if (c !== '-' && c !== '*') return false;
  if (line[1] !== c || line[2] !== c) return false;
  for (let k = 3; k < line.length; k++) { const ch = line[k]; if (ch !== ' ' && ch !== '\t') return false; }
  return true;
}

/** Whether a line ends a paragraph: blank, a fence, a heading or a break.
 *  Only ' ', tab, '`', '#', '-' and '*' can open one of those, so every other
 *  first character answers at once. */
function endsParagraph(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlank(line);
  if (c === 96) return fenceOpen(line) !== null;
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return isHr(line);
  return false;
}

/** A bullet-list line's item text, or null. */
function bulletOf(line) {
  const c = line[0];
  if ((c === '-' || c === '*') && line[1] === ' ') return line.slice(2);
  return null;
}

/** An ordered-list line's start number and item text, or null. */
function orderedOf(line) {
  let j = 0;
  while (j < line.length && line[j] >= '0' && line[j] <= '9') j++;
  if (j < 1 || j > 9) return null;
  if (line[j] !== '.' || line[j + 1] !== ' ') return null;
  return { start: Number(line.slice(0, j)), text: line.slice(j + 2) };
}

/** Whether a line continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let j = 0;
  while (line[j] === ' ') j++;
  return j >= 2 && j < line.length && !isWs(line.charCodeAt(j));
}

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const INLINE_RE = /[&<>"'\\`*[]/g;

/** The first index from `from` where s holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, hi) {
  const last = hi - what.length;
  for (let j = from; j <= last; j++) {
    if (s[j] === '\\' && j + 1 < hi && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, hi) {
  for (let j = from; j < hi; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < hi && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

/** s[lo..hi) rendered inline into out; link(target) resolves a link's href. */
function inlineInto(out, s, lo, hi, link) {
  let i = lo;
  while (i < hi) {
    INLINE_RE.lastIndex = i;
    const m = INLINE_RE.exec(s);
    if (m === null || m.index >= hi) { out.push(s.slice(i, hi)); return; }
    const j = m.index;
    if (j > i) out.push(s.slice(i, j));
    const c = s[j];
    if (c === '&') { out.push('&amp;'); i = j + 1; }
    else if (c === '<') { out.push('&lt;'); i = j + 1; }
    else if (c === '>') { out.push('&gt;'); i = j + 1; }
    else if (c === '"') { out.push('&quot;'); i = j + 1; }
    else if (c === "'") { out.push('&#39;'); i = j + 1; }
    else if (c === '\\') {
      if (j + 1 < hi && ESCAPABLE.has(s[j + 1])) { out.push(s[j + 1] === '>' ? '&gt;' : s[j + 1]); i = j + 2; }
      else { out.push('\\'); i = j + 1; }
    } else if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < hi && k > j + 1) {
        out.push('<code>');
        escInto(out, s, j + 1, k);
        out.push('</code>');
        i = k + 1;
      } else { out.push('`'); i = j + 1; }
    } else if (c === '*') {
      if (j + 1 < hi && s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2, hi);
        if (k > j + 2) {
          out.push('<strong>');
          inlineInto(out, s, j + 2, k, link);
          out.push('</strong>');
          i = k + 2;
        } else { out.push('**'); i = j + 2; }
      } else {
        const k = findSingleStar(s, j + 1, hi);
        if (k > j + 1) {
          out.push('<em>');
          inlineInto(out, s, j + 1, k, link);
          out.push('</em>');
          i = k + 1;
        } else { out.push('*'); i = j + 1; }
      }
    } else { // '['
      const k = findUnescaped(s, ']', j + 1, hi);
      const m2 = k !== -1 && k + 1 < hi && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m2 === -1 || m2 >= hi ? '' : s.slice(k + 2, m2);
      if (target !== '' && !/\s/.test(target)) {
        const href = link(target);
        out.push('<a href="');
        escInto(out, href, 0, href.length);
        out.push('">');
        inlineInto(out, s, j + 1, k, link);
        out.push('</a>');
        i = m2 + 1;
      } else { out.push('['); i = j + 1; }
    }
  }
}

/** A body's HTML, table of contents and excerpt. */
function renderMarkdown(src, link, slugCache) {
  const lines = src.split('\n');
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = '';
  let firstPara = true;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    // Dispatch on the first character: only ' ', tab, '`', '#', '-', '*', '>'
    // and a digit can open anything but a paragraph, so every other line goes
    // straight to the paragraph below without running the classifiers.
    if (line === '') { i++; continue; }
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      if (isBlank(line)) { i++; continue; }
    } else if (c0 === 96) { // '`'
      const lang = fenceOpen(line);
      if (lang !== null) {
        i++;
        out.push('<pre><code' + (lang === '' ? '' : ' class="language-' + esc(lang) + '"') + '>');
        while (i < n && !fenceClose(lines[i])) { escInto(out, lines[i], 0, lines[i].length); out.push('\n'); i++; }
        if (i < n) i++;
        out.push('</code></pre>\n');
        continue;
      }
    } else if (c0 === 35) { // '#'
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slugify(h.text, slugCache), ids);
        const tmp = [];
        inlineInto(tmp, h.text, 0, h.text.length, link);
        const inner = tmp.join('');
        const html = '<h' + h.depth + ' id="' + id + '">' + inner + '</h' + h.depth + '>';
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html: inner });
        out.push(html + '\n');
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) { // '-' or '*'
      if (isHr(line)) { out.push('<hr>\n'); i++; continue; }
      const b = bulletOf(line);
      if (b !== null) {
        const items = [[trimLine(b)]];
        i++;
        while (i < n) {
          const t = bulletOf(lines[i]);
          if (t !== null) { items.push([trimLine(t)]); i++; continue; }
          if (isContinued(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; }
          else break;
        }
        out.push('<ul>\n');
        for (const parts of items) {
          const txt = parts.join('\n');
          const tmp = [];
          inlineInto(tmp, txt, 0, txt.length, link);
          out.push('<li>' + tmp.join('') + '</li>\n');
        }
        out.push('</ul>\n');
        continue;
      }
    } else if (c0 === 62) { // '>'
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (const l of body) { const t = trimLine(l); if (t !== '') kept.push(t); }
      if (kept.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        const txt = kept.join('\n');
        const tmp = [];
        inlineInto(tmp, txt, 0, txt.length, link);
        out.push('<blockquote>\n<p>' + tmp.join('') + '</p>\n</blockquote>\n');
      }
      continue;
    } else if (c0 >= 48 && c0 <= 57) { // digit
      const o = orderedOf(line);
      if (o !== null) {
        const items = [[trimLine(o.text)]];
        const start = o.start;
        i++;
        while (i < n) {
          const m = orderedOf(lines[i]);
          if (m !== null) { items.push([trimLine(m.text)]); i++; continue; }
          if (isContinued(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; }
          else break;
        }
        out.push(start !== 1 ? '<ol start="' + start + '">\n' : '<ol>\n');
        for (const parts of items) {
          const txt = parts.join('\n');
          const tmp = [];
          inlineInto(tmp, txt, 0, txt.length, link);
          out.push('<li>' + tmp.join('') + '</li>\n');
        }
        out.push('</ol>\n');
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const txt = body.join('\n');
    const tmp = [];
    inlineInto(tmp, txt, 0, txt.length, link);
    const inner = tmp.join('');
    const html = '<p>' + inner + '</p>';
    if (firstPara) { excerpt = inner; firstPara = false; }
    out.push(html + '\n');
  }
  return { html: out.join(''), toc, excerpt };
}

// ------------------------------------------------------------------ templates

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
  return text.split('.');
}

function blankRange(src, a, b) {
  for (let i = a; i < b; i++) { const c = src[i]; if (c !== ' ' && c !== '\t') return false; }
  return true;
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const nx = src[open + 1];
    if (nx !== '{' && nx !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (nx === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError('template "' + name + '": a ' + (raw ? '{{{' : '{{') + ' is not closed');
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError('template "' + name + '": a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = blankRange(src, lineStart, open) && blankRange(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError('template "' + name + '": an else outside an if');
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError('template "' + name + '": an ' + tag + ' with no open ' + tag.slice(3));
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError('template "' + name + '": {% ' + tag + ' %} is not a tag');
    }
  }
  if (stack.length > 1) throw new TemplateError('template "' + name + '": a ' + stack[stack.length - 1].kind + ' is not closed');
  return root.body;
}

/** The value at `path` in the scope chain. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text. */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function renderNodes(nodes, scope, templates, depth, out) {
  for (const n of nodes) {
    if (n.kind === 'text') out.push(n.text);
    else if (n.kind === 'var') out.push(esc(textOf(lookup(scope, n.path))));
    else if (n.kind === 'raw') out.push(textOf(lookup(scope, n.path)));
    else if (n.kind === 'if') {
      const branch = truthy(lookup(scope, n.path)) !== n.not ? n.then : n.else;
      if (branch !== null) renderNodes(branch, scope, templates, depth, out);
    } else if (n.kind === 'for') {
      const xs = lookup(scope, n.path);
      if (Array.isArray(xs)) {
        for (let k = 0; k < xs.length; k++) {
          const vars = {};
          vars[n.name] = xs[k];
          vars.loop = { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length };
          renderNodes(n.body, { vars, parent: scope }, templates, depth, out);
        }
      }
    } else { // include
      const t = templates.get(n.name);
      if (t !== undefined && depth < 8) renderNodes(t, scope, templates, depth + 1, out);
    }
  }
}

// ------------------------------------------------------------------ the build

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function dirOf(path) {
  const k = path.lastIndexOf('/');
  return k === -1 ? '' : path.slice(0, k);
}

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** The words of a body: its runs of characters other than whitespace. */
function countWords(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const w = !isWs(text.charCodeAt(i));
    if (w && !inWord) n++;
    inWord = w;
  }
  return n;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  const slugCache = new Map();
  const base = input.site.base_url.replace(/\/+$/, '');
  const report = [];
  const broken = new Set();

  // Templates, parsed in code-unit order of name; one that does not parse is
  // reported and left out, as if it were not there.
  const templates = new Map();
  const names = Object.keys(input.templates).sort(cmp);
  for (const name of names) {
    try { templates.set(name, parseTemplate(name, input.templates[name])); }
    catch (err) { if (!(err instanceof TemplateError)) throw err; report.push(err.message); }
  }

  // Sources, sorted by path; ".md" is a source, anything else is static.
  const files = [...input.files].sort((a, b) => cmp(a.path, b.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push(f);
  }

  // Front matter and the checks that drop a source, in order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push('refused ' + s.path + ': ' + fm.error); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    if (s.path.startsWith('tags/')) { report.push('refused ' + s.path + ": tags/ is the generator's own"); continue; }
    if (s.path.startsWith('page/')) { report.push('refused ' + s.path + ": page/ is the generator's own"); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push('refused ' + s.path + ': a post needs a date'); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses'); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push('draft ' + s.path); continue; }
    kept.push(s);
  }

  // Permalinks: each slug made unique in its directory, in source order.
  const bySource = new Map();
  const taken = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) { set = new Set(dir === '' ? RESERVED : []); taken.set(dir, set); }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), set);
    s.outDir = dir === '' ? s.slug : dir + '/' + s.slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  // Markdown, with links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (SCHEME_RE.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null) {
        const pg = bySource.get(path);
        if (pg !== undefined) return pg.url + frag;
        if (staticPaths.has(path)) return base + '/' + path + frag;
      }
      broken.add('broken-link ' + s.path + ' -> ' + target);
      return target;
    };
    const md = renderMarkdown(s.body, link, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: posts newest first, equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => cmp(y.data.date, x.data.date) || cmp(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags, grouped by slug, named as first met walking the posts in order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags ?? [];
    for (const name of tags) {
      const slug = slugify(name, slugCache);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name, slugCache);
      return bySlug.get(slug) ?? { name, slug, url: '' };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmp(x.slug, y.slug));

  // What templates see: cards, pages, links and tag records.
  const linkOf = (s) => s === null ? null : {
    title: s.data.title, url: s.url, date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  };
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(countWords(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const pageOf = (s) => {
    const baseCard = s.post ? cards.get(s) : cardOf(s);
    return {
      ...baseCard,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  };

  // Layouts: every page, the index pages, the tag pages, then the statics.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, templates, 0, out);
    return out.join('');
  };
  for (const s of kept) output[s.outDir + '/index.html'] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pageCount = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pageCount; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: {
        number: k, total: pageCount, url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pageCount ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push('shadowed ' + f.path + ': a built page has its path');
    else output[f.path] = f.content;
  }

  // The report.
  const lines = [...report, ...broken].sort(cmp);
  const pageTotal = kept.filter((s) => !s.post).length;
  lines.push('built ' + pageTotal + ' pages, ' + posts.length + ' posts, ' + tags.length + ' tags and ' + statics.length + ' static files');
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}
