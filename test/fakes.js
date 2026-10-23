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
    'Purchase Price (£)': '46000.00', Cash: '46000.00', 'Retail Price': '11538.00', 'Website Price': '11900.00',
    'Watch Month': '3', 'Watch Year': '2026', Dial: 'Pink', Size: '31', Case: 'SS', Description: 'aed 46,000 = usd 12,534 as of 23-09-2026',
    Papers: 'Yes', 'Service Papers': 'No', Box: 'No', Condition: 'New', 'Sold To': 'Omar F', 'Sale Date': '25/09/2026',
    'Sale Price': '14000.00', 'sale Crypto': '14000.00', Category: 'Dubai' }),
  row({ 'Product ID': 9002, 'Stock No': 1700, 'Serial Number': 'S1700', Marca: 'Patek Philippe', Modello: 'Nautilus',
    Referenza: '5711/1A-014', 'Seller Name': 'Dealer Two', 'Order Type': 'INVENTORY', 'Purchase Date': '01/10/2026',
    'Purchase Price (£)': '98000.00', 'Bank Transfer': '98000.00', 'Retail Price': '103000.00', 'Watch Month': '9',
    'Watch Year': '2026', Papers: 'Yes', Box: 'Yes', Condition: 'Unworn', Category: 'Watch' }),
  row({ 'Product ID': 9003, 'Stock No': 1701, 'Serial Number': 'S1701', Marca: 'Rolex', Modello: 'Daytona',
    Referenza: '126500LN', 'Seller Name': 'Dealer Three', 'Order Type': 'INVENTORY', 'Purchase Date': '10/10/2026',
    'Purchase Price (£)': '30000.00', Category: 'UK' }),
];

/*
 * The same three purchases as the LIVE grid (`/Stock/ProductsDataTable`)
 * answers them — seen on the first live read, 22 Oct 2026: an object per row
 * with these 54 keys, typed values, ISO dates with Chrono Key's clock time,
 * the order type as a code, no markup, and `retailPrice` / `wholeSalePrice`
 * the other way round from what they say (the export's Website and Retail).
 * Exported and read at request time, so a test can change a row.
 */
const gridRow = (o) => ({
  id: null, model: '', makeName: '', serialNumber: null, watchYear: null, watchMonth: null, subModel: '',
  imgProduct: null, stockNumber: null, orderType: 'R', purchasePrice: 0, purchaseDate: null, retailPrice: 0,
  wholeSalePrice: 0, clientName: '', clientType: 'D', shelfBox: null, pouchNumber: null, inspectedBy: null,
  customization: null, dial: null, size: null, material: null, bezel: null, bracelet: null, description: null,
  paperWork: false, servicePaper: false, box: false, accessoriesCost: null, consignmentCommission: null,
  consignmentCommissionPrice: null, consignmentActualCost: null, isSold: false, purchasedFrom: '', category: '',
  saleDate: null, salePrice: null, soldTo: '', purchaseExchangeRate: 1, saleExchangeRate: 1, clientId: '',
  soldToId: null, purchaseCash: null, purchaseCard: null, purchaseWire: null, purchaseCrypto: null,
  purchaseZellVenmo: null, saleCash: null, saleCard: null, saleWire: null, saleCrypto: null, saleZellVenmo: null,
  condition: '',
  ...o,
});

export const GRID = [
  gridRow({ id: 9001, stockNumber: 1668, serialNumber: 'S1668', makeName: 'Rolex', model: 'Lady-Datejust',
    subModel: '278274', purchasedFrom: 'Dealer  One', clientName: 'Dealer One ', purchaseDate: '2026-09-05T11:42:10.53',
    purchasePrice: 46000, purchaseCash: 46000, purchaseCard: 0, purchaseWire: 0, purchaseCrypto: 0, purchaseZellVenmo: 0,
    wholeSalePrice: 11538, retailPrice: 11900, watchMonth: 3, watchYear: 2026, dial: 'Pink', size: '31', material: 'SS',
    description: 'aed 46,000 = usd 12,534 as of 23-09-2026', paperWork: true, servicePaper: false, box: false,
    condition: 'New', isSold: true, soldTo: 'Omar F', saleDate: '2026-09-25T00:00:00', salePrice: 14000, saleCash: 0,
    saleCard: 0, saleWire: 0, saleCrypto: 14000, saleZellVenmo: 0, purchaseExchangeRate: 0.234, category: 'Dubai',
    clientId: 'c-one', soldToId: 'c-omar' }),
  gridRow({ id: 9002, stockNumber: 1700, serialNumber: 'S1700', makeName: 'Patek Philippe', model: 'Nautilus',
    subModel: '5711/1A-014', purchasedFrom: 'Dealer Two', purchaseDate: '2026-10-01T09:00:00', purchasePrice: 98000,
    purchaseWire: 98000, wholeSalePrice: 103000, retailPrice: null, watchMonth: 9, watchYear: 2026, paperWork: true,
    box: true, condition: 'Unworn', category: 'Watch', clientId: 'c-two' }),
  gridRow({ id: 9003, stockNumber: 1701, serialNumber: 'S1701', makeName: 'Rolex', model: 'Daytona',
    subModel: '126500LN', purchasedFrom: 'Dealer Three', purchaseDate: '2026-10-10T16:20:00.1234567',
    purchasePrice: 30000, category: 'UK', clientId: 'c-one' }),
];

/*
 * Chrono Key's client list (/User/ClientListDatatable), in the shape of the
 * first live read, 23 Oct 2026: an object per client, a GUID id, names with
 * stray spaces, clientType D or I, nulls for what is not filled in.
 */
const clientRow = (o) => ({
  id: null, userName: 'user-1', firstName: null, lastName: null, email: null, phoneNumber: null, imgProfile: null,
  roleName: 'Client', dob: '2026-05-20T00:00:00', address: null, imgProofOfId: null, imgProofOfAddress: null,
  clientType: 'D', billFullName: '', billPhoneNumber: null, billAddress1: null, billAddress2: null, billZipCode: null,
  billCity: null, billStateProvince: null, billCountry: null, billCountryName: null, shipFullName: '',
  shipPhoneNumber: null, shipAddress1: null, shipAddress2: null, shipZipCode: null, shipCity: null,
  shipStateProvince: null, shipCountry: null, shipCountryName: null, companyName: null, companyNumber: null,
  xeroContactID: null, dealerName: 'luxurytime', qbCustomerID: null, qbVendorID: null, nickName: null, isActive: true,
  ...o,
});
export const CLIENTS = [
  clientRow({ id: 'c-one', firstName: ' Dealer One', companyName: 'One Watches LLC', phoneNumber: '+971 50 123 4567',
    billAddress1: 'Gold Souk 4', billCity: 'Dubai', billCountryName: 'United Arab Emirates' }),
  clientRow({ id: 'c-two', firstName: 'Dealer', lastName: 'Two ', email: 'two@example.com' }),
  clientRow({ id: 'c-omar', firstName: ' Omar', lastName: 'F', clientType: 'I', nickName: 'Omar the collector' }),
  clientRow({ id: 'c-idle', firstName: 'Nobody Yet', clientType: 'X' }),
];

/*
 * Chrono Key's expenses, as first read 23 Oct 2026: the list page holds every
 * row (booked cost in "£", the date in data-sort), each expense's own page its
 * currency, rate, cost in that currency and payment type. Exported so a test
 * can change one.
 */
export const EXPENSES = {
  2044: { title: 'FERRARI | SHIPMENT EXPENSES | PAID IN CASH | aed 4,300', type: 'Logistics Expense', date: '2026-10-20',
    description: 'FERRARI | SHIPMENT EXPENSES | PAID IN CASH | aed 4,300', booked: '£1,032.00',
    currency: [7, 'AED (DHS)'], rate: '0.2400000000', cost: '4300.00', typeId: [134, 'Logistics Expense'], pay: 0 },
  2041: { title: 'META EXPENSE | PKR 53,073', type: 'Meta Expense', date: '2026-10-21',
    description: 'meta expense | pkr 53,073 = USD 192', booked: '£170.88',
    currency: [2, 'USD ($)'], rate: '0.8900000000', cost: '192.00', typeId: [138, 'Meta Expense'], pay: 1 },
  2030: { title: 'TRIP — Cristian', type: 'Logistics Expense', date: '2026-10-16',
    description: 'Complete\r\n2026-10-14 Flight / Ticket EUR 585\r\n Total $1,701.8', booked: '£1,575.93',
    currency: [1, 'GBP (&#xA3;)'], rate: '1.0000000000', cost: '1575.93', typeId: [134, 'Logistics Expense'], pay: null, loan: true },
  // Pounds, booked under Chrono Key's "EUR" at a pound-to-euro rate; the title says so.
  1987: { title: 'kashan | salary | september 2026 | gbp 3,000', type: 'SALARY', date: '2026-10-01',
    description: 'kashan | salary | september 2026 | gbp 3,000', booked: '£3,540.00',
    currency: [3, 'EUR (&#x20AC;)'], rate: '1.1800000000', cost: '3000.00', typeId: [64, 'SALARY'], pay: 2 },
  // The same, with nothing saying so.
  2007: { title: 'harissa | transfer to Balance', type: 'Commission', date: '2026-10-05',
    description: '', booked: '£590.00', currency: [3, 'EUR (&#x20AC;)'], rate: '1.18', cost: '500.00', typeId: [109, 'Commission'], pay: 2 },
};

function expenseList() {
  const row = ([id, e]) => `<tr><td> </td><td><div>${e.title}</div></td><td><div> ${e.type} </div></td>
    <td><div>${e.description.replace(/\r\n/g, '&#xD;&#xA;')}</div></td><td><div>${e.booked.replace('£', '&#xA3;')}</div></td>
    <td data-sort="${e.date}"><div> ${e.date.split('-').reverse().join('/')} </div></td>
    <td><a class="menu-link px-3 " href="/Stock/AddEditExpense/${id}">Edit</a><a onclick="DeleteFromServer('${id}')">Delete</a></td></tr>`;
  return `<table><thead><tr><th></th><th>Title</th><th>Type</th><th>Description</th><th>Cost</th><th>Created Date</th><th>Actions</th></tr></thead>
    <tbody>${Object.entries(EXPENSES).sort(([a], [b]) => b - a).map(row).join('')}</tbody></table>`;
}

function expensePage(id) {
  const e = EXPENSES[id];
  if (!e) return '<html>Not found</html>';
  const opts = (list, picked) => list.map(([v, txt]) => `<option${v === picked ? ' selected="selected"' : ''} value="${v}">${txt}</option>`).join('');
  return `<form><select class="form-select" id="CurrencyID" name="CurrencyID">${opts(
    [[1, 'GBP (&#xA3;)'], [3, 'EUR (&#x20AC;)'], [2, 'USD ($)'], [7, 'AED (DHS)']],
    e.currency[0]
  )}</select>
    <input data-val="true" id="ExchangeRate" name="ExchangeRate" value="${e.rate}" />
    <input id="Title" name="Title" type="text" value="${e.title}" />
    <input id="InsertedDT" name="InsertedDT" type="date" value="${e.date}" />
    <select id="typeId" name="typeId"><option value="">Select Expense Type</option>${opts([[134, 'Logistics Expense'], [138, 'Meta Expense'], [64, 'SALARY'], [109, 'Commission']], e.typeId[0])}</select>
    <input id="Cost" name="Cost" type="text" value="${e.cost}" />
    <select id="PaymentType" name="PaymentType"><option value="">Select Payment Type</option>${opts(
      [[0, 'Cash'], [1, 'Card'], [2, 'Wire'], [3, 'Crypto'], [4, 'PayPal / Chrono24']],
      e.pay
    )}</select>
    <input class="form-check-input" type="checkbox" id="ExcludeFromProfit" name="ExcludeFromProfit" value="true"${e.loan ? ' checked="checked"' : ''} />
    <textarea id="Description" name="Description">\r\n${e.description}</textarea></form>`;
}

/*
 * Chrono Key's own lists — where a watch IS (src/import/chronokey/lists.js),
 * in the shape of the first live read, 23 Oct 2026: the Inventory tab's feed
 * as <li> cards, the Inventory page declaring its count only in its script,
 * Returned consignments as a table with a RETURN DATE column. Exported so a
 * test can move a watch between them, or break a read:
 *   declared   the count the Inventory page states (default: the cards;
 *              'none' — a page whose script no longer states one)
 *   broken     'card' — one card without a readable stock number;
 *              'returned' — the Returned page without its table
 */
export const LISTS = { inventory: ['1700'], incoming: ['1701'], returned: [], declared: null, broken: null };
const pageId = (stock) => Number(Object.entries(DETAILS).find(([, d]) => d.stock === stock)?.[0]) || 40000 + Number(stock);

function inventoryFeed() {
  const card = (s, i) => `<li class=" pb-3"><div class="card card2 article-item"><div class="overflw">
      <a href="/stock/InstockDetailPage/${pageId(s)}"><img class="card-img-box" src="../../CardImages//x.jpeg" /></a>
      <div class="badge-on-image"><span class="availability-badge availability-${i === 1 ? 'T' : 'A'}">${i === 1 ? 'Checked Out' : 'Available'}</span></div></div>
      <div class="card-body"><a href="/stock/InstockDetailPage/${pageId(s)}"><h5 class="card-title">Watch ${s}</h5></a>
      <p class="shipping">Referenza: &#x9;X${s} </p><p class="shipping">STOCK NUMBER: ${s} </p>
      <div class="shipping" style="margin-bottom:1rem;"> Owner: INVENTORY </div><p class="shipping">Category: Dubai</p></div></div></li>`;
  const cards = LISTS.inventory.map(card);
  if (LISTS.broken === 'card') cards.push('<li><a href="/stock/InstockDetailPage/1"><h5>a card in another template</h5></a></li>');
  return cards.join('\n');
}

function returnedPage() {
  if (LISTS.broken === 'returned') return '<html><h1>Something went wrong</h1></html>';
  return `<table><thead><tr><th>PRODUCT PHOTO</th><th>RETURN DATE</th><th>STOCK NUMBER</th><th>Serial Number</th><th>Actions</th></tr></thead>
    <tbody>${LISTS.returned
      .map((s) => `<tr><td></td><td data-sort="2026-10-16">16/10/2026</td><td><a href="/Stock/InstockDetailPage/${pageId(s)}">${s}</a></td><td>S${s}</td><td>Restore into stock</td></tr>`)
      .join('')}</tbody></table>`;
}

/* What each watch's own page says. Euro figures as Chrono Key computes them. */
export const DETAILS = {
  // a1-again is a1 under a second name, as Chrono Key's own galleries do.
  26001: { stock: '1668', title: 'Rolex Lady-Datejust 278274', category: 'Dubai', note: 'aed 46,000 = usd 12,534',
    buy: '£10,989', sale: '£12,950', box: false, papers: true,
    images: ['/images//a1.jpg', '../../images/a2.jpg', '/images/a1-again.jpg', 'data:image/gif;base64,AAAA'] },
  26002: { stock: '1700', title: 'Patek Philippe Nautilus 5711/1A-014', category: 'Watch', note: '',
    buy: '£98,000', sale: '', box: true, papers: true, images: ['/images/b1.jpg', 'https://evil.example.com/x.jpg'] },
  // No photos: Chrono Key's gallery then shows its own "no image" graphic.
  26003: { stock: '1701', title: 'Rolex Daytona 126500LN', category: 'UK', note: '', buy: '£34,500', sale: '',
    box: true, papers: true, movement: '4131', images: ['../../images/no_image.png'] },
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

/*
 * A photo-like picture: smooth light and a few soft shapes, different for
 * each seed — flat colours would all look alike to a picture comparison.
 * `box` paints a white patch over it, the way the vault's client copies hide
 * a date or a serial; `quality` re-saves it; `width` resizes it.
 */
export function picture(seed, { box = false, quality = 90, width = 900, format = 'jpeg' } = {}) {
  const W = 900;
  const H = 700;
  const px = Buffer.alloc(W * H * 3);
  const spots = [0, 1, 2].map((k) => ({
    x: ((seed * 211 + k * 307) % 800) + 50,
    y: ((seed * 97 + k * 173) % 600) + 50,
    r: 60 + ((seed * 31 + k * 53) % 90),
    c: [(seed * 70 + k * 40) % 255, (seed * 130 + k * 90) % 255, (seed * 50 + k * 150) % 255],
  }));
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 3;
      let rgb = [80 + (x * 120) / W, 90 + (y * 100) / H, 140 - (x * 60) / W];
      for (const s of spots) {
        const d = Math.hypot(x - s.x, y - s.y) / s.r;
        if (d < 1.4) {
          const a = Math.max(0, Math.min(1, 1.4 - d));
          rgb = rgb.map((v, j) => v * (1 - a) + s.c[j] * a);
        }
      }
      if (box && x >= 600 && x < 660 && y >= 120 && y < 150) rgb = [255, 255, 255];
      px[i] = rgb[0];
      px[i + 1] = rgb[1];
      px[i + 2] = rgb[2];
    }
  }
  let img = sharp(px, { raw: { width: W, height: H, channels: 3 } });
  if (width !== W) img = img.resize(width);
  return (format === 'png' ? img.png() : img.jpeg({ quality })).toBuffer();
}

export async function startChronoKey({ username = 'ck-user', password = 'ck-pass' } = {}) {
  const a1 = await picture(1);
  const images = {
    '/images/a1.jpg': a1,
    '/images/a1-again.jpg': Buffer.from(a1),
    '/images/a1-third.jpg': Buffer.from(a1),
    '/images/a2.jpg': await picture(2),
    '/images/b1.jpg': await picture(3),
    '/images/no_image.png': await picture(9, { format: 'png' }),
  };
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
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return res.end(JSON.stringify({ draw: ['1'], recordsTotal: GRID.length, recordsFiltered: GRID.length, data: GRID }));
      }
      if (url.pathname === '/User/ClientListDatatable' && req.method === 'POST') {
        const f = new URLSearchParams(body);
        if (f.get('roleType') !== 'Client') return res.end('{"data":[]}');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return res.end(JSON.stringify({ draw: 1, recordsTotal: CLIENTS.length, recordsFiltered: CLIENTS.length, data: CLIENTS }));
      }
      if (url.pathname === '/Stock/ExpenseList') return res.end(expenseList());
      const ex = url.pathname.match(/^\/Stock\/AddEditExpense\/(\d+)$/);
      if (ex && req.method === 'GET') return res.end(expensePage(Number(ex[1])));
      if (url.pathname === '/Stock/ToBeShippedList') {
        return res.end(`<table><thead><tr><th>Image</th><th>STOCK NUMBER</th><th>Tracking Status</th></tr></thead><tbody>${LISTS.incoming
          .map((s) => `<tr><td></td><td>${s}</td><td>In transit</td></tr>`)
          .join('')}</tbody></table>`);
      }
      // The Inventory tab's feed: the client asks for it with a lower-case path, as Chrono Key's page does.
      if (url.pathname.toLowerCase() === '/stock/filterinstock') return res.end(inventoryFeed());
      if (url.pathname === '/Stock/InstockPage') {
        if (LISTS.declared === 'none') return res.end('<html><ul id="listBody"></ul><script>/* redesigned */</script></html>');
        const n = LISTS.declared ?? LISTS.inventory.length;
        return res.end(`<html><ul id="listBody"></ul><script>if (itemCount < '${n}') {} if ($('#listBody li').length >= '${n}') {}</script></html>`);
      }
      if (url.pathname === '/Stock/ReturnedConsignments') return res.end(returnedPage());
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
  // v1: Chrono Key's a2, saved again (other bytes, same picture). v3: a1 with
  // a white box over it — the vault's kind of client copy, a picture of its own.
  const pics = {
    '/photos/v1.jpg': await picture(2, { quality: 70 }),
    '/photos/v2.jpg': await picture(4),
    '/photos/v3.jpg': await picture(1, { box: true }),
  };
  let base = '';
  const state = () => ({
    dubaiStock: [
      { id: 'v-1668', stockNumber: '1668', status: 'current', brand: 'Rolex', watchModel: 'Lady-Datejust', dial: 'Pink diamonds',
        caseDiameter: '31mm', b2bFinal: { usd: 13500 }, b2cFinal: { usd: 0, aed: 52000 }, b2chronoFinal: { usd: 14900 },
        photos: [`${base}/photos/v1.jpg`, `${base}/photos/v3.jpg`] },
      { id: 'v-1800', stockNumber: '1800', status: 'current', brand: 'Audemars Piguet', watchModel: 'Royal Oak',
        watchReference: '15510ST', watchSerial: 'AP1800', b2bPrice: 41000, b2bCurrency: 'USD', b2cPrice: 1, b2cCurrency: 'ask first',
        photos: [`${base}/photos/v2.jpg`, 'data:image/png;base64,AAAA'] },
    ],
    londonStock: [],
    hkStock: [],
    soldStocks: [
      { id: 'v-1700-old', stockNumber: '1700', brand: 'Patek Philippe', b2bUsd: 1, caseDiameter: '41mm', bezel: 'Smooth' },
      // A sale only the vault records: Chrono Key never listed 1801.
      { id: 'v-1801', stockNumber: '1801', brand: 'Rolex', watchModel: 'Explorer', soldPrice: 9000, soldCurrency: 'USD' },
    ],
    incomings: [{ id: 'v-1900', stockNumber: '1900', status: 'cancelled', brand: 'Rolex', watchModel: 'GMT' }],
  });
  const dropped = new Set();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) {
      if (req.headers['x-worker-token'] !== token) {
        res.statusCode = 401;
        return res.end('{"error":"Unauthorized"}');
      }
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/api/state') {
        // A record the test has taken out of the vault is not in its lists.
        const s = state();
        for (const k of Object.keys(s)) if (Array.isArray(s[k])) s[k] = s[k].filter((w) => !dropped.has(w.id));
        return res.end(JSON.stringify({ data: s }));
      }
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
  return { url: `${base}/api/state`, dropped, close: () => server.close() };
}
