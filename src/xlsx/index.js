/*
 * XLSX, written and read here, with nothing to install (as the PDFs in
 * ../pdf). Enough of Office Open XML for a sheet to go INTO GridCraft and
 * come BACK edited: strings, numbers, dates, booleans, formulas with their
 * cached values, a few cell styles (heading, money, date, number), column
 * widths, hidden columns and hidden sheets, a frozen heading row.
 *
 *   writeXlsx({ sheets: [{ name, hidden? (true, or 'very': not even in Excel's Unhide list), freeze?, cols?: [{ width?, hidden? }],
 *                          rows: [[cell, …], …] }] }) → Buffer
 *     a cell: null | number | string | boolean | { v, f?, style? }
 *     style: 'header' | 'money' | 'int' | 'date' | 'text' | 'formula'
 *
 *   readXlsx(buffer) → { sheets: [{ name, hidden, cells: { 'B3': { v, f?, t } }, maxRow, maxCol }] }
 *     t: 'n' number · 's' string · 'b' boolean · 'd' date (v = 'YYYY-MM-DD') · 'e' error
 *
 * The zip is read and written here too (local headers, central directory,
 * deflate through zlib). ZIP64 and encrypted entries are refused.
 */
import zlib from 'node:zlib';

/* ── zip ──────────────────────────────────────────────────────────── */

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Entries [{ name, data: Buffer }] → a zip. Text parts deflate; nothing is stored uncompressed but the tiny ones. */
export function zip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const deflated = data.length > 64 ? zlib.deflateRawSync(data, { level: 6 }) : null;
    const method = deflated && deflated.length < data.length ? 8 : 0;
    const body = method === 8 ? deflated : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // utf-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt16LE(dosTime, 12);
    c.writeUInt16LE(dosDate, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt16LE(0, 30); // extra
    c.writeUInt16LE(0, 32); // comment
    c.writeUInt16LE(0, 34); // disk
    c.writeUInt16LE(0, 36); // internal attrs
    c.writeUInt32LE(0, 38); // external attrs
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += local.length + name.length + body.length;
  }
  const cdSize = central.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, ...central, end]);
}

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

/** A zip's entries by name: { name → Buffer } (read lazily: a getter per entry). */
export function unzip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw bad('Not a zip file');
  // The end record is in the last 64 KB (its comment is at most 65535 bytes).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw bad('Not a zip file (no end record)');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) throw bad('ZIP64 archives are not read here');
  if (cdOffset + cdSize > buf.length) throw bad('Broken zip (central directory out of range)');
  const files = Object.create(null);
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw bad('Broken zip (central directory)');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 1) throw bad('An encrypted zip is not read here');
    if (size === 0xffffffff || compSize === 0xffffffff) throw bad('ZIP64 entries are not read here');
    if (size > 256 * 1024 * 1024) throw bad(`${name} is too large to read`);
    files[name] = { method, compSize, size, localOffset };
  }
  const read = (name) => {
    const e = files[name];
    if (!e) return null;
    const h = e.localOffset;
    if (h + 30 > buf.length || buf.readUInt32LE(h) !== 0x04034b50) throw bad(`Broken zip (${name})`);
    const start = h + 30 + buf.readUInt16LE(h + 26) + buf.readUInt16LE(h + 28);
    const data = buf.subarray(start, start + e.compSize);
    if (e.method === 0) return data;
    if (e.method === 8) {
      const out = zlib.inflateRawSync(data, { maxOutputLength: 256 * 1024 * 1024 });
      return out;
    }
    throw bad(`${name}: compression method ${e.method} is not read here`);
  };
  return { names: Object.keys(files), read, has: (name) => Boolean(files[name]) };
}

/* ── a small XML reader ───────────────────────────────────────────── */

const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
export const unent = (s) =>
  s.includes('&')
    ? s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e] ?? m))
    : s;
export const ent = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

/**
 * XML → { name, attrs, children: [node | string] }. Namespace prefixes are
 * dropped from element names (x:c → c): the parts are read by local name.
 * Not a validating parser; enough for Office's own XML.
 */
export function parseXml(text) {
  const root = { name: '#root', attrs: {}, children: [] };
  const stack = [root];
  const re = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[\s\S]*?>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.children.push(m[1]);
    else if (m[2] !== undefined) {
      if (stack.length > 1) stack.pop();
    } else if (m[3] !== undefined) {
      const attrs = {};
      const ar = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let a;
      while ((a = ar.exec(m[4] || ''))) attrs[a[1].replace(/^[^:]+:/, (p) => (p === 'xmlns:' ? p : ''))] = unent(a[2] ?? a[3] ?? '');
      const node = { name: m[3].replace(/^[^:]+:/, ''), attrs, children: [] };
      top.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] !== undefined) {
      if (m[6].trim() || stack.length > 1) top.children.push(unent(m[6]));
    }
  }
  return root;
}
const kids = (node, name) => (node ? node.children.filter((c) => typeof c === 'object' && c.name === name) : []);
const kid = (node, name) => kids(node, name)[0] || null;
const textOf = (node) => (node ? node.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('') : '');
/* A rich string: every <t> under it, in order, whatever the runs. */
const richText = (node) => {
  let out = '';
  const walk = (n) => {
    for (const c of n.children) {
      if (typeof c === 'string') continue;
      if (c.name === 't') out += textOf(c);
      else if (c.name !== 'rPh') walk(c);
    }
  };
  walk(node);
  return out;
};

/* ── cells and dates ──────────────────────────────────────────────── */

export function colLetters(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
export function colIndex(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
export const splitRef = (ref) => {
  const m = /^\$?([A-Z]+)\$?(\d+)$/i.exec(ref);
  return m ? { col: colIndex(m[1]), row: Number(m[2]) } : null;
};

/* Excel's day numbers: 1 = 1 Jan 1900, with its leap-year bug (60 = the 29 Feb 1900 that never was). */
const EPOCH = Date.UTC(1899, 11, 30);
export function dateToSerial(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return null;
  const days = Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - EPOCH) / 86400_000);
  return days > 0 ? days : null;
}
export function serialToDate(n) {
  if (!Number.isFinite(n) || n < 1) return null;
  const days = Math.floor(n);
  const d = new Date(EPOCH + days * 86400_000);
  return d.toISOString().slice(0, 10);
}
/* A number format that shows a date: Excel's built-in date ids, or a code with day/month/year letters outside quotes and brackets. */
const DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
export function isDateFormat(id, code) {
  if (DATE_IDS.has(Number(id))) return true;
  if (!code) return false;
  const bare = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
  return /[dmyhs]/i.test(bare) && !/[#0]/.test(bare.replace(/[dmyhs]/gi, '')) ? /[dy]/i.test(bare) || /h.*m|m.*s/i.test(bare) : false;
}

/* ── write ────────────────────────────────────────────────────────── */

const STYLE = { default: 0, header: 1, money: 2, int: 3, date: 4, text: 5, formula: 2 };
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="#,##0"/><numFmt numFmtId="166" formatCode="dd/mm/yyyy"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><color rgb="FF1D1B18"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF3EAD8"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FFD9C9A3"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="left"/></xf>
<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

export function writeXlsx({ sheets, creator = 'Purosangue ERP' }) {
  if (!sheets?.length) throw new Error('A workbook needs a sheet');
  const shared = [];
  const sharedIndex = new Map();
  const str = (s) => {
    const key = String(s);
    let i = sharedIndex.get(key);
    if (i === undefined) {
      i = shared.length;
      shared.push(key);
      sharedIndex.set(key, i);
    }
    return i;
  };
  const sheetXml = (sh) => {
    const rows = [];
    let maxCol = 0;
    (sh.rows || []).forEach((cells, ri) => {
      const out = [];
      (cells || []).forEach((cell, ci) => {
        if (cell === null || cell === undefined || cell === '') return;
        const c = typeof cell === 'object' ? cell : { v: cell };
        const ref = `${colLetters(ci)}${ri + 1}`;
        const s = STYLE[c.style] ?? 0;
        const sAttr = s ? ` s="${s}"` : '';
        maxCol = Math.max(maxCol, ci + 1);
        if (c.f) {
          const f = String(c.f).replace(/^=/, '');
          const cached = c.v;
          if (typeof cached === 'number') out.push(`<c r="${ref}"${sAttr}><f>${ent(f)}</f><v>${cached}</v></c>`);
          else if (typeof cached === 'string' && cached !== '') out.push(`<c r="${ref}"${sAttr} t="str"><f>${ent(f)}</f><v>${ent(cached)}</v></c>`);
          else out.push(`<c r="${ref}"${sAttr}><f>${ent(f)}</f></c>`);
          return;
        }
        const v = c.v;
        if (v === null || v === undefined || v === '') return;
        if (typeof v === 'number' && Number.isFinite(v)) out.push(`<c r="${ref}"${sAttr}><v>${v}</v></c>`);
        else if (typeof v === 'boolean') out.push(`<c r="${ref}"${sAttr} t="b"><v>${v ? 1 : 0}</v></c>`);
        else if (c.style === 'date' && dateToSerial(v)) out.push(`<c r="${ref}"${sAttr}><v>${dateToSerial(v)}</v></c>`);
        else out.push(`<c r="${ref}"${sAttr} t="s"><v>${str(v)}</v></c>`);
      });
      if (out.length) rows.push(`<row r="${ri + 1}">${out.join('')}</row>`);
    });
    const cols = (sh.cols || [])
      .map((c, i) => (c && (c.width || c.hidden) ? `<col min="${i + 1}" max="${i + 1}"${c.width ? ` width="${c.width}" customWidth="1"` : ''}${c.hidden ? ' hidden="1"' : ''}/>` : ''))
      .join('');
    const dim = `A1:${colLetters(Math.max(maxCol, 1) - 1)}${Math.max((sh.rows || []).length, 1)}`;
    const view = sh.freeze
      ? `<sheetViews><sheetView workbookViewId="0"${sh.hidden ? '' : ' tabSelected="1"'}><pane ySplit="${sh.freeze}" topLeftCell="A${sh.freeze + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="B2" sqref="B2"/></sheetView></sheetViews>`
      : `<sheetViews><sheetView workbookViewId="0"/></sheetViews>`;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<dimension ref="${dim}"/>${view}<sheetFormatPr defaultRowHeight="15"/>${cols ? `<cols>${cols}</cols>` : ''}<sheetData>${rows.join('')}</sheetData>
${sh.filter && maxCol > 1 ? `<autoFilter ref="${sh.filter}"/>` : ''}<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>
</worksheet>`;
  };
  const sheetParts = sheets.map((sh, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(sh) }));
  const sheetName = (s, i) => ent(String(s.name || `Sheet${i + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || `Sheet${i + 1}`);
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<workbookPr/><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="14000" activeTab="0"/></bookViews>
<sheets>${sheets.map((s, i) => `<sheet name="${sheetName(s, i)}" sheetId="${i + 1}"${s.hidden === 'very' ? ' state="veryHidden"' : s.hidden ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`).join('')}</sheets>
${sheets.some((s) => s.filter) ? `<definedNames>${sheets.map((s, i) => (s.filter ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${sheetName(s, i).replace(/'/g, "''")}'!${s.filter.replace(/([A-Z]+)(\d+)/g, '$$$1$$$2')}</definedName>` : '')).join('')}</definedNames>` : ''}
<calcPr calcId="191029" fullCalcOnLoad="1"/>
</workbook>`;
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId${sheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`;
  const sst = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared
    .map((s) => `<si><t${/^\s|\s$/.test(s) ? ' xml:space="preserve"' : ''}>${ent(s)}</t></si>`)
    .join('')}</sst>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:creator>${ent(creator)}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
  const appXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>${ent(creator)}</Application></Properties>`;
  return zip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'docProps/core.xml', data: core },
    { name: 'docProps/app.xml', data: appXml },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: wbRels },
    { name: 'xl/styles.xml', data: STYLES_XML },
    { name: 'xl/sharedStrings.xml', data: sst },
    ...sheetParts,
  ]);
}

/* ── read ─────────────────────────────────────────────────────────── */

export function isXlsx(buf) {
  return Buffer.isBuffer(buf) && buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
}

/**
 * Reads a workbook: every sheet's cells by reference. Dates come back as
 * 'YYYY-MM-DD' when the cell's number format shows a date; a formula's text
 * is kept beside its cached value.
 */
export function readXlsx(buf) {
  if (!isXlsx(buf)) throw bad('Not an .xlsx workbook');
  const z = unzip(buf);
  // Where the workbook part is: _rels/.rels says; xl/workbook.xml nearly always.
  let wbPath = 'xl/workbook.xml';
  const rootRels = z.has('_rels/.rels') ? parseXml(z.read('_rels/.rels').toString('utf8')) : null;
  for (const r of kids(kid(rootRels, 'Relationships'), 'Relationship')) {
    if (/\/officeDocument$/.test(r.attrs.Type || '')) wbPath = r.attrs.Target.replace(/^\//, '');
  }
  if (!z.has(wbPath)) throw bad('Not an .xlsx workbook (no workbook part)');
  const dir = wbPath.includes('/') ? wbPath.slice(0, wbPath.lastIndexOf('/') + 1) : '';
  const resolve = (target) => (target.startsWith('/') ? target.slice(1) : `${dir}${target}`.replace(/[^/]+\/\.\.\//g, ''));
  const wb = parseXml(z.read(wbPath).toString('utf8'));
  const relsPath = `${dir}_rels/${wbPath.slice(dir.length)}.rels`;
  const rels = {};
  if (z.has(relsPath)) {
    for (const r of kids(kid(parseXml(z.read(relsPath).toString('utf8')), 'Relationships'), 'Relationship')) rels[r.attrs.Id] = { type: r.attrs.Type || '', target: resolve(r.attrs.Target || '') };
  }
  // Shared strings.
  let shared = [];
  const sstRel = Object.values(rels).find((r) => /\/sharedStrings$/.test(r.type));
  const sstPath = sstRel?.target || `${dir}sharedStrings.xml`;
  if (z.has(sstPath)) shared = kids(kid(parseXml(z.read(sstPath).toString('utf8')), 'sst'), 'si').map(richText);
  // Styles: which cell formats show a date.
  const dateStyles = new Set();
  const stRel = Object.values(rels).find((r) => /\/styles$/.test(r.type));
  const stPath = stRel?.target || `${dir}styles.xml`;
  if (z.has(stPath)) {
    const ss = kid(parseXml(z.read(stPath).toString('utf8')), 'styleSheet');
    const codes = {};
    for (const f of kids(kid(ss, 'numFmts'), 'numFmt')) codes[f.attrs.numFmtId] = f.attrs.formatCode;
    kids(kid(ss, 'cellXfs'), 'xf').forEach((xf, i) => {
      const id = xf.attrs.numFmtId;
      if (id !== undefined && isDateFormat(id, codes[id])) dateStyles.add(i);
    });
  }
  const sheets = [];
  for (const s of kids(kid(kid(wb, 'workbook'), 'sheets'), 'sheet')) {
    const rel = rels[s.attrs.id] || rels[s.attrs['r:id']];
    const path = rel?.target;
    if (!path || !z.has(path)) continue;
    const cells = {};
    let maxRow = 0;
    let maxCol = 0;
    const ws = kid(parseXml(z.read(path).toString('utf8')), 'worksheet');
    for (const row of kids(kid(ws, 'sheetData'), 'row')) {
      for (const c of kids(row, 'c')) {
        const ref = c.attrs.r;
        const at = ref && splitRef(ref);
        if (!at) continue;
        const t = c.attrs.t || 'n';
        const f = kid(c, 'f');
        const vNode = kid(c, 'v');
        const raw = vNode ? textOf(vNode) : null;
        const out = {};
        if (f) {
          // A shared formula's followers carry only si: their text is the master's, which we do not expand — the value stands.
          const text = textOf(f);
          if (text) out.f = `=${text}`;
          else if (f.attrs.t === 'shared') out.f = '=';
        }
        if (t === 's') (out.v = shared[Number(raw)] ?? ''), (out.t = 's');
        else if (t === 'str') (out.v = raw ?? ''), (out.t = 's');
        else if (t === 'inlineStr') (out.v = richText(kid(c, 'is') || { children: [] })), (out.t = 's');
        else if (t === 'b') (out.v = raw === '1'), (out.t = 'b');
        else if (t === 'e') (out.v = raw ?? '#ERR'), (out.t = 'e');
        else if (t === 'd') (out.v = String(raw || '').slice(0, 10)), (out.t = 'd');
        else if (raw !== null && raw !== '') {
          const n = Number(raw);
          if (dateStyles.has(Number(c.attrs.s || 0)) && serialToDate(n)) (out.v = serialToDate(n)), (out.t = 'd');
          else (out.v = n), (out.t = 'n');
        } else if (!out.f) continue;
        else (out.v = null), (out.t = 'n');
        cells[`${colLetters(at.col)}${at.row}`] = out;
        maxRow = Math.max(maxRow, at.row);
        maxCol = Math.max(maxCol, at.col + 1);
      }
    }
    sheets.push({ name: s.attrs.name || '', hidden: s.attrs.state === 'hidden' || s.attrs.state === 'veryHidden', cells, maxRow, maxCol });
  }
  if (!sheets.length) throw bad('The workbook has no sheets');
  return { sheets };
}
