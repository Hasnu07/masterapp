import http from 'node:http';
import sharp from 'sharp';

/*
 * Stand-ins for Chrono Key and the Watch vault, shaped like the real pages as
 * InvoiceWEB's parsers read them. Never the live systems: a test that wrote
 * into, or hammered, somebody's real inventory is not a test.
 */

export const HEADERS = [
  'Product ID', 'Stock No', 'Serial Number', ' Marca', 'Modello', 'Referenza', 'Seller Name', 'Order Type',
  'Purchase Date', 'Purchase Price (£)', 'Cash', 'Card', 'Bank Transfer', 'Crypto', 'PayPal / Chrono24',
  'Retail Price', 'Website Price', 'Watch Month', 'Watch Year', 'Display Case', 'Pouch Number', 'Inspected By',
  'Customisation', 'Dial', 'Size', 'Case', 'Bezel', 'Bracelet', 'Description', 'Papers', 'Service Papers', 'Box',
  'Condition', 'Accessories Cost', 'Consignment Commission (%)', 'Consignment Commission Price',
  'Consignment Actual Cost', 'Sold To', 'Sale Date', 'Sale Price', 'Cash', 'Card', 'Bank Transfer', 'Crypto',
  'PayPal / Chrono24', 'Category',
];

const row = (o) => HEADERS.map((h, i) => {
  const key = h.trim();
  // second payment block
  if (i >= 40 && i <= 44) return o[`sale ${key}`] ?? '';
  return o[key] ?? '';
});

export const PRODUCTS = [
  row({ 'Product ID': 9001, 'Stock No': 1668, 'Serial Number': 'S1668', Marca: 'Rolex', Modello: 'Lady-Datejust',
    Referenza: '278274', 'Seller Name': 'Dealer  One', 'Order Type': 'INVENTORY', 'Purchase Date': '05/09/2026',
    'Purchase Price (£)': '46000.00', Cash: '46000.00', 'Retail Price': '11538.00', 'Website Price': '11538.00',
    'Watch Month': '3', 'Watch Year': '2026', Dial: 'Pink', Size: '31', Case: 'SS', Description: 'aed 46,000 = usd 12,534 as of 23-09-2026',
    Papers: 'Yes', 'Service Papers': 'No', Box: 'No', Condition: 'New', 'Sold To': 'Omar F', 'Sale Date': '25/09/2026',
    'Sale Price': '14000.00', 'sale Crypto': '14000.00', Category: 'Dubai' }),
  row({ 'Product ID': 9002, 'Stock No': 1700, 'Serial Number': 'S1700', Marca: 'Patek Philippe', Modello: 'Nautilus',
    Referenza: '5711/1A-014', 'Seller Name': 'Dealer Two', 'Order Type': 'INVENTORY', 'Purchase Date': '01/10/2026',
    'Purchase Price (£)': '98000.00', 'Bank Transfer': '98000.00', 'Retail Price': '103000.00', 'Watch Month': '9',
    'Watch Year': '2026', Papers: 'Yes', Box: 'Yes', Condition: 'Unworn', Category: 'Watch' }),
  row({ 'Product ID': 9003, 'Stock No': 1701, 'Serial Number': 'S1701', Marca: 'Rolex', Modello: 'Daytona',
    Referenza: '126500LN', 'Seller Name': 'Dealer Three', 'Purchase Date': '10/10/2026', 'Purchase Price (£)': '30000.00',
    Category: 'UK' }),
];

/* What each watch's own page says. Euro figures as Chrono Key computes them. */
export const DETAILS = {
  26001: { stock: '1668', title: 'Rolex Lady-Datejust 278274', category: 'Dubai', note: 'aed 46,000 = usd 12,534',
    buy: '£10,989', sale: '£12,950', box: false, papers: true, images: ['/images//a1.jpg', '../../images/a2.jpg', 'data:image/gif;base64,AAAA'] },
  26002: { stock: '1700', title: 'Patek Philippe Nautilus 5711/1A-014', category: 'Watch', note: '',
    buy: '£98,000', sale: '', box: true, papers: true, images: ['/images/b1.jpg', 'https://evil.example.com/x.jpg'] },
  26003: { stock: '1701', title: 'Rolex Daytona 126500LN', category: 'UK', note: '', buy: '£34,500', sale: '',
    box: true, papers: true, movement: '4131', images: [] },
};

function detailPage(id) {
  const d = DETAILS[id];
  if (!d) return '<html><body>Not found</body></html>';
  const tag = (name, on) => `<span class="watch-tags2">${name} ${on ? '<i class="fa fa-check"></i>✓' : '✗'}</span>`;
  return `<html><body><div class="row"><div class="col-xl-6">
    <h1 class="h1">${d.title}</h1>
    <div class="ml-2">${d.category}</div><div class="ml-2">${d.note}</div>
    ${tag('Box', d.box)} ${tag('Papers', d.papers)}
    <span class="price-w">${d.buy}</span>
  </div></div>
  <ul id="image-gallery">${d.images.map((src, i) => `<li><img src="${src}"><div>Shot ${i + 1}</div></li>`).join('')}</ul>
  <div class="detail">
    <table><tr><td><b>Product</b></td></tr>
      <tr class="detail-row"><td>STOCK NUMBER</td><td>${d.stock}</td></tr>
      <tr class="detail-row"><td>Referenza</td><td>${d.title.split(' ').pop()}</td></tr>
      ${d.movement ? `<tr class="detail-row"><td>Movement</td><td>${d.movement}</td></tr>` : ''}
    </table>
    <table><tr><td><b>Purchase Details</b></td></tr>
      <tr class="detail-row"><td>Purchase Price (£)</td><td>${d.buy}</td></tr>
      <tr class="detail-row"><td>Item Status</td><td>${d.sale ? 'Sold' : 'INVENTORY'}</td></tr>
    </table>
    ${d.sale ? `<table><tr><td><b>Sale details</b></td></tr><tr class="detail-row"><td>Sale Price</td><td>${d.sale}</td></tr></table>` : ''}
  </div></body></html>`;
}

const jpeg = (color) =>
  sharp({ create: { width: 900, height: 700, channels: 3, background: color } }).jpeg().toBuffer();

export async function startChronoKey({ username = 'ck-user', password = 'ck-pass' } = {}) {
  const images = { '/images/a1.jpg': await jpeg('#c33'), '/images/a2.jpg': await jpeg('#3c3'), '/images/b1.jpg': await jpeg('#33c') };
  const sessions = new Set();
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    calls.push(`${req.method} ${url.pathname}`);
    const sid = (req.headers.cookie || '').match(/ck=(\w+)/)?.[1];
    const signed = sid && sessions.has(sid);
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (url.pathname === '/' && req.method === 'GET') {
        res.setHeader('Set-Cookie', 'aspnet=1; path=/');
        return res.end(signed ? '<html>Dashboard</html>'
          : '<form><input name="__RequestVerificationToken" type="hidden" value="tok123"><input name="PasswordHash"></form>');
      }
      if (url.pathname === '/' && req.method === 'POST') {
        const f = new URLSearchParams(body);
        if (f.get('UserName') === username && f.get('PasswordHash') === password && f.get('__RequestVerificationToken') === 'tok123') {
          const s = Math.random().toString(36).slice(2);
          sessions.add(s);
          res.writeHead(302, { Location: '/Dashboard', 'Set-Cookie': `ck=${s}; path=/` });
        } else res.writeHead(302, { Location: '/' });
        return res.end();
      }
      if (!signed) return res.end('<form><input name="PasswordHash"></form> Sign In');
      if (url.pathname === '/Dashboard') return res.end('<html>Dashboard</html>');
      if (url.pathname === '/Stock/AllProducts') {
        return res.end(`<table><thead><tr>${HEADERS.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody></tbody></table>`);
      }
      if (url.pathname === '/Stock/ProductsDataTable') {
        const data = PRODUCTS.map((r, i) => r.map((v, j) => (j === 1 && i === 1 ? `<a href="/Stock/InstockDetailPage/26002">${v}</a>` : String(v))));
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ draw: 1, recordsTotal: data.length, recordsFiltered: data.length, data }));
      }
      if (url.pathname === '/Stock/ToBeShippedList') {
        return res.end('<table><thead><tr><th>Image</th><th>STOCK NUMBER</th><th>Tracking Status</th></tr></thead><tbody><tr><td></td><td>1701</td><td>In transit</td></tr></tbody></table>');
      }
      if (url.pathname === '/api/cms/AutoCompleteProduct') {
        const term = url.searchParams.get('term');
        const hits = Object.entries(DETAILS)
          .filter(([, d]) => d.stock === term || d.stock.includes(term))
          .map(([id, d]) => ({ id: Number(id), value: `Stock: ${d.stock} - SN: x - ${d.title}`, isSold: Boolean(d.sale) }));
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(hits));
      }
      const m = url.pathname.match(/^\/Stock\/InstockDetailPage\/(\d+)$/);
      if (m) return res.end(detailPage(Number(m[1])));
      if (images[url.pathname]) {
        res.setHeader('Content-Type', 'image/jpeg');
        return res.end(images[url.pathname]);
      }
      res.statusCode = 404;
      res.end('not found');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() };
}

export async function startVault({ token = 'vault-key' } = {}) {
  const pics = { '/photos/v1.jpg': await jpeg('#cc3'), '/photos/v2.jpg': await jpeg('#3cc') };
  let base = '';
  const state = () => ({
    dubaiStock: [
      { id: 'v-1668', stockNumber: '1668', status: 'current', brand: 'Rolex', watchModel: 'Lady-Datejust', dial: 'Pink diamonds',
        caseDiameter: '31mm', b2bFinal: { usd: 13500 }, b2cFinal: { usd: 0, aed: 52000 }, photos: [`${base}/photos/v1.jpg`] },
      { id: 'v-1800', stockNumber: '1800', status: 'current', brand: 'Audemars Piguet', watchModel: 'Royal Oak',
        watchReference: '15510ST', watchSerial: 'AP1800', b2bPrice: 41000, b2bCurrency: 'USD', b2cPrice: 1, b2cCurrency: 'ask first',
        photos: [`${base}/photos/v2.jpg`, 'data:image/png;base64,AAAA'] },
    ],
    londonStock: [],
    hkStock: [],
    soldStocks: [{ id: 'v-1700-old', stockNumber: '1700', brand: 'Patek Philippe', b2bUsd: 1 }],
    incomings: [{ id: 'v-1900', stockNumber: '1900', status: 'cancelled', brand: 'Rolex', watchModel: 'GMT' }],
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) {
      if (req.headers['x-worker-token'] !== token) {
        res.statusCode = 401;
        return res.end('{"error":"Unauthorized"}');
      }
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/api/state') return res.end(JSON.stringify({ data: state() }));
      if (url.pathname === '/api/vault-photos') return res.end(JSON.stringify({ data: { 'v-1668': [`${base}/photos/v1.jpg`] } }));
    }
    if (pics[url.pathname]) {
      res.setHeader('Content-Type', 'image/jpeg');
      return res.end(pics[url.pathname]);
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  return { url: `${base}/api/state`, close: () => server.close() };
}
