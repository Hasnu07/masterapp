/*
 * PDFs, made here (asked 7 Nov 2026: "I can ask it for any pdf"): a title,
 * headings, paragraphs and tables — what a sheet or the assistant's answer
 * needs — with nothing to install. The page's own fonts (Helvetica), so a
 * PDF opens anywhere; their alphabet is Western European (WinAnsi): an
 * Arabic or Chinese name prints as "?" — said in the footer when it happens.
 *
 *   renderPdf({ title, subtitle, blocks: [
 *     { type: 'heading', text },
 *     { type: 'text', text },
 *     { type: 'table', columns: [{ label, align: 'right' }], rows: [[...cells]], foot: [[...cells]] },
 *   ] }) → Buffer
 */
import zlib from 'node:zlib';

/* Helvetica and Helvetica-Bold, characters 32–126, from their AFM metrics (thousandths of the size). */
const W = {
  regular: [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584,
    584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667,
    611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722,
    500, 500, 500, 334, 260, 334, 584,
  ],
  bold: [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584,
    584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667,
    611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778,
    556, 556, 500, 389, 280, 389, 584,
  ],
};

/* Unicode → the one byte WinAnsi has for it; anything else is "?" (and counted). */
const WINANSI = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e,
  '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
};
const SPELLED = { '≈': '~', '→': '->', '←': '<-', '✓': 'v', '✗': 'x', '✎': '', '▾': '', '−': '-', '×': 'x', ' ': ' ', '\t': ' ' };

function encode(text, stats) {
  let out = '';
  for (const ch of String(text ?? '')) {
    const c = ch.codePointAt(0);
    if (c >= 32 && c <= 126) out += ch;
    else if (c >= 0xa0 && c <= 0xff) out += String.fromCharCode(c);
    else if (WINANSI[ch]) out += String.fromCharCode(WINANSI[ch]);
    else if (ch in SPELLED) out += SPELLED[ch];
    else if (c === 10 || c === 13) out += ' ';
    else {
      out += '?';
      if (stats) stats.missing += 1;
    }
  }
  return out;
}

/* Width of an already-encoded string, in points. */
function width(s, size, bold = false) {
  const t = bold ? W.bold : W.regular;
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    w += c >= 32 && c <= 126 ? t[c - 32] : 556;
  }
  return (w * size) / 1000;
}

const pdfString = (s) => `(${s.replace(/[\\()]/g, (m) => `\\${m}`)})`;

/* Lines of at most `max` points, broken at spaces; a word longer than a line is cut. */
function wrap(s, size, max, bold = false) {
  const out = [];
  for (const para of s.split('\n')) {
    let line = '';
    for (const word of para.split(/ +/)) {
      const tryLine = line ? `${line} ${word}` : word;
      if (width(tryLine, size, bold) <= max) {
        line = tryLine;
        continue;
      }
      if (line) out.push(line);
      line = word;
      while (width(line, size, bold) > max && line.length > 1) {
        let n = line.length - 1;
        while (n > 1 && width(line.slice(0, n), size, bold) > max) n--;
        out.push(line.slice(0, n));
        line = line.slice(n);
      }
    }
    out.push(line);
  }
  return out;
}

export function renderPdf({ title = '', subtitle = '', blocks = [], landscape } = {}) {
  const stats = { missing: 0 };
  const wide = landscape ?? blocks.some((b) => b.type === 'table' && (b.columns || []).length > 7);
  const [PW, PH] = wide ? [842, 595] : [595, 842];
  const M = 36;
  const inner = PW - 2 * M;
  const pages = [];
  let ops;
  let y;
  const newPage = () => {
    ops = [];
    pages.push(ops);
    y = PH - M;
  };
  const text = (s, x, yy, size, { bold = false, grey = false } = {}) => {
    ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${grey ? '0.42 0.4 0.36 rg' : '0.11 0.1 0.09 rg'} ${x.toFixed(2)} ${yy.toFixed(2)} Td ${pdfString(s)} Tj ET`);
  };
  const ensure = (h, onBreak) => {
    if (y - h < M + 18) {
      newPage();
      onBreak?.();
    }
  };
  newPage();

  if (title) {
    for (const l of wrap(encode(title, stats), 18, inner, true)) {
      text(l, M, y - 18, 18, { bold: true });
      y -= 23;
    }
  }
  if (subtitle) {
    for (const l of wrap(encode(subtitle, stats), 9, inner)) {
      text(l, M, y - 10, 9, { grey: true });
      y -= 12;
    }
  }
  y -= 8;

  for (const b of blocks) {
    if (b.type === 'heading') {
      ensure(30);
      y -= 6;
      for (const l of wrap(encode(b.text, stats), 13, inner, true)) {
        ensure(17);
        text(l, M, y - 13, 13, { bold: true });
        y -= 17;
      }
      y -= 2;
    } else if (b.type === 'text') {
      for (const l of wrap(encode(b.text, stats), 10, inner)) {
        ensure(14);
        text(l, M, y - 10, 10);
        y -= 13.5;
      }
      y -= 6;
    } else if (b.type === 'table') {
      const cols = (b.columns || []).map((c) => (typeof c === 'string' ? { label: c } : c));
      if (!cols.length) continue;
      const size = cols.length > 14 ? 6.5 : cols.length > 9 ? 7.2 : 8.5;
      const pad = 3;
      const enc = (rows) => (rows || []).map((r) => cols.map((_, i) => encode(r?.[i] ?? '', stats)));
      const body = enc(b.rows);
      const foot = enc(b.foot);
      const head = cols.map((c) => encode(c.label, stats));
      // Each column as wide as what it holds (its longest cell, up to a cap), then all scaled to the page.
      const want = cols.map((_, i) => {
        let w = width(head[i], size, true);
        for (const r of [...body.slice(0, 400), ...foot]) w = Math.max(w, width(r[i], size));
        return Math.min(Math.max(w, 18), inner * 0.4) + 2 * pad;
      });
      const total = want.reduce((s, w) => s + w, 0);
      const widths = want.map((w) => (total > inner ? (w * inner) / total : w));
      const tableW = widths.reduce((s, w) => s + w, 0);
      const lineH = size * 1.25;
      const right = cols.map((c) => c.align === 'right');
      const drawRow = (cells, { bold = false, fill = null, line = true } = {}) => {
        const lines = cells.map((s, i) => wrap(s, size, widths[i] - 2 * pad, bold).slice(0, 6));
        const h = Math.max(...lines.map((l) => l.length)) * lineH + 2 * pad;
        return { h, draw: () => {
          if (fill) ops.push(`${fill} rg ${M} ${(y - h).toFixed(2)} ${tableW.toFixed(2)} ${h.toFixed(2)} re f`);
          let x = M;
          lines.forEach((ls, i) => {
            ls.forEach((l, k) => {
              const tx = right[i] ? x + widths[i] - pad - width(l, size, bold) : x + pad;
              text(l, tx, y - pad - size - k * lineH + 1, size, { bold });
            });
            x += widths[i];
          });
          if (line) ops.push(`0.89 0.87 0.82 RG 0.5 w ${M} ${(y - h).toFixed(2)} m ${(M + tableW).toFixed(2)} ${(y - h).toFixed(2)} l S`);
          y -= h;
        } };
      };
      const header = () => {
        const r = drawRow(head, { bold: true, fill: '0.95 0.93 0.89' });
        r.draw();
      };
      ensure(lineH * 3, null);
      if (b.title) {
        text(encode(b.title, stats), M, y - 11, 11, { bold: true });
        y -= 16;
      }
      header();
      for (const cells of body) {
        const r = drawRow(cells);
        ensure(r.h, header);
        r.draw();
      }
      for (const cells of foot) {
        const r = drawRow(cells, { bold: true, fill: '0.98 0.97 0.95' });
        ensure(r.h, header);
        r.draw();
      }
      y -= 12;
    }
  }

  // The foot of every page: its number, when it was made, and a word on any name the fonts could not print.
  const made = new Date().toISOString().slice(0, 16).replace('T', ' ');
  pages.forEach((p, i) => {
    ops = p;
    const left = encode(`Purosangue ERP · ${made} UTC${stats.missing ? ' · ? = a character these fonts cannot print (Arabic, Chinese …)' : ''}`);
    text(left, M, M - 12, 7, { grey: true });
    const right = `${i + 1} / ${pages.length}`;
    text(right, PW - M - width(right, 7), M - 12, 7, { grey: true });
  });

  // The file: catalog, pages, two fonts, and one compressed content stream per page.
  const objs = [];
  const add = (s) => objs.push(s) && objs.length;
  const catalog = add(null);
  const pagesObj = add(null);
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids = [];
  for (const p of pages) {
    const data = zlib.deflateSync(Buffer.from(p.join('\n'), 'latin1'));
    const content = add({ stream: data });
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`
      )
    );
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const info = add(`<< /Title ${pdfString(encode(title || 'Purosangue ERP'))} /Producer (Purosangue ERP) >>`);

  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let offset = parts[0].length;
  const xref = [];
  objs.forEach((o, i) => {
    xref.push(offset);
    let buf;
    if (o && typeof o === 'object' && o.stream) {
      buf = Buffer.concat([
        Buffer.from(`${i + 1} 0 obj\n<< /Length ${o.stream.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
        o.stream,
        Buffer.from('\nendstream\nendobj\n', 'latin1'),
      ]);
    } else buf = Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1');
    parts.push(buf);
    offset += buf.length;
  });
  const xrefAt = offset;
  parts.push(
    Buffer.from(
      `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${xref.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`,
      'latin1'
    )
  );
  return Buffer.concat(parts);
}

/* A table from rows of objects (an SQL answer): its keys become the headings; numbers are set right. */
export function tableBlock(rows, { title, columns } = {}) {
  const keys = columns || [...new Set(rows.flatMap((r) => Object.keys(r || {})))];
  const numeric = keys.map((k) => rows.some((r) => typeof r[k] === 'number') && rows.every((r) => r[k] === null || r[k] === undefined || typeof r[k] === 'number'));
  const show = (v) => (v === null || v === undefined ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === 'number' ? v.toLocaleString('en-GB', { maximumFractionDigits: 2 }) : typeof v === 'object' ? JSON.stringify(v) : String(v));
  return { type: 'table', title, columns: keys.map((k, i) => ({ label: k, align: numeric[i] ? 'right' : 'left' })), rows: rows.map((r) => keys.map((k) => show(r[k]))) };
}
