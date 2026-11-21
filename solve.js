// Fast drop-in for csv-reader 1.0.0 (make.fun's own reference CSV reader).
// Returns exactly csv-reader 1.0.0's {columns, rows, errors} for every input,
// faster: a record with no quote and no CR is split natively, and every other
// record is read by a scanner that jumps between delimiters instead of one
// character at a time. Written from the reference's policy in the kit
// (baselines/csv-reader/vendor/csv-reader/index.js), not copied from it.

/** The next comma, CR or LF at or after the scanner's position. */
const DELIM = /[,\r\n]/g;
/** A quote or CR anywhere in a record: it takes the general path. */
const BAD = /["\r]/;

/** How a field ended: at a comma (the record goes on), at a line break or at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `prefix` up to the next comma or line break: a CR not followed by LF is
  // dropped (stray_cr). Returns the field and how it ended; `added` counts the characters kept.
  // Variant B: indexOf for ',' and LF, then a bounded CR check on the slice; the regex loop only
  // when a CR is actually inside the field (rare).
  function readUnquoted(prefix, start) {
    let value = prefix;
    let added = 0;
    let p = start;
    for (;;) {
      const ci = text.indexOf(',', p);
      const ni = text.indexOf('\n', p);
      let m;
      let isComma;
      if (ci === -1) { m = ni; isComma = false; }
      else if (ni === -1) { m = ci; isComma = true; }
      else if (ci < ni) { m = ci; isComma = true; }
      else { m = ni; isComma = false; }
      if (m === -1) {
        // No delimiter to the end of the text: a CR in the tail is a stray_cr (or several).
        const tail = text.slice(p);
        const ri = tail.indexOf('\r');
        if (ri === -1) {
          value += tail; added += n - p;
          pos = n;
          return { value, ended: END, added };
        }
        // Rare: CRs in the tail; handle them one at a time with the regex loop.
        let q = p;
        for (;;) {
          DELIM.lastIndex = q;
          const mm = DELIM.exec(text);
          if (mm === null) {
            if (q < n) { value += text.slice(q); added += n - q; }
            pos = n;
            return { value, ended: END, added };
          }
          const idx = mm.index;
          const ch = mm[0];
          if (ch === ',') { value += text.slice(q, idx); added += idx - q; pos = idx + 1; return { value, ended: COMMA, added }; }
          if (ch === '\n') { value += text.slice(q, idx); added += idx - q; pos = idx + 1; line += 1; return { value, ended: LINE_BREAK, added }; }
          if (text[idx + 1] === '\n') { value += text.slice(q, idx); added += idx - q; pos = idx + 2; line += 1; return { value, ended: LINE_BREAK, added }; }
          error('stray_cr');
          value += text.slice(q, idx); added += idx - q;
          q = idx + 1;
        }
      }
      const seg = text.slice(p, m);
      if (seg.indexOf('\r') === -1) {
        value += seg; added += m - p;
        if (isComma) { pos = m + 1; return { value, ended: COMMA, added }; }
        pos = m + 1; line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      // A CR sits inside this field: re-read it with the regex loop (rare).
      let q = p;
      for (;;) {
        DELIM.lastIndex = q;
        const mm = DELIM.exec(text);
        if (mm === null) {
          if (q < n) { value += text.slice(q); added += n - q; }
          pos = n;
          return { value, ended: END, added };
        }
        const idx = mm.index;
        const ch = mm[0];
        if (ch === ',') { value += text.slice(q, idx); added += idx - q; pos = idx + 1; return { value, ended: COMMA, added }; }
        if (ch === '\n') { value += text.slice(q, idx); added += idx - q; pos = idx + 1; line += 1; return { value, ended: LINE_BREAK, added }; }
        if (text[idx + 1] === '\n') { value += text.slice(q, idx); added += idx - q; pos = idx + 2; line += 1; return { value, ended: LINE_BREAK, added }; }
        error('stray_cr');
        value += text.slice(q, idx); added += idx - q;
        q = idx + 1;
      }
    }
  }

  // The quoted content in text[j..q) as its value: each CRLF or lone CR inside it is one LF.
  // Counts the line breaks it holds into `line`.
  function quotedContent(j, q) {
    const s = text.slice(j, q);
    if (s.indexOf('\r') === -1) {
      if (s.indexOf('\n') === -1) return s;
      let c = 0;
      let k = -1;
      for (;;) {
        k = s.indexOf('\n', k + 1);
        if (k === -1) break;
        c += 1;
      }
      line += c;
      return s;
    }
    const breaks = s.match(/\r\n|\r|\n/g);
    line += breaks === null ? 0 : breaks.length;
    return s.replace(/\r\n?/g, '\n');
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let parts = null;
    let value;
    let j = pos + 1;
    for (;;) {
      const q = text.indexOf('"', j);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        error('unterminated_quote');
        return readUnquoted('"', open + 1);
      }
      if (text[q + 1] === '"') {
        if (parts === null) parts = [];
        parts.push(quotedContent(j, q));
        parts.push('"');
        j = q + 2;
        continue;
      }
      const tail = quotedContent(j, q);
      value = parts === null ? tail : parts.join('') + tail;
      pos = q + 1;
      break;
    }
    if (pos >= n) return { value, ended: END };
    const c = text[pos];
    if (c === ',') {
      pos += 1;
      return { value, ended: COMMA };
    }
    if (c === '\n') {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    if (c === '\r' && text[pos + 1] === '\n') {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    // What follows the closing quote is appended as it stands, up to the next comma or line break.
    const junk = readUnquoted(value, pos);
    if (junk.added > 0) error('quote_junk');
    return junk;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text[pos];
      if (c === '\n') {
        pos += 1;
        line += 1;
      } else if (c === '\r' && text[pos + 1] === '\n') {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: a record with no quote and no CR is split natively. A trailing
    // CR is the CRLF's only when a LF follows it, so a lone CR at the end of the
    // text still takes the general path (it is a stray_cr there).
    const e = text.indexOf('\n', pos);
    const end = e === -1 ? n : e;
    const crlf = end < n && text[end - 1] === '\r';
    const contentEnd = crlf ? end - 1 : end;
    const seg = text.slice(pos, contentEnd);
    let fields;
    if (!BAD.test(seg)) {
      fields = seg.split(',');
      pos = end === n ? n : end + 1;
      if (end < n) line += 1;
    } else {
      // General path: one field at a time, as the reference reads them.
      fields = [];
      let field;
      let quoted;
      do {
        quoted = text[pos] === '"';
        field = quoted ? readQuoted() : readUnquoted('', pos);
        fields.push(field.value);
      } while (field.ended === COMMA);

      // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
      if (fields.length === 1 && fields[0] === '' && !quoted) continue;
    }

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
