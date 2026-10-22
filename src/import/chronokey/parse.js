import * as cheerio from 'cheerio';
import { BASE_URL } from './client.js';
import { parseMoney } from '../../watches/fields.js';
import { locationOf } from '../productlist.js';

/*
 * Chrono Key's pages, read into data. Ported from InvoiceWEB's
 * src/stock/parse.js, keeping the parts proven against the live site and
 * dropping its console-specific rewriting of image urls: here a photo is
 * COPIED into our own storage, so what is wanted is the raw path on
 * Chrono Key's host.
 */

/** The path part of a Chrono Key asset, or null if it is not one of theirs. */
export function assetPath(src) {
  if (!src || src === 'none' || String(src).endsWith('null')) return null;
  // A data:, blob: or javascript: src out of a scraped page is not a photo
  // on their server, and must never become something this app fetches.
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) && !/^https?:/i.test(src)) return null;
  if (/^https?:\/\//i.test(src)) {
    let url;
    try {
      url = new URL(src);
    } catch {
      return null;
    }
    // Off their host is not ours to fetch: a url from a page is untrusted.
    if (url.host !== new URL(BASE_URL()).host) return null;
    return url.pathname + url.search;
  }
  // `../../images//4d2b….jpg` → `/images/4d2b….jpg` (the double slash does
  // not resolve on their server; one slash does — measured by InvoiceWEB).
  const cleaned = String(src)
    .replace(/(\.\.\/)+/g, '')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+/, '');
  return `/${cleaned}`;
}

/*
 * Chrono Key's own "NO IMAGE AVAILABLE" graphic, which a page with no photos
 * shows in its gallery. Not a photo of anything: the first full copy stored
 * it as the photo of 316 watches (22 Oct 2026).
 */
export const isPlaceholder = (path) => /\/no_?image\.(png|jpe?g|gif|webp)$/i.test(String(path || '').split('?')[0]);

/*
 * Chrono Key labels every price it computes with £ and every one of them is
 * EUROS — checked by InvoiceWEB on eight watches against the hand-typed note
 * of what was really paid (1325: note £78,000, column 90,172 = the euros).
 */
export const CK_CODE = 'EUR';
const isPriceLabel = (k) => /pric(e|ing)|paid|cost|amount/i.test(String(k || ''));

export function parseWatchDetail(html, purchaseId) {
  const $ = cheerio.load(html);
  const title = $('h1.h1').first().text().trim();
  const infoCol = $('h1.h1').first().closest('.col-xl-6');

  const category = locationOf(infoCol.children('.ml-2').first().text().trim()) || null;
  const currencyNote = infoCol.children('.ml-2').eq(1).text().trim() || null;

  const images = [];
  $('#image-gallery li').each((_, li) => {
    const path = assetPath($(li).find('img').attr('src'));
    if (path && !isPlaceholder(path) && !images.some((i) => i.path === path)) {
      images.push({ path, caption: $(li).find('div').last().text().trim() });
    }
  });

  const tags = {};
  $('.watch-tags2').each((_, el) => {
    const name = $(el).text().trim().replace(/\s*[✓✗].*$/, '').trim();
    if (name) tags[name] = $(el).find('.fa-check').length > 0;
  });

  const headerPrices = [];
  $('.price-w').each((_, el) => {
    const t = $(el).text().trim();
    if (t) headerPrices.push(t);
  });

  const sections = {};
  $('.detail table').each((_, table) => {
    const sectionName = $(table).find('b').first().text().trim() || 'General';
    sections[sectionName] ||= {};
    $(table)
      .find('tr.detail-row')
      .each((__, row) => {
        const label = $(row).find('td').first().text().trim();
        const cell = $(row).find('td').eq(1);
        const link = cell.find('a').first();
        const value = (link.length && link.text().trim()) || cell.text().trim();
        if (label && value) sections[sectionName][label] = value;
      });
  });

  const status =
    sections['Purchase Details']?.['Item Status'] || sections['Sale details']?.['Item Status'] || null;

  return { id: purchaseId, title, category, currencyNote, images, tags, headerPrices, sections, status };
}

/** The first section value whose label matches. */
export function field(detail, re) {
  for (const fields of Object.values(detail?.sections || {})) {
    for (const [label, value] of Object.entries(fields || {})) {
      if (re.test(label) && String(value).trim()) return String(value).trim();
    }
  }
  return '';
}

const eur = (v) => {
  const n = parseMoney(v);
  return Number.isFinite(n) && n > 1 ? Math.round(n * 100) / 100 : null;
};

/**
 * What a detail page adds to a watch.
 *
 * The product list already carries nearly every field, so this is mostly what
 * the list does not: Chrono Key's own EURO figures for the purchase and the
 * sale, the Box / Papers ticks, and the photos. The other fields are offered
 * too, for a watch that is on Chrono Key but somehow not on the list — they
 * only ever fill a field that is blank.
 */
export function detailFields(d) {
  const tag = (re) => {
    for (const [k, v] of Object.entries(d.tags || {})) if (re.test(k)) return v;
    return null;
  };
  return {
    stock_no: field(d, /^stock\s*(number|no\.?)$/i),
    reference: field(d, /^(referenza|reference|ref)$/i),
    serial: field(d, /^serial(\s*number)?$/i),
    watch_date: field(d, /^watch\s*date$/i),
    condition: field(d, /^condition$/i),
    dial: field(d, /^dial$/i),
    case_material: field(d, /^case(\s*material)?$/i),
    bracelet: field(d, /^(bracelet|strap)$/i),
    movement: field(d, /^(movement|calibre|caliber)$/i),
    purchased_from: field(d, /^purchased\s*from$/i),
    sold_to: field(d, /^sold\s*to$/i),
    location: d.category || '',
    box: tag(/^box$/i),
    papers: tag(/^(papers|warranty|card)$/i),
    purchase_price_eur: eur(field(d, /^purchase\s*price/i)),
    sale_price_eur: eur(field(d, /^(sale|sold)\s*price/i)),
    description: d.currencyNote || '',
  };
}

/* ── the product grid ─────────────────────────────────────────────── */

/** The column headings of the first table on a page that has a stock-number column. */
export function tableHeaders(html) {
  const $ = cheerio.load(html);
  let found = null;
  $('table').each((_, el) => {
    if (found) return;
    const heads = $(el)
      .find('thead th')
      .map((__, th) => $(th).text().replace(/\s+/g, ' ').trim())
      .get();
    if (heads.some((h) => /stock\s*(no|number)/i.test(h))) found = heads;
  });
  return found || [];
}

/** A cell's text: grid cells arrive as markup as often as not. */
export const cellText = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (!s.includes('<')) return s;
  return cheerio.load(`<i>${s}</i>`)('i').text();
};

/**
 * A DataTables reply as heading/value pairs the product-list reader takes.
 *
 * Two shapes, because a grid answers in whichever its page asked for: an
 * ARRAY per row, aligned to the page's own headings, or an OBJECT keyed by
 * field name. The live product grid answers in OBJECTS (first live read, 22
 * Oct 2026), typed — numbers, true/false, null, "2023-04-21T00:00:00" — and
 * the reader knows its keys (productlist.js, GRID_KEYS). Arrays are still read.
 *
 * The purchase id is searched for in whatever markup the row carries. The
 * live grid carries none, so the detail pass finds each watch's page through
 * Chrono Key's search instead.
 */
export function gridRows(json, headers) {
  const data = Array.isArray(json?.data) ? json.data : [];
  return data.map((entry) => {
    const pairs = Array.isArray(entry)
      ? { headers, values: headers.map((_, i) => cellText(entry[i])) }
      : { headers: Object.keys(entry), values: Object.values(entry).map(cellText) };
    const markup = (Array.isArray(entry) ? entry : Object.values(entry))
      .filter((v) => typeof v === 'string' && v.includes('<'))
      .join('');
    const m = markup.match(/DetailPage\/(\d+)/i);
    return { ...pairs, ckId: m ? Number(m[1]) : null };
  });
}

/** The DataTables request a grid makes, with a column block per heading. */
export function dataTableForm({ start, length, columns }) {
  const form = {
    draw: 1,
    start,
    length,
    'search[value]': '',
    'search[regex]': false,
    'order[0][column]': 0,
    'order[0][dir]': 'asc',
  };
  for (let i = 0; i < columns; i += 1) {
    form[`columns[${i}][data]`] = i;
    form[`columns[${i}][name]`] = '';
    form[`columns[${i}][searchable]`] = true;
    form[`columns[${i}][orderable]`] = true;
    form[`columns[${i}][search][value]`] = '';
    form[`columns[${i}][search][regex]`] = false;
  }
  return form;
}

/** "Stock: 1381 - SN: … - model" → "1381" */
export const stockNoOfLabel = (label) => {
  const m = String(label || '').match(/stock\s*[:#]?\s*(\d+)/i);
  return m ? m[1] : null;
};
