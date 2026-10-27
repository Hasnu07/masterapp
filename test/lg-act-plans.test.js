import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import pg from 'pg';

/*
 * The logistics app's workflows of the Hand Carry Plans, Movement and
 * Dubai-side pages (driver deliveries, pickup codes, addresses, gold souk),
 * done in masterapp as actions (src/logistics/actions/plans.js, dubai.js):
 * each run through the API as an editor against a fixture — what it writes
 * (every record and field as the app's own function writes them, the locks
 * on the app's copies, the events, the activity line), what it refuses, and
 * a viewer refused. The AI actions run against a stand-in answer. Against a
 * real Postgres (TEST_DATABASE_URL), EMPTIED first; no worker — the app's
 * records are inserted as the sync would leave them (source_id set).
 */

const DB = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5433/masterapp_test';
let rates, base, m, db, dataDir, server, api;

before(async () => {
  rates = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        data: {
          rates: {
            USD: '1',
            EUR: '0.9',
            GBP: '0.8',
            AED: '3.6725',
            HKD: '7.8',
          },
        },
      })
    );
  });
  await new Promise((r) => rates.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${rates.address().port}`;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-lg-act-plans-'));
  Object.assign(process.env, {
    DATABASE_URL: DB,
    DATA_DIR: dataDir,
    VAULT_URL: `${base}/api/state`,
    VAULT_TOKEN: 'vault-key',
    CHRONOKEY_USERNAME: '',
    CHRONOKEY_PASSWORD: '',
    ADMIN_EMAIL: 'boss@example.com',
    ADMIN_PASSWORD: 'admin-password-1',
    SYNC: 'off',
    RATES_LIVE_URL: `${base}/rates/live`,
    RATES_DAILY_URL: `${base}/rates/live`,
    // A key, so the AI actions are not refused before they reach the stand-in answer.
    ANTHROPIC_API_KEY: 'test-key-never-used',
  });
  const reset = new pg.Client({ connectionString: DB });
  await reset.connect();
  await reset.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await reset.end();
  m = {
    db: await import('../src/db/index.js'),
    plans: await import('../src/logistics/actions/plans.js'),
    dubai: await import('../src/logistics/actions/dubai.js'),
    auth: await import('../src/auth/index.js'),
  };
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await m.auth.ensureFirstAdmin(() => {});
  await m.auth.createUser({
    email: 'viewer@example.com',
    name: 'Viewer',
    role: 'viewer',
    password: 'viewer-password-1',
  });
  db = m.db.query;
  server = (await import('../src/web/server.js')).createServer().listen(0);
  api = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  rates.close();
  await m.db.pool.end();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/* The app's records as the sync leaves them: origin 'logistics', the app's id as source_id. */
const add = async (kind, data, stock, sourceId) =>
  (await db("INSERT INTO logistics_items(kind, source_id, data, stock_nos, origin) VALUES ($1, $2, $3, $4, 'logistics') RETURNING id", [kind, sourceId, { id: sourceId, ...data }, stock])).rows[0].id;
const item = async (id) => (await db('SELECT * FROM logistics_items WHERE id = $1', [id])).rows[0];
const activity = async () => (await db("SELECT data->>'text' AS t FROM logistics_items WHERE kind = 'activity' AND deleted_at IS NULL ORDER BY id")).rows.map((r) => r.t);
const events = async (id) => (await db('SELECT action, changes, source FROM logistics_events WHERE item_id = $1 ORDER BY id', [id])).rows;
const ofKind = async (kind) => (await db('SELECT * FROM logistics_items WHERE kind = $1 AND deleted_at IS NULL ORDER BY id', [kind])).rows;

function client() {
  let cookie = '';
  const call = async (method, url, body) => {
    const headers = { 'X-Requested-With': 'masterapp' };
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(api + url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
  return {
    call,
    login: (email, password) => call('POST', '/api/login', { email, password }),
    cookie: () => cookie,
  };
}
let editor, viewer;
const act = async (key, id, input = {}, q = '') => editor.call('POST', `/api/logistics${id ? `/items/${id}` : ''}/act/${key}${q}`, input);
const form = async (key, id, q = '') => editor.call('GET', `/api/logistics${id ? `/items/${id}` : ''}/act/${key}${q}`);
const ok = (r) => assert.equal(r.status, 200, JSON.stringify(r.body));

const ids = {};

test('the fixture: our watches and clients; the app’s rows a plan and a trip draw on', async () => {
  const ourClient = async (fore, sur) => (await db('INSERT INTO clients(forename, surname, origin) VALUES ($1, $2, $3) RETURNING id', [fore, sur, 'manual'])).rows[0].id;
  ids.seller = await ourClient('Khawar', 'Saeed');
  ids.buyer = await ourClient('Parsa', 'Nouri');
  const watch = async (no, status, more = {}) =>
    (
      await db("INSERT INTO watches(stock_no, brand, model, origin, status, purchased_from_client_id, sold_to_client_id) VALUES ($1, 'Rolex', 'Daytona', 'manual', $2, $3, $4) RETURNING id", [
        no,
        status,
        more.from || null,
        more.to || null,
      ])
    ).rows[0].id;
  ids.w4101 = await watch('4101', 'in_stock', { from: ids.seller });
  ids.w4105 = await watch('4105', 'in_stock');
  ids.w4107 = await watch('4107', 'sold', { to: ids.buyer });

  ids.ready = await add(
    'readyForDelivery',
    {
      stockNumber: '4107',
      brand: 'Rolex',
      watchModel: 'Daytona',
      soldToBuyer: 'Parsa Nouri',
      soldFromLocation: 'Dubai',
      status: 'pending_ship',
      soldDate: '2026-10-20',
    },
    ['4107'],
    'R-4107'
  );
  await add(
    'readyForDelivery',
    {
      stockNumber: '4199',
      brand: 'Omega',
      soldToBuyer: 'Gone',
      status: 'shipped',
    },
    ['4199'],
    'R-4199'
  );
  ids.inc = await add(
    'incomings',
    {
      stockNumber: '4105',
      brand: 'Patek Philippe',
      reference: '5711',
      supplier: 'Diego Gimenez',
      location: 'Milan',
      status: 'pending',
    },
    ['4105'],
    'I-4105'
  );
  ids.lon = await add(
    'londonStock',
    {
      stockNumber: '4101',
      brand: 'Rolex',
      watchModel: 'Daytona',
      watchReference: '126500LN',
      status: 'current',
      from: 'Khawar',
    },
    ['4101'],
    'L-4101'
  );
  ids.dub = await add('dubaiStock', { stockNumber: '4150', brand: 'Tudor', status: 'current' }, ['4150'], 'D-4150');
  await add('dubaiStock', { stockNumber: '4151', brand: 'Tudor', status: 'moved' }, ['4151'], 'D-4151');
  ids.hk = await add(
    'hkSituation',
    {
      stockNumber: '4160',
      brand: 'AP',
      description: 'Royal Oak',
      section: 'in_hand',
    },
    ['4160'],
    'H-4160'
  );
  ids.mover = await add('thirdPartyMovers', { name: 'Ferrari', country: 'Italy' }, [], 'M-1');
  await add(
    'shipments',
    {
      stockNumber: '4101',
      fromText: 'Dubai office',
      toText: 'Madrid, Spain',
      cost: 120,
      costCurrency: 'USD',
      status: 'delivered',
    },
    ['4101'],
    'SH-1'
  );
  // The app's own plan (its copy): one stop with nothing on it.
  ids.plan = await add(
    'kashanPlans',
    {
      name: 'Kashan',
      currentCity: 'Dubai',
      notes: '',
      legs: [
        {
          id: 'leg1',
          fromCity: 'Dubai',
          toCity: 'Madrid',
          date: '2026-11-02',
          time: '',
          flightInfo: '',
          flightCost: null,
          flightCostCurrency: 'GBP',
          notes: '',
          deliveries: [],
          collections: [],
        },
      ],
    },
    [],
    'kashan-main'
  );
  ids.addr = await add(
    'logisticsAddresses',
    {
      name: 'Dubai Home',
      address: 'Tower 1, Creek Harbour\nDubai, UAE',
      notes: 'buzz 42',
      createdAt: '2026-06-22T22:14:47.173Z',
    },
    [],
    'la1'
  );

  editor = client();
  ok(await editor.login('boss@example.com', 'admin-password-1'));
  viewer = client();
  ok(await viewer.login('viewer@example.com', 'viewer-password-1'));
  assert.equal((await viewer.call('GET', '/api/logistics/act/plan-new')).status, 403, 'a viewer is refused');
  assert.equal((await viewer.call('POST', '/api/logistics/act/plan-new', { name: 'X' })).status, 403);
});

test('hand carry: a new plan, a stop added as saveKashanLeg writes it, the start city kept; a watch assigned as kashanDoAssign does, never twice', async () => {
  const f = await form('plan-new');
  ok(f);
  assert.deepEqual(
    f.body.form.map((x) => x.key),
    ['name', 'currentCity', 'notes']
  );
  assert.equal(f.body.form[1].type, 'choice');
  assert.equal((await act('plan-new', null, { name: '' })).status, 400);
  const made = await act('plan-new', null, {
    name: 'Ben',
    currentCity: 'London',
    notes: 'Europe run',
  });
  ok(made);
  ids.plan2 = made.body.created[0];
  const p = await item(ids.plan2);
  assert.equal(p.origin, 'manual');
  assert.deepEqual([p.data.name, p.data.currentCity, p.data.notes, p.data.legs], ['Ben', 'London', 'Europe run', []]);
  assert.match(p.data.id, /^[a-z0-9]{8,}$/, 'the app’s uid shape');
  assert.equal((await activity()).at(-1), '✈️ New plan created: Ben');

  // A stop: fromCity prefilled from the start city.
  const sf = await form('plan-stop-add', ids.plan2);
  ok(sf);
  assert.deepEqual([sf.body.values.currentCity, sf.body.values.fromCity, sf.body.values.flightCostCurrency], ['London', 'London', 'GBP']);
  assert.equal((await act('plan-stop-add', ids.plan2, { toCity: '' })).status, 400, 'a destination is needed');
  assert.equal((await act('plan-stop-add', ids.plan2, { toCity: 'Madrid', time: '25h' })).status, 400);
  ok(
    await act('plan-stop-add', ids.plan2, {
      currentCity: 'Dubai',
      fromCity: 'Dubai',
      toCity: 'Madrid',
      date: '2026-11-02',
      time: '09:30',
      flightInfo: 'EK141',
      flightCostCurrency: 'EUR',
      flightCost: '450',
      notes: 'Salva first',
    })
  );
  let d = (await item(ids.plan2)).data;
  assert.equal(d.currentCity, 'Dubai', 'the start city is persisted with the stop, as the app does');
  assert.equal(d.legs.length, 1);
  const leg = d.legs[0];
  assert.match(leg.id, /^[a-z0-9]{8,}$/);
  assert.deepEqual(
    [leg.fromCity, leg.toCity, leg.date, leg.time, leg.flightInfo, leg.flightCostCurrency, leg.flightCost, leg.notes, leg.deliveries, leg.collections],
    ['Dubai', 'Madrid', '2026-11-02', '09:30', 'EK141', 'EUR', 450, 'Salva first', [], []]
  );
  ids.leg = leg.id;

  // Assign: the choices are the app's left panel — ready not shipped, incomings pending / in transit, stock in hand; our watch named.
  const af = await form('plan-assign', ids.plan2, `?leg=${ids.leg}&item=readyForDelivery:${ids.ready}`);
  ok(af);
  const opts = af.body.form[1].options.map((o) => o.value);
  assert.deepEqual(
    opts,
    [`readyForDelivery:${ids.ready}`, `incomings:${ids.inc}`, `londonStock:${ids.lon}`, `dubaiStock:${ids.dub}`, `hkSituation:${ids.hk}`],
    'the shipped sale and the moved Dubai row are not offered'
  );
  assert.deepEqual(af.body.values, {
    legId: ids.leg,
    item: `readyForDelivery:${ids.ready}`,
  });
  assert.match(af.body.form[1].options.find((o) => o.value === `dubaiStock:${ids.dub}`).label, /not one of our watches/);
  ok(
    await act('plan-assign', ids.plan2, {
      legId: ids.leg,
      item: `readyForDelivery:${ids.ready}`,
    })
  );
  assert.equal(
    (
      await act('plan-assign', ids.plan2, {
        legId: ids.leg,
        item: `readyForDelivery:${ids.ready}`,
      })
    ).body.error,
    'Already in this stop'
  );
  ok(
    await act('plan-assign', ids.plan2, {
      legId: ids.leg,
      item: `incomings:${ids.inc}`,
    })
  );
  const mv = await act('plan-assign', ids.plan2, {
    legId: ids.leg,
    item: `dubaiStock:${ids.dub}`,
  });
  ok(mv);
  assert.match(mv.body.message, /not one of our watches/);
  d = (await item(ids.plan2)).data;
  const l = d.legs[0];
  assert.equal(l.deliveries.length, 1);
  assert.deepEqual(
    [l.deliveries[0].readyId, l.deliveries[0].stockNumber, l.deliveries[0].brand, l.deliveries[0].model, l.deliveries[0].clientName, l.deliveries[0].clientCountry],
    ['R-4107', '4107', 'Rolex', 'Daytona', 'Parsa Nouri', 'Dubai']
  );
  assert.deepEqual(
    [l.collections[0].incId, l.collections[0].stockNumber, l.collections[0].model, l.collections[0].supplier, l.collections[0].country],
    ['I-4105', '4105', '5711', 'Diego Gimenez', 'Milan']
  );
  assert.deepEqual([l.stockMoves[0].stockId, l.stockMoves[0].stockNumber, l.stockMoves[0].fromLocation], ['D-4150', '4150', 'Dubai']);
  assert.deepEqual((await item(ids.plan2)).stock_nos.sort(), ['4105', '4107', '4150'], 'the plan names its watches');

  // The Hand carry tab shows the sale on the plan now, by the row's own id.
  const hc = await editor.call('GET', '/api/logistics/hand-carry');
  ok(hc);
  assert.equal(hc.body.waiting.deliver.find((x) => x.id === ids.ready).on_plan.id, ids.plan2);
  assert.equal(hc.body.waiting.deliver.find((x) => x.id === ids.ready).watch.id, ids.w4107, 'our watch');
});

test('hand carry: unassign (the waiting row names itself), edit and remove a stop, rename; the app’s copy locks what it changes', async () => {
  const uf = await form('plan-unassign', ids.plan2, `?item=readyForDelivery:${ids.ready}`);
  ok(uf);
  assert.equal(uf.body.form[0].options.length, 3);
  assert.equal(uf.body.values.item, `${ids.leg}|delivery|${(await item(ids.plan2)).data.legs[0].deliveries[0].id}`);
  ok(await act('plan-unassign', ids.plan2, { item: uf.body.values.item }));
  assert.deepEqual((await item(ids.plan2)).data.legs[0].deliveries, []);
  assert.equal((await act('plan-unassign', ids.plan2, { item: uf.body.values.item })).status, 400, 'gone already');

  const ef = await form('plan-stop-edit', ids.plan2, `?leg=${ids.leg}`);
  ok(ef);
  assert.equal(ef.body.values.toCity, 'Madrid');
  ok(
    await act('plan-stop-edit', ids.plan2, {
      legId: ids.leg,
      fromCity: 'Dubai',
      toCity: 'Barcelona',
      date: '2026-11-03',
      flightCostCurrency: 'GBP',
    })
  );
  const l = (await item(ids.plan2)).data.legs[0];
  assert.deepEqual([l.toCity, l.date, l.flightCost, l.collections.length], ['Barcelona', '2026-11-03', null, 1], 'the stop’s own fields replaced, its assignments kept');

  // The app's copy: a change locks the field against the sync.
  ok(
    await act('plan-rename', ids.plan, {
      name: 'Kashan Nov',
      currentCity: 'Dubai',
      notes: '',
    })
  );
  const own = await item(ids.plan);
  assert.equal(own.data.name, 'Kashan Nov');
  assert.deepEqual(own.locked_fields, ['name']);
  assert.deepEqual((await events(ids.plan)).at(-1).changes, {
    name: ['Kashan', 'Kashan Nov'],
  });
  ok(await act('plan-stop-add', ids.plan, { toCity: 'Rome' }));
  assert.deepEqual((await item(ids.plan)).locked_fields.sort(), ['legs', 'name']);
  ok(
    await act('plan-stop-remove', ids.plan, {
      legId: (await item(ids.plan)).data.legs[1].id,
    })
  );
  assert.equal((await item(ids.plan)).data.legs.length, 1);
});

test('hand carry: parse & add on a stand-in answer, the prompt verbatim; AI flights and optimise answer in words; a flight question goes to AI Flights', async () => {
  const asked = [];
  m.plans._setAsker(async (q) => {
    asked.push(q);
    if (q.json)
      return {
        legs: [
          {
            toCity: 'Milan',
            fromCity: 'Barcelona',
            date: '2026-11-05',
            deliveries: [{ stockNumber: '4107', clientName: 'Parsa' }],
            collections: [{ stockNumber: '', supplier: 'diego' }],
          },
          { toCity: '' },
        ],
      };
    return 'Fly EK on a Tuesday.';
  });
  try {
    assert.equal((await act('plan-parse', ids.plan2, { instructions: '' })).status, 400);
    const r = await act('plan-parse', ids.plan2, {
      instructions: 'Go to Milan, deliver 4107 to Parsa and collect from Diego',
    });
    ok(r);
    assert.equal(r.body.message, '✅ Added 1 stop to the plan');
    assert.equal(asked[0].json, true);
    assert.equal(asked[0].prompt, 'Go to Milan, deliver 4107 to Parsa and collect from Diego');
    assert.equal(
      asked[0].system,
      m.plans.parseSystemPrompt(
        [
          {
            stockNumber: '4107',
            brand: 'Rolex',
            watchModel: 'Daytona',
            soldToBuyer: 'Parsa Nouri',
            soldFromLocation: 'Dubai',
          },
        ],
        [
          {
            stockNumber: '4105',
            brand: 'Patek Philippe',
            reference: '5711',
            supplier: 'Diego Gimenez',
            location: 'Milan',
          },
        ]
      )
    );
    assert.match(asked[0].system, /^You are a logistics planner for a luxury watch business\. Parse the user's instruction into a structured trip plan for Kashan/);
    assert.match(asked[0].system, /DELIVER: stock 4107 Rolex Daytona → Parsa Nouri \(Dubai\)\nCOLLECT: stock 4105 Patek Philippe 5711 ← Diego Gimenez \(Milan\)/);
    const d = (await item(ids.plan2)).data;
    assert.equal(d.legs.length, 2, 'the stop with no city is skipped');
    const leg = d.legs[1];
    assert.deepEqual([leg.toCity, leg.fromCity, leg.date, leg.time, leg.flightCost, leg.flightCostCurrency], ['Milan', 'Barcelona', '2026-11-05', '', null, 'GBP']);
    assert.deepEqual([leg.deliveries[0].readyId, leg.deliveries[0].clientName], ['R-4107', 'Parsa Nouri'], 'matched by stock number');
    assert.deepEqual([leg.collections[0].incId, leg.collections[0].supplier], ['I-4105', 'Diego Gimenez'], 'matched by the supplier’s name');

    const fl = await act('plan-parse', ids.plan2, {
      instructions: 'cheapest flight for this',
    });
    ok(fl);
    assert.match(fl.body.message, /^✈️ Flight request detected — AI Flights:\nFly EK/);
    assert.equal(asked[1].system, m.plans.FLIGHTS_SYSTEM);
    assert.match(
      asked[1].prompt,
      /^I need to plan a business trip for a luxury watch delivery courier\. Itinerary:\n\nStart: Dubai\nStop 1: Dubai → Barcelona on 2026-11-03\nStop 2: Barcelona → Milan on 2026-11-05\n/
    );
    ok(await act('plan-flights', ids.plan2));
    const op = await act('plan-optimise', ids.plan2);
    ok(op);
    assert.match(op.body.message, /^📊 Route analysis\nFly EK/);
    const prompt = asked.at(-1).prompt;
    assert.match(prompt, /^You are a luxury watch logistics expert advising Purosangue Watches/);
    assert.match(prompt, /Our 3rd-party movers: Ferrari \(Italy\)\n/);
    assert.match(
      prompt,
      /Stop 1: Dubai → Barcelona \(3 Nov\)\n  📥 COLLECT: Stock #4105 Patek Philippe 5711 ← from Diego Gimenez\n  📍 MOVING: Stock #4150 Tudor  \(from Dubai\)\n\nStop 2: Barcelona → Milan \(5 Nov\)/
    );
    assert.match(prompt, /TOTAL WATCHES IN THIS TRIP: 3 watches/);
    assert.match(prompt, /OUR HISTORICAL SHIPPING COSTS ON RELEVANT ROUTES:\n  No historical data for these specific routes/);
    assert.match(prompt, /For each leg \(Dubai→Barcelona, Barcelona→Milan, Milan→Dubai\), provide:/);
  } finally {
    m.plans._setAsker(null);
  }
});

test('hand carry: send to movements builds the trip as kashanSendToMovement does; complete, restore, clear, delete — the only plan never deleted', async () => {
  const sent = await act('plan-send', ids.plan2);
  ok(sent);
  ids.tripFromPlan = sent.body.created[0];
  assert.equal(sent.body.open, `#/lg/${ids.tripFromPlan}`);
  const t = await item(ids.tripFromPlan);
  assert.equal(t.kind, 'personTrips');
  const d = t.data;
  assert.deepEqual(
    [d.personName, d.fromLocation, d.toLocation, d.startDate, d.endDate, d.purpose, d.status, d.costs, d.photos, d.notes],
    ['Ben', 'Dubai', 'Milan', '2026-11-03', '2026-11-05', 'From Kashan Plan: Ben', 'planned', [], [], 'Europe run']
  );
  assert.deepEqual(
    d.legs.map((l) => [l.from, l.to, l.date]),
    [
      ['Dubai', 'Barcelona', '2026-11-03'],
      ['Barcelona', 'Milan', '2026-11-05'],
    ]
  );
  assert.deepEqual(d.stockIds, ['D-4150', 'inc-I-4105', 'ready-R-4107'], 'a stock move by its row id, a delivery as ready-, a collection as inc-');
  assert.deepEqual(t.stock_nos.sort(), ['4105', '4107', '4150'], 'the trip’s watches, through the rows');
  assert.equal((await activity()).at(-1), '🧳 Movement created from Kashan Plan "Ben"');

  ok(await act('plan-complete', ids.plan2));
  let p = await item(ids.plan2);
  assert.equal(p.data.status, 'completed');
  assert.equal(typeof p.data.completedAt, 'number');
  assert.equal((await activity()).at(-1), '✅ Kashan Plan "Ben" marked complete');
  assert.equal((await act('plan-complete', ids.plan2)).status, 400);
  const hc = await editor.call('GET', '/api/logistics/hand-carry');
  assert.deepEqual(
    hc.body.history.map((x) => x.id),
    [ids.plan2]
  );
  ok(await act('plan-restore', ids.plan2));
  p = await item(ids.plan2);
  assert.deepEqual([p.data.status, 'completedAt' in p.data], ['active', false], 'completedAt deleted, as the app does');
  assert.equal((await activity()).at(-1), '↺ Kashan Plan "Ben" restored to active');

  ok(await act('plan-clear', ids.plan2));
  assert.deepEqual((await item(ids.plan2)).data.legs, []);
  assert.equal((await act('plan-send', ids.plan2)).body.error, 'No stops in this plan yet.');
  ok(await act('plan-delete', ids.plan2));
  assert.ok((await item(ids.plan2)).deleted_at);
  assert.equal((await act('plan-delete', ids.plan)).body.error, 'Cannot delete the only plan');
  assert.equal((await viewer.call('POST', `/api/logistics/items/${ids.plan}/act/plan-delete`, {})).status, 403);
});

test('movement: a trip added as saveTrip writes it, its watches by row id with the list prefix; legs, watches, expenses added, changed, removed', async () => {
  assert.equal((await act('trip-add', null, { personName: '' })).status, 400);
  assert.equal(
    (
      await act('trip-add', null, {
        personName: 'Ben',
        stockNumbers: '4101, 9999',
      })
    ).status,
    400,
    'a number on none of the lists'
  );
  const r = await act('trip-add', null, {
    personName: 'Ben',
    status: 'in_progress',
    startDate: '2026-11-01',
    endDate: '2026-11-04',
    endTime: '18:00',
    purpose: 'Deliveries',
    from: 'Dubai',
    to: 'London',
    date: '2026-11-01',
    stockNumbers: '4101, 4160, 4107',
  });
  ok(r);
  assert.match(r.body.message, /our watches #4101, #4107/);
  assert.match(r.body.message, /#4160 not one of our watches/);
  ids.trip = r.body.created[0];
  let t = await item(ids.trip);
  const d = t.data;
  assert.deepEqual(
    [d.personName, d.status, d.fromLocation, d.toLocation, d.startDate, d.endDate, d.endTime, d.purpose, d.costs, d.photos],
    ['Ben', 'in_progress', 'Dubai', 'London', '2026-11-01', '2026-11-04', '18:00', 'Deliveries', [], []]
  );
  assert.deepEqual(
    d.legs.map((l) => [l.from, l.to, l.date, l.time, l.arrDate, l.arrTime]),
    [['Dubai', 'London', '2026-11-01', '', '', '']]
  );
  assert.deepEqual(d.stockIds, ['lon-L-4101', 'hk-H-4160', 'ready-R-4107']);
  assert.deepEqual(t.stock_nos.sort(), ['4101', '4107', '4160']);
  assert.equal((await activity()).at(-1), '🚗 Trip added: Ben · Dubai → London');

  ok(
    await act('trip-leg-add', ids.trip, {
      from: 'London',
      to: 'Geneva',
      date: '2026-11-03',
      time: '07:15',
    })
  );
  t = await item(ids.trip);
  assert.deepEqual([t.data.legs.length, t.data.toLocation], [2, 'Geneva']);
  assert.equal((await activity()).at(-1), '🚗 Trip updated: Ben · Dubai → London → Geneva');
  const legId = t.data.legs[1].id;

  const sf = await form('trip-stock-add', ids.trip);
  ok(sf);
  const opts = sf.body.form[0].options;
  assert.ok(opts.some((o) => o.value === 'dubai-D-4150' && /🇦🇪 Dubai #4150 Tudor \(not one of our watches\)/.test(o.label)));
  assert.ok(!opts.some((o) => o.value === 'lon-L-4101'), 'a watch on the trip is not offered again');
  assert.ok(opts.some((o) => o.value === 'inc-I-4105' && /📥 Incoming #4105 Patek Philippe 5711 · Milan/.test(o.label)));
  ok(await act('trip-stock-add', ids.trip, { stockId: 'inc-I-4105' }));
  assert.equal((await act('trip-stock-add', ids.trip, { stockId: 'lon-nope' })).status, 400);
  ok(await act('trip-stock-remove', ids.trip, { stockId: 'hk-H-4160' }));
  t = await item(ids.trip);
  assert.deepEqual(t.data.stockIds, ['lon-L-4101', 'ready-R-4107', 'inc-I-4105']);

  const cf = await form('trip-cost-add', ids.trip, `?leg=${legId}`);
  ok(cf);
  assert.deepEqual(cf.body.form.find((f) => f.key === 'category').options, m.plans.TRIP_COST_CATEGORIES);
  assert.deepEqual(
    cf.body.form.find((f) => f.key === 'legId').options.map((o) => o.label),
    ['— whole trip —', 'Dubai → London · 2026-11-01', 'London → Geneva · 2026-11-03']
  );
  assert.equal(cf.body.values.legId, legId);
  assert.equal(
    (
      await act('trip-cost-add', ids.trip, {
        category: 'Hotel',
        amount: '',
        label: '',
      })
    ).status,
    400,
    'a blank line is skipped by the app: refused here'
  );
  assert.equal((await act('trip-cost-add', ids.trip, { category: 'Bribes', amount: '10' })).status, 400);
  ok(
    await act('trip-cost-add', ids.trip, {
      category: 'Flight / Ticket',
      label: 'EK 001',
      amount: '1,200.50',
      currency: 'AED',
      date: '2026-11-01',
      legId: '',
      paidBy: 'company',
    })
  );
  ok(
    await act('trip-cost-add', ids.trip, {
      category: 'Hotel',
      label: 'Geneva 2 nights',
      amount: '600',
      currency: 'CHF',
      date: '2026-11-03',
      legId,
      paidBy: 'traveller',
    })
  );
  t = await item(ids.trip);
  const [c1, c2] = t.data.costs;
  assert.deepEqual(
    [c1.category, c1.label, c1.amount, c1.currency, c1.date, c1.legId, c1.paidBy, c1.settled, c1.notes],
    ['Flight / Ticket', 'EK 001', 1200.5, 'AED', '2026-11-01', '', 'company', true, '']
  );
  assert.deepEqual([c2.legId, c2.paidBy, c2.settled], [legId, 'traveller', false], 'his own card: not settled until it is');
  ok(
    await act('trip-cost-edit', ids.trip, {
      costId: c2.id,
      category: 'Hotel',
      label: 'Geneva 3 nights',
      amount: '900',
      currency: 'CHF',
      date: '2026-11-03',
      legId,
      paidBy: 'company',
    })
  );
  t = await item(ids.trip);
  assert.deepEqual([t.data.costs[1].id, t.data.costs[1].label, t.data.costs[1].amount, t.data.costs[1].settled], [c2.id, 'Geneva 3 nights', 900, true]);
  ok(
    await act('trip-cost-add', ids.trip, {
      category: 'Food',
      amount: '40',
      currency: 'EUR',
    })
  );
  ok(
    await act('trip-cost-remove', ids.trip, {
      costId: (await item(ids.trip)).data.costs[2].id,
    })
  );
  assert.equal((await item(ids.trip)).data.costs.length, 2);

  ok(
    await act('trip-edit', ids.trip, {
      personName: 'Ben',
      status: 'in_progress',
      startDate: '2026-11-01',
      endDate: '2026-11-05',
      purpose: 'Deliveries and a collection',
      notes: 'rail pass',
    })
  );
  t = await item(ids.trip);
  assert.deepEqual(
    [t.data.endDate, t.data.purpose, t.data.notes, t.data.costs.length, t.data.legs.length],
    ['2026-11-05', 'Deliveries and a collection', 'rail pass', 2, 2],
    'the typed fields only — legs, costs, watches kept'
  );
  ok(await act('trip-leg-remove', ids.trip, { legId }));
  assert.deepEqual([(await item(ids.trip)).data.legs.length, (await item(ids.trip)).data.toLocation], [1, 'London']);
});

test('movement: the allowance lines the Movement tab sends become Per Diem expenses as addAllowanceToTripCosts writes them; paid / not paid; removed', async () => {
  const lines = {
    currency: 'EUR',
    start: '2026-11-01',
    byPlace: [
      { place: 'London', days: 2, rate: 100, amount: 200, first: '2026-11-01' },
      { place: 'Geneva', days: 1, rate: 0, amount: 0, first: '2026-11-03' },
    ],
    extra: [{ label: 'Taxi to the airport', amount: 35 }],
    total: 235,
  };
  assert.equal((await act('trip-allowance-add', ids.trip)).status, 400, 'from the record page, without the lines');
  assert.equal((await act('trip-allowance-add', ids.trip, {}, '?lines=not-json')).status, 400);
  assert.equal(
    (await act('trip-allowance-add', ids.trip, {}, `?lines=${encodeURIComponent(JSON.stringify({ currency: 'EUR', byPlace: [{ place: 'X', days: 1, amount: 0 }] }))}`)).status,
    400,
    'nothing payable'
  );
  const r = await act('trip-allowance-add', ids.trip, {}, `?lines=${encodeURIComponent(JSON.stringify(lines))}`);
  ok(r);
  assert.equal(r.body.message, 'Allowance added · EUR 235');
  let costs = (await item(ids.trip)).data.costs;
  assert.equal(costs.length, 4);
  const pd = costs.filter((c) => c.perDiem);
  assert.deepEqual(
    pd.map((c) => [c.category, c.label, c.amount, c.currency, c.date, c.legId, c.notes]),
    [
      ['Per Diem', 'Taxi to the airport', 35, 'EUR', '2026-11-01', '', 'Travel allowance — manual line'],
      ['Per Diem', 'London · 2 days × EUR 100', 200, 'EUR', '2026-11-01', '', 'Travel allowance'],
    ]
  );
  assert.equal((await activity()).at(-1), '👤 Travel allowance added to Ben · Dubai → London · EUR 235');
  // Added again: the old Per Diem lines replaced, never doubled.
  ok(await act('trip-allowance-add', ids.trip, {}, `?lines=${encodeURIComponent(JSON.stringify(lines))}`));
  assert.equal((await item(ids.trip)).data.costs.length, 4);

  ok(await act('trip-allowance-paid', ids.trip, { paid: true }));
  let d = (await item(ids.trip)).data;
  assert.equal(d.allowancePaid, true);
  assert.ok(d.costs.filter((c) => c.perDiem).every((c) => c.paidBy === 'company' && c.settled === true));
  assert.equal((await activity()).at(-1), '💶 Travel allowance for Ben marked paid — it is now part of the trip cost');
  ok(await act('trip-allowance-paid', ids.trip, { paid: false }));
  d = (await item(ids.trip)).data;
  assert.deepEqual([d.allowancePaid, d.costs.length], [false, 2], 'not paid: its lines removed, as setAllowancePaid does');
  assert.equal((await act('trip-allowance-paid', ids.trip, { paid: true })).status, 400, 'nothing to pay');
  ok(await act('trip-allowance-add', ids.trip, {}, `?lines=${encodeURIComponent(JSON.stringify(lines))}`));
  ok(await act('trip-allowance-remove', ids.trip));
  costs = (await item(ids.trip)).data.costs;
  assert.equal(costs.length, 2);
  assert.equal((await activity()).at(-1), '👤 Travel allowance removed from Ben · Dubai → London');
});

test('movement: complete trip writes every cost line into the logistic cost ledger as completeTrip does, re-syncs without doubling; delete', async () => {
  const r = await act('trip-complete', ids.trip);
  ok(r);
  assert.equal(r.body.created.length, 2);
  const t = await item(ids.trip);
  assert.deepEqual([t.data.status, typeof t.data.completedAt, t.data.logisticCostIds.length], ['completed', 'number', 2]);
  const lines = await ofKind('logisticCosts');
  assert.equal(lines.length, 2);
  const [a, b] = lines.map((x) => x.data);
  assert.deepEqual(t.data.logisticCostIds, [a.id, b.id]);
  assert.deepEqual(
    [a.tripId, a.tripCostId, a.legId, a.title, a.shipmentId, a.stockNumber, a.fromName, a.toName, a.date, a.currency, a.amount, a.notes],
    [
      t.data.id,
      t.data.costs[0].id,
      '',
      'Flight / Ticket · EK 001 (Ben trip · Dubai → London)',
      null,
      '4101, 4107, 4105',
      'Dubai',
      'London',
      '2026-11-01',
      'AED',
      1200.5,
      'Trip · Ben · Flight / Ticket · EK 001',
    ]
  );
  assert.equal(typeof a.ts, 'number');
  assert.deepEqual(
    [b.title, b.fromName, b.toName, b.date, b.amount],
    ['Hotel · Geneva 3 nights (Ben trip · Dubai → London)', 'Dubai', 'London', '2026-11-03', 900],
    'its leg is gone: the whole route, the trip’s ends'
  );
  assert.deepEqual(lines[0].stock_nos.sort(), ['4101', '4105', '4107'], 'the ledger lines name our watches');
  assert.equal((await activity()).at(-1), '✅ Trip completed: Ben · Dubai → London · 2 cost lines added to dashboard');
  // Again: the old lines go, two new ones — never four.
  ok(await act('trip-complete', ids.trip));
  const again = await ofKind('logisticCosts');
  assert.equal(again.length, 2);
  assert.ok(!again.some((x) => x.data.id === a.id));
  assert.equal((await db("SELECT count(*)::int AS n FROM logistics_items WHERE kind = 'logisticCosts' AND deleted_at IS NOT NULL")).rows[0].n, 2);

  ok(await act('trip-delete', ids.tripFromPlan));
  assert.ok((await item(ids.tripFromPlan)).deleted_at);
  assert.equal((await activity()).at(-1), 'Deleted trip Ben');
  assert.equal((await viewer.call('POST', `/api/logistics/items/${ids.trip}/act/trip-delete`, {})).status, 403);
});

test('driver deliveries: give to driver as confirmDriver writes it, mark delivered as confirmDriverDeliver, returned, delete; photos through the files route', async () => {
  assert.equal((await act('dd-give', null, { driverName: '', stockNumbers: '4101' })).body.error, 'Driver name is required.');
  assert.equal((await act('dd-give', null, { driverName: 'Fiaz', stockNumbers: '' })).body.error, 'Enter at least one stock #.');
  const r = await act('dd-give', null, {
    driverName: 'Fiaz',
    dateGiven: '2026-10-27',
    stockNumbers: '4101, 4199',
    destination: 'Gold souk',
    notes: 'collect AED 50k',
  });
  ok(r);
  assert.match(r.body.message, /🛵 Recorded — out with driver · #4199 not one of our watches/);
  ids.dd = r.body.created[0];
  let d = (await item(ids.dd)).data;
  assert.deepEqual(
    [d.driverName, d.dateGiven, d.stockNumbers, d.destination, d.notes, d.givenPhotos, d.status, d.deliveryPhotos, typeof d.ts],
    ['Fiaz', '2026-10-27', '4101, 4199', 'Gold souk', 'collect AED 50k', [], 'out', [], 'number']
  );
  assert.deepEqual((await item(ids.dd)).stock_nos, ['4101', '4199']);
  assert.equal((await activity()).at(-1), '🛵 Gave 4101, 4199 to driver Fiaz → Gold souk');

  // A handover photo: appended as lgfile:<id>.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const fd = new FormData();
  fd.append('files', new Blob([png], { type: 'image/png' }), 'hand.png');
  const up = await fetch(`${api}/api/logistics/items/${ids.dd}/files?field=givenPhotos`, {
    method: 'POST',
    headers: { 'X-Requested-With': 'masterapp', Cookie: editor.cookie() },
    body: fd,
  });
  assert.equal(up.status, 200, await up.text());
  d = (await item(ids.dd)).data;
  assert.equal(d.givenPhotos.length, 1);
  assert.match(d.givenPhotos[0], /^lgfile:\d+$/);

  const df = await form('dd-deliver', ids.dd);
  ok(df);
  assert.deepEqual([df.body.values.deliveredTo, df.body.values.deliveryLocation, df.body.values.moneyCurrency], ['Gold souk', 'Gold souk', 'AED']);
  assert.equal((await act('dd-deliver', ids.dd, { moneyCurrency: 'XXX' })).status, 400);
  ok(
    await act('dd-deliver', ids.dd, {
      deliveredTo: 'Asif',
      deliveryLocation: 'Shop 12',
      deliveredDate: '2026-10-28',
      moneyCurrency: 'aed',
      moneyCollected: '50,000',
      deliveryNotes: 'paid cash in full',
    })
  );
  d = (await item(ids.dd)).data;
  assert.deepEqual(
    [d.status, d.deliveredTo, d.deliveryLocation, d.deliveredDate, d.moneyCurrency, d.moneyCollected, d.deliveryNotes, d.deliveryPhotos, d.givenPhotos.length],
    ['delivered', 'Asif', 'Shop 12', '2026-10-28', 'AED', 50000, 'paid cash in full', [], 1]
  );
  assert.equal((await activity()).at(-1), '✅ Driver Fiaz delivered 4101, 4199 · collected AED 50000');
  assert.equal((await act('dd-deliver', ids.dd, {})).status, 400, 'not twice');
  assert.equal((await act('dd-return', ids.dd, {})).status, 400, 'delivered is not returned');
  const page = await editor.call('GET', '/api/logistics/page/driverdeliveries');
  ok(page);
  assert.deepEqual([page.body.delivered[0].money, page.body.delivered[0].stocks[0].watch.id], [{ amount: 50000, currency: 'AED' }, ids.w4101]);

  const r2 = await act('dd-give', null, {
    driverName: 'Imran',
    stockNumbers: '4107',
  });
  ok(r2);
  ok(
    await act('dd-return', r2.body.created[0], {
      returnedDate: '2026-10-29',
      returnNotes: 'shop shut',
    })
  );
  d = (await item(r2.body.created[0])).data;
  assert.deepEqual([d.status, d.returnedDate, d.returnNotes], ['returned', '2026-10-29', 'shop shut']);
  assert.equal((await activity()).at(-1), '↩️ Driver Imran returned 4107');
  ok(await act('dd-delete', r2.body.created[0]));
  assert.ok((await item(r2.body.created[0])).deleted_at);
  assert.equal((await viewer.call('POST', `/api/logistics/items/${ids.dd}/act/dd-delete`, {})).status, 403);
});

test('pickup codes: a new code as savePickupCode writes it — the saved address copied in, the messages as buildPickupMessage; person, sent, done, edit, delete', async () => {
  const f = await form('pc-new');
  ok(f);
  assert.match(f.body.values.code, /^[A-Z0-9]{10}$/, 'generatePickupCode: ten of A–Z 0–9');
  const addr = f.body.form.find((x) => x.key === 'addressId');
  assert.deepEqual(
    addr.options.map((o) => o.value),
    ['', 'la1']
  );
  assert.equal((await act('pc-new', null, { code: '', messageA: 'x' })).body.error, 'Enter a code');
  assert.equal(
    (
      await act('pc-new', null, {
        code: 'ABCDEFGH12',
        messageA: '',
        messageB: '',
      })
    ).body.error,
    'Enter at least one message (for Person A or B)'
  );
  assert.equal(
    (
      await act('pc-new', null, {
        code: 'ABCDEFGH12',
        messageA: 'x',
        addressId: 'nope',
      })
    ).status,
    400
  );
  const r = await act('pc-new', null, {
    type: 'delivery',
    code: 'ABCDEFGH12',
    messageA: 'Please deliver Stock # 4101 to the shop',
    messageB: 'Guy will bring 4101',
    addressId: 'la1',
    date: '2026-11-01',
    timeFrom: '16:30',
    timeTo: '18:30',
    personAName: 'HK Office',
    notes: 'Call first',
  });
  ok(r);
  assert.match(r.body.message, /Code ABCDEFGH12 saved/);
  ids.pc = r.body.created[0];
  let d = (await item(ids.pc)).data;
  assert.deepEqual(
    [d.type, d.code, d.messageA, d.messageB, d.addressId, d.address, d.addressName, d.date, d.timeFrom, d.timeTo, d.personA, d.personB, d.messageSentA, d.messageSentB, d.status, d.notes],
    [
      'delivery',
      'ABCDEFGH12',
      'Please deliver Stock # 4101 to the shop',
      'Guy will bring 4101',
      'la1',
      'Tower 1, Creek Harbour\nDubai, UAE',
      'Dubai Home',
      '2026-11-01',
      '16:30',
      '18:30',
      { id: '', name: 'HK Office' },
      null,
      null,
      null,
      'pending',
      'Call first',
    ]
  );
  assert.match(d.createdAt, /^\d{4}-\d{2}-\d{2}T/, 'an ISO moment, as the app writes it');
  assert.equal((await activity()).at(-1), '🔐 New delivery code: ABCDEFGH12 — Please deliver Stock # 4101 to the shop');
  const page = await editor.call('GET', '/api/logistics/page/pickupcodes');
  ok(page);
  const c = page.body.codes.find((x) => x.id === ids.pc);
  assert.equal(c.text_a, 'Please deliver Stock # 4101 to the shop\nTower 1, Creek Harbour\nDubai, UAE\n\n⏰ Time: 16:30 - 18:30\n📅 Date: 1 November 2026\n\n🔑 Pickup code: ABCDEFGH12');
  assert.equal(c.text_b, 'Guy will bring 4101\n\n⏰ Time: 16:30 - 18:30\n📅 Date: 1 November 2026\n\n🔑 Pickup code: ABCDEFGH12');
  assert.equal(c.stocks[0].watch.id, ids.w4101, 'the number in the message is our watch');

  ok(await act('pc-person', ids.pc, { who: 'B', name: 'RK x Hasan' }));
  ok(await act('pc-sent', ids.pc, { who: 'B' }));
  d = (await item(ids.pc)).data;
  assert.deepEqual(d.personB, { id: '', name: 'RK x Hasan' });
  assert.equal(typeof d.messageSentB, 'number');
  assert.equal(d.messageSentA, null);
  assert.equal((await activity()).at(-1), '📱 Pickup code ABCDEFGH12 message sent to Person B (RK x Hasan)');
  ok(await act('pc-person', ids.pc, { who: 'A', name: '' }));
  assert.equal((await item(ids.pc)).data.personA, null);

  ok(
    await act('pc-edit', ids.pc, {
      type: 'pickup',
      code: 'ABCDEFGH12',
      messageA: 'Please collect',
      messageB: '',
      addressId: '',
      date: '2026-11-02',
      personBName: '',
    })
  );
  d = (await item(ids.pc)).data;
  assert.deepEqual(
    [d.type, d.messageA, d.messageB, d.addressId, d.address, d.addressName, d.date, d.timeFrom, d.personB, d.messageSentB === null],
    ['pickup', 'Please collect', '', '', '', '', '2026-11-02', '', { id: '', name: 'RK x Hasan' }, false],
    'a person left blank is kept, as the app does'
  );
  ok(await act('pc-done', ids.pc));
  d = (await item(ids.pc)).data;
  assert.equal(d.status, 'completed');
  assert.match(d.completedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal((await activity()).at(-1), '✅ Pickup code completed: ABCDEFGH12 — Please collect');
  assert.equal((await act('pc-done', ids.pc)).status, 400);
  ok(await act('pc-delete', ids.pc));
  assert.ok((await item(ids.pc)).deleted_at);
  assert.equal(
    (
      await viewer.call('POST', '/api/logistics/act/pc-new', {
        code: 'X',
        messageA: 'y',
      })
    ).status,
    403
  );
});

test('addresses: add, edit (the app’s copy locks the field), delete', async () => {
  assert.equal((await act('addr-add', null, { name: '', address: 'x' })).body.error, 'Enter a name');
  assert.equal((await act('addr-add', null, { name: 'x', address: '' })).body.error, 'Enter the address');
  const r = await act('addr-add', null, {
    name: 'Grand Horology',
    address: 'Room 1007, Star House\nKowloon',
    notes: '',
  });
  ok(r);
  const d = (await item(r.body.created[0])).data;
  assert.deepEqual([d.name, d.address, d.notes], ['Grand Horology', 'Room 1007, Star House\nKowloon', '']);
  assert.match(d.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal((await activity()).at(-1), '📍 New logistics address: Grand Horology');
  ok(
    await act('addr-edit', ids.addr, {
      name: 'Dubai Home',
      address: 'Tower 1, Creek Harbour\nDubai, UAE',
      notes: 'buzz 43',
    })
  );
  const own = await item(ids.addr);
  assert.deepEqual([own.data.notes, own.locked_fields], ['buzz 43', ['notes']]);
  const page = await editor.call('GET', '/api/logistics/page/addresses');
  assert.equal(page.body.addresses.length, 2);
  ok(await act('addr-delete', r.body.created[0]));
  assert.ok((await item(r.body.created[0])).deleted_at);
  assert.equal((await viewer.call('POST', `/api/logistics/items/${ids.addr}/act/addr-delete`, {})).status, 403);
});

test('gold souk: a task as confirmGoldSouk writes it, done as confirmGoldSoukDone, edited, deleted', async () => {
  assert.equal((await act('gs-new', null, { shopName: '', whoGoing: 'Fiaz' })).body.error, 'Shop name / person is required.');
  assert.equal((await act('gs-new', null, { shopName: 'Sina Star', whoGoing: '' })).body.error, 'Enter who is going.');
  const r = await act('gs-new', null, {
    shopName: 'Sina Star',
    whoGoing: 'Fiaz',
    date: '2026-10-28',
    taking: 'Stock # 4101 and Stock # 4199',
    notes: 'give today',
  });
  ok(r);
  assert.match(r.body.message, /🏅 Task added · #4199 not one of our watches/);
  ids.gs = r.body.created[0];
  let d = (await item(ids.gs)).data;
  assert.deepEqual(
    [d.shopName, d.whoGoing, d.date, d.taking, d.notes, d.photos, d.status, d.resultPhotos, typeof d.ts],
    ['Sina Star', 'Fiaz', '2026-10-28', 'Stock # 4101 and Stock # 4199', 'give today', [], 'pending', [], 'number']
  );
  assert.deepEqual((await item(ids.gs)).stock_nos, ['4101', '4199']);
  assert.equal((await activity()).at(-1), '🏅 Gold Souk task: Fiaz → Sina Star · taking Stock # 4101 and Stock # 4199');
  ok(
    await act('gs-edit', ids.gs, {
      shopName: 'Sina Star',
      whoGoing: 'Jonny',
      date: '2026-10-28',
      taking: 'Stock # 4101',
      notes: '',
    })
  );
  d = (await item(ids.gs)).data;
  assert.deepEqual([d.whoGoing, d.taking, d.notes, d.status], ['Jonny', 'Stock # 4101', '', 'pending']);
  assert.equal((await activity()).at(-1), '✏️ Gold Souk task edited: Jonny → Sina Star');
  ok(await act('gs-done', ids.gs, { resultNotes: 'delivered, polished' }));
  d = (await item(ids.gs)).data;
  assert.deepEqual([d.status, typeof d.completedAt, d.resultNotes, d.resultPhotos], ['done', 'number', 'delivered, polished', []]);
  assert.equal((await activity()).at(-1), '✅ Gold Souk task done: Jonny → Sina Star');
  assert.equal((await act('gs-done', ids.gs, {})).status, 400);
  const page = await editor.call('GET', '/api/logistics/page/goldsouk');
  assert.deepEqual([page.body.done.length, page.body.done[0].stocks[0].watch.id], [1, ids.w4101]);
  ok(await act('gs-delete', ids.gs));
  assert.ok((await item(ids.gs)).deleted_at);
  assert.equal(
    (
      await viewer.call('POST', '/api/logistics/act/gs-new', {
        shopName: 'x',
        whoGoing: 'y',
      })
    ).status,
    403
  );
  // Every write of ours carries its event.
  assert.deepEqual(
    (await events(ids.gs)).map((e) => e.action),
    ['create', 'update', 'update', 'delete']
  );
});
