import { config } from '../config.js';

/*
 * Exchange rates for the converter under every price (the blue ▾, public/fxchip.js).
 * Ported from InvoiceWEB's src/rates/client.js — keep the two alike.
 *
 * Fetched here rather than from the browser: one cached copy serves every
 * page open, and only the side that did the fetching knows how old a rate is,
 * so a stale one can be labelled stale.
 *
 * Base is always USD: every rate is USD → code, so a cross rate is
 * `(amount / rates[from]) * rates[to]` and one payload serves every pair.
 */

/* Coinbase moves continuously; open.er-api.com is a once-a-day fix. The
   popup prints which answered — "live" and "daily" are not interchangeable
   words when someone is about to quote a price off the number. */
const SOURCES = [
  { id: 'coinbase', label: 'live', name: 'Coinbase', url: () => config.rates.liveUrl, read: (json) => json?.data?.rates },
  {
    id: 'er-api',
    label: 'daily',
    name: 'open.er-api.com',
    url: () => config.rates.dailyUrl,
    read: (json) => (json?.result === 'success' ? json.rates : null),
  },
];

/* A source that answers 200 without these is a FAILURE, not an empty table —
   the next source is tried. */
const REQUIRED = ['USD', 'EUR', 'GBP', 'AED'];

/* The currencies the popup offers. Curated, as in InvoiceWEB: Coinbase sends
   640-odd codes with crypto mixed in. */
export const CURRENCIES = [
  ['USD', 'US Dollar'], ['EUR', 'Euro'], ['GBP', 'British Pound'], ['AED', 'UAE Dirham'], ['CHF', 'Swiss Franc'],
  ['HKD', 'Hong Kong Dollar'], ['SAR', 'Saudi Riyal'], ['QAR', 'Qatari Riyal'], ['KWD', 'Kuwaiti Dinar'],
  ['BHD', 'Bahraini Dinar'], ['OMR', 'Omani Rial'], ['JPY', 'Japanese Yen'], ['CNY', 'Chinese Yuan'],
  ['SGD', 'Singapore Dollar'], ['INR', 'Indian Rupee'], ['PKR', 'Pakistani Rupee'], ['TRY', 'Turkish Lira'],
  ['AUD', 'Australian Dollar'], ['CAD', 'Canadian Dollar'], ['NZD', 'New Zealand Dollar'], ['SEK', 'Swedish Krona'],
  ['NOK', 'Norwegian Krone'], ['DKK', 'Danish Krone'], ['PLN', 'Polish Zloty'], ['CZK', 'Czech Koruna'],
  ['HUF', 'Hungarian Forint'], ['RON', 'Romanian Leu'], ['RUB', 'Russian Ruble'], ['ILS', 'Israeli Shekel'],
  ['EGP', 'Egyptian Pound'], ['ZAR', 'South African Rand'], ['NGN', 'Nigerian Naira'], ['KRW', 'South Korean Won'],
  ['TWD', 'New Taiwan Dollar'], ['THB', 'Thai Baht'], ['MYR', 'Malaysian Ringgit'], ['IDR', 'Indonesian Rupiah'],
  ['PHP', 'Philippine Peso'], ['VND', 'Vietnamese Dong'], ['BDT', 'Bangladeshi Taka'], ['LKR', 'Sri Lankan Rupee'],
  ['MXN', 'Mexican Peso'], ['BRL', 'Brazilian Real'], ['ARS', 'Argentine Peso'], ['CLP', 'Chilean Peso'],
  ['COP', 'Colombian Peso'], ['PEN', 'Peruvian Sol'], ['UAH', 'Ukrainian Hryvnia'], ['KZT', 'Kazakhstani Tenge'],
  ['MAD', 'Moroccan Dirham'], ['JOD', 'Jordanian Dinar'],
].map(([code, name]) => ({ code, name }));

function toNumbers(rates) {
  const out = {};
  for (const [code, value] of Object.entries(rates || {})) {
    // Coinbase sends strings, and crypto beside fiat: anything that is not a
    // positive number is dropped rather than handed on as NaN.
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) out[code.toUpperCase()] = n;
  }
  return out;
}

async function fetchFrom(source) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), config.rates.timeoutMs);
  try {
    const res = await fetch(source.url(), { signal: ctl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${source.name} answered HTTP ${res.status}`);
    const rates = toNumbers(source.read(await res.json()));
    const missing = REQUIRED.filter((c) => !rates[c]);
    if (missing.length) throw new Error(`${source.name} returned no rate for ${missing.join(', ')}`);
    return { rates, source: source.id, sourceName: source.name, kind: source.label };
  } finally {
    clearTimeout(timer);
  }
}

let cache = null;
let cachedAt = 0;
let inflight = null; // two pages asking on the same tick share one request

async function fetchRates() {
  const failures = [];
  for (const source of SOURCES) {
    try {
      return await fetchFrom(source);
    } catch (err) {
      failures.push(err.message);
    }
  }
  throw new Error(failures.join('; '));
}

/**
 * The current USD-based table. A failed refresh serves the last good copy,
 * marked stale — an hour-old rate is more use than an error.
 */
export async function getRates() {
  if (cache && Date.now() - cachedAt < config.rates.ttlMs) return { ...cache, cachedAt, stale: false };
  inflight ||= fetchRates()
    .then((payload) => {
      cache = payload;
      cachedAt = Date.now();
      return { ...payload, cachedAt, stale: false };
    })
    .finally(() => {
      inflight = null;
    });
  try {
    return await inflight;
  } catch (err) {
    if (cache) return { ...cache, cachedAt, stale: true, error: err.message };
    throw err;
  }
}
