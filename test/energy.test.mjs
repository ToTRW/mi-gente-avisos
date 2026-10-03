// «Tiene la energía a tope»: the Worker's port of the app's energy maths (energyAt), and the notice built on it.
// The expected numbers in the first block were taken from the app's own model (src/lib/goats/model.ts, currentNeeds)
// for the same goats and moments, so a change of rates in the app that is not copied here fails this file.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import ece from 'http_ece';
import { energyAt, run } from '../core.mjs';
import { categoryOf, wants } from '../prefs.mjs';

const H = 3_600_000, MIN = 60_000;
const U = (y, m, d, h, mi = 0) => Date.UTC(y, m, d, h, mi);
const goat = (energy, restedAt, asleep, personality) => ({ restedAt, asleep, personality, needs: { food: 70, mood: 70, energy } });
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);

// ---------- the port ----------

const NOON = U(2026, 9, 3, 10);  // 12:00 in Madrid (summer time)

test('energyAt matches the app: in bed by day (90 an hour, a dormilona 117)', () => {
  close(energyAt(goat(20, NOON, true), NOON + 30 * MIN), 65);
  close(energyAt(goat(20, NOON, true, 'dormilona'), NOON + 30 * MIN), 78.5);
  close(energyAt(goat(20, NOON, true), NOON + 2 * H), 98.33333333333333); // she got up at full and has drained since
});

test('energyAt matches the app: awake she tires 1.5 an hour by day, and the night puts her to bed at 22:00', () => {
  close(energyAt(goat(100, NOON, false), NOON + 5 * H), 92.5);
  close(energyAt(goat(80, NOON, false), U(2026, 9, 3, 20, 30)), 87.5);   // 22:30: awake until 22:00, then 30 min of bed at 45 an hour
  close(energyAt(goat(30, U(2026, 9, 3, 19), false), U(2026, 9, 3, 23)), 100); // 21:00 awake, in bed from 22:00, full by 23:00
  close(energyAt(goat(25, NOON, false), NOON + 8 * H), 20);              // the floor
});

test('energyAt matches the app: at night she fills at half speed and stays in bed full until morning', () => {
  close(energyAt(goat(50, U(2026, 9, 3, 20), true), U(2026, 9, 3, 21)), 95);          // 22:00 to 23:00: 45 an hour
  close(energyAt(goat(60, U(2026, 9, 3, 20), false), U(2026, 9, 4, 4)), 100);         // full at 00:00, still in bed at 06:00
  close(energyAt(goat(30, U(2026, 9, 4, 3), true), U(2026, 9, 4, 8)), 95.5);          // 05:00 in bed, up at 07:00, awake since
});

test('energyAt matches the app: winter time, the clock change, and a clock that goes backwards', () => {
  close(energyAt(goat(20, U(2026, 10, 3, 20), true), U(2026, 10, 3, 21)), 99.83333333333333); // 21:00 to 22:00 in Madrid (winter)
  close(energyAt(goat(10, U(2026, 9, 24, 20, 30), false), U(2026, 9, 25, 8)), 97);            // across the change on the 25th
  close(energyAt(goat(55, NOON, true), NOON - H), 55);
});

test('energyAt: a goat missing fields reads like the app default (75, awake)', () => {
  close(energyAt({ restedAt: NOON }, NOON + 2 * H), 72);
  close(energyAt({ needs: {} }, NOON), 75);
});

// ---------- the notice ----------

const b64u = b => Buffer.from(b).toString('base64url');
const VAPID = createECDH('prime256v1');
VAPID.generateKeys();
const KEYS = { vapidPublic: b64u(VAPID.getPublicKey()), vapidPrivate: b64u(VAPID.getPrivateKey()) };
const PEOPLE = ['Alex', 'Vane', 'Guille'];

function device(name) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, auth, endpoint: `https://push.test/${name}`, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) } };
}
const enc = v => typeof v === 'string' ? { stringValue: v } : typeof v === 'number' ? { integerValue: String(v) } : typeof v === 'boolean' ? { booleanValue: v }
  : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } }
  : { mapValue: { fields: Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, enc(x)])) } };
const doc = (path, o) => ({ name: `projects/p/databases/(default)/documents/${path}`, fields: enc(o).mapValue.fields });

/** A stand-in Firestore with a farm: `goats` is { id: goat document }, `prefs` config/push-prefs. push-state is kept between rounds. */
function world({ goats, prefs, farmOpen = true, state = {} }) {
  const w = {
    goats, prefs, farmOpen, pushes: [], devices: Object.fromEntries(PEOPLE.map(p => [p, device(p)])),
    state: JSON.stringify({ logs: new Date(NOON - 60_000).toISOString(), chat: new Date(NOON - 60_000).toISOString(), ...state }),
  };
  const read = (hit, p) => JSON.parse(ece.decrypt(Buffer.from(hit.body), { version: 'aes128gcm', privateKey: w.devices[p].ecdh, authSecret: b64u(w.devices[p].auth) }).toString('utf8'));
  /** One round at `now`; resolves to the notices that went out: [{ to, title, body, url, tag }]. */
  w.round = async now => {
    const real = globalThis.fetch;
    const json = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    const hits = [];
    globalThis.fetch = async (url, init = {}) => {
      url = String(url);
      if (url.startsWith('https://push.test/')) { hits.push({ to: url.split('/').pop(), body: init.body }); return { ok: true, status: 201, text: async () => '' }; }
      if (init.method === 'PATCH') {
        const [path] = url.split('/config/')[1].split('?');
        if (path === 'push-state') w.state = JSON.parse(init.body).fields.json.stringValue;
        return json({});
      }
      if (init.method === 'POST') return json([]);
      if (url.includes('/config/push-subs')) return json(doc('config/push-subs', Object.fromEntries(Object.entries(w.devices).map(([p, d]) => [p, { d0: { endpoint: d.endpoint, keys: d.keys, at: 1 } }]))));
      if (url.includes('/config/push-prefs')) return w.prefs === undefined ? { ok: false, status: 404, json: async () => ({}), text: async () => '' } : json(doc('config/push-prefs', w.prefs));
      if (url.includes('/config?')) {
        const all = { users: { list: PEOPLE }, roles: { admins: ['Alex'] }, preferences: { farmEnabled: true, farmOpen: w.farmOpen }, 'push-state': { json: w.state },
          ...Object.fromEntries(Object.entries(w.goats).map(([id, g]) => [`goat-${id}`, g])) };
        return json({ documents: Object.entries(all).map(([id, o]) => doc(`config/${id}`, o)) });
      }
      if (url.includes('/presence?')) return json({});
      throw new Error(`unexpected ${url}`);
    };
    try { await run({ project: 'mi-gente-preprod', now, log: () => {}, ...KEYS }); } finally { globalThis.fetch = real; }
    return hits.map(h => ({ to: h.to, ...read(h, h.to) }));
  };
  w.queue = p => (JSON.parse(w.state).queue?.[p] || []);
  w.low = id => JSON.parse(w.state).low?.[id];
  return w;
}

const FULL = { title: '⚡ Lola tiene la energía a tope', body: 'Lista para jugar o salir de excursión', url: '/?cabrita=g1', tag: 'energy-g1' };
const lola = (energy, restedAt, asleep, extra = {}) => ({ owner: 'Vane', name: 'Lola', ...goat(energy, restedAt, asleep), ...extra });

test('the kind is in the «Tu cabrita» category: whoever switched it off is not told', () => {
  assert.equal(categoryOf('farm:energy'), 'cabrita');
  assert.equal(wants({ Vane: { cabrita: false } }, 'Vane', 'farm:energy'), false);
  assert.equal(wants({ Vane: { chat: false } }, 'Vane', 'farm:energy'), true);
});

test('she sleeps from 20 to full: one notice, once; the next time she runs low it can come again', async () => {
  const w = world({ goats: { g1: lola(20, NOON, true) } });
  assert.deepEqual(await w.round(NOON + 10 * MIN), [], 'low and filling: nothing yet');
  assert.equal(w.low('g1').energy, true, 'but it is remembered');
  assert.deepEqual(await w.round(NOON + 40 * MIN), [], 'at 80 she is not full');
  assert.deepEqual(await w.round(NOON + H), [{ to: 'Vane', ...FULL }], 'full (she woke up at 100 seven minutes ago): told');
  assert.equal(w.low('g1').energy, false);
  assert.deepEqual(await w.round(NOON + H + 5 * MIN), [], 'not twice');
  assert.deepEqual(await w.round(NOON + 3 * H), [], 'nor two hours later');
  // the next cycle: someone plays with her until she is at 30 and puts her to bed again
  w.goats.g1 = lola(30, NOON + 4 * H, true);
  assert.deepEqual(await w.round(NOON + 4 * H + 5 * MIN), []);
  assert.deepEqual(await w.round(NOON + 5 * H), [{ to: 'Vane', ...FULL }], 'a new cycle, a new notice');
});

test('by day she is only exactly 100 for an instant: a round that comes half an hour late still finds her full', async () => {
  const w = world({ goats: { g1: lola(20, NOON, true) } });
  await w.round(NOON + 10 * MIN);
  close(energyAt(w.goats.g1, NOON + 85 * MIN), 99.20833333333333);
  assert.deepEqual(await w.round(NOON + 85 * MIN), [{ to: 'Vane', ...FULL }]);
});

test('a round that misses her by day is not lost: the night fills her and the morning tells', async () => {
  const w = world({ goats: { g1: lola(20, NOON, true) } });
  await w.round(NOON + 10 * MIN);
  assert.deepEqual(await w.round(NOON + 2 * H), [], 'she is at 98.3 by now');
  assert.equal(w.low('g1').energy, true, 'still armed');
  assert.deepEqual(await w.round(U(2026, 9, 3, 21, 30)), [], '23:30, in bed and full since about 22:20, but quiet hours');
  assert.equal(w.queue('Vane').length, 1);
  const morning = await w.round(U(2026, 9, 4, 7)); // (she is hungry and sad by then too: those are not this test's business)
  assert.deepEqual(morning.filter(s => s.tag === 'energy-g1'), [{ to: 'Vane', ...FULL }]);
});

test('it only goes to the owner', async () => {
  const w = world({ goats: { g1: lola(20, NOON, true), g2: { owner: 'Guille', name: 'Pepa', ...goat(100, NOON, false) } } });
  await w.round(NOON + 10 * MIN);
  const sent = await w.round(NOON + H);
  assert.deepEqual(sent.map(s => s.to), ['Vane']);
});

test('energy that was already high does not ping: 95 filling up, 100 awake, a dip to 70', async () => {
  const w = world({ goats: {
    g1: lola(95, NOON, true),                                  // full again in four minutes, but never was low
    g2: { owner: 'Guille', name: 'Pepa', ...goat(100, NOON, false) },
    g3: { owner: 'Alex', name: 'Nina', ...goat(70, NOON, true) },
  } });
  for (const t of [10 * MIN, H, 2 * H, 3 * H]) assert.deepEqual(await w.round(NOON + t), [], `at +${t / MIN} min`);
  assert.equal(w.low('g1').energy, undefined, 'nothing was armed');
});

test('the threshold is under 60: at 60 she is not low, under it she is', async () => {
  const w = world({ goats: { g1: lola(60, NOON, true), g2: { owner: 'Guille', name: 'Pepa', ...goat(59.5, NOON, true) } } });
  assert.deepEqual(await w.round(NOON), []);
  assert.equal(w.low('g1').energy, undefined);
  assert.equal(w.low('g2').energy, true);
});

test('the «Tu cabrita» preference: switched off, no notice (and it is not saved for later)', async () => {
  const w = world({ goats: { g1: lola(20, NOON, true), g2: { owner: 'Guille', name: 'Pepa', ...goat(20, NOON, true) } }, prefs: { Vane: { cabrita: false } } });
  await w.round(NOON + 10 * MIN);
  const sent = await w.round(NOON + H);
  assert.deepEqual(sent.map(s => `${s.to}:${s.tag}`), ['Guille:energy-g2'], 'Guille still hears it');
  assert.deepEqual(w.queue('Vane'), []);
  w.prefs = { Vane: { cabrita: true } };
  assert.deepEqual(await w.round(NOON + 3 * H), [], 'switching it back on does not bring it back');
});

test('only for whoever can play the farm', async () => {
  const w = world({ goats: { g1: lola(20, NOON, true), g2: { owner: 'Alex', name: 'Nina', ...goat(20, NOON, true) } }, farmOpen: false });
  await w.round(NOON + 10 * MIN);
  const sent = await w.round(NOON + H);
  assert.deepEqual(sent.map(s => s.to), ['Alex'], 'the farm is closed to Vane: only the admin plays');
});

test('a goat that has no energy on record is not a notice', async () => {
  const w = world({ goats: { g1: { owner: 'Vane', name: 'Lola', restedAt: NOON, needs: { food: 70, mood: 70 } } } });
  assert.deepEqual(await w.round(NOON + 2 * H), []);
});

test('at night: full at 03:47 is held for the morning, once, and still true when it goes out', async () => {
  const bed = U(2026, 9, 4, 0);            // 02:00 in Madrid, in bed at 20: 45 an hour, full 1 h 47 later
  const w = world({ goats: { g1: lola(20, bed, true) }, state: { logs: new Date(bed - 60_000).toISOString(), chat: new Date(bed - 60_000).toISOString() } });
  assert.deepEqual(await w.round(bed + 10 * MIN), [], 'quiet hours, and not full');
  assert.deepEqual(await w.round(bed + 2 * H), [], 'full at 04:00: quiet hours, so it waits');
  assert.equal(w.queue('Vane').length, 1);
  assert.equal(w.queue('Vane')[0].kind, 'farm:energy');
  assert.equal(w.low('g1').energy, false);
  assert.deepEqual(await w.round(U(2026, 9, 4, 5)), [], '07:00, still quiet');
  assert.equal(w.queue('Vane').length, 1, 'no second copy in the queue');
  close(energyAt(w.goats.g1, U(2026, 9, 4, 7)), 97); // at 09:00 she has been up two hours (full at 07:00, 1.5 an hour since): still a tope
  assert.deepEqual(await w.round(U(2026, 9, 4, 7)), [{ to: 'Vane', ...FULL }], '09:00: it arrives, once');
  assert.deepEqual(w.queue('Vane'), []);
  assert.deepEqual(await w.round(U(2026, 9, 4, 7, 5)), [], 'and not again');
});

test('at night, with the preference switched off before the morning: it is dropped from the queue', async () => {
  const bed = U(2026, 9, 4, 0);
  const w = world({ goats: { g1: lola(20, bed, true) }, state: { logs: new Date(bed - 60_000).toISOString(), chat: new Date(bed - 60_000).toISOString() } });
  await w.round(bed + 10 * MIN);
  await w.round(bed + 2 * H);
  assert.equal(w.queue('Vane').length, 1);
  w.prefs = { Vane: { cabrita: false } };
  assert.deepEqual(await w.round(U(2026, 9, 4, 7)), []);
  assert.deepEqual(w.queue('Vane'), []);
});

test('the goat that went to bed at 22:00 and is full before midnight: one notice in the morning, not at night', async () => {
  const eve = U(2026, 9, 3, 19);           // 21:00 in Madrid, awake at 40
  const w = world({ goats: { g1: lola(40, eve, false) }, state: { logs: new Date(eve - 60_000).toISOString(), chat: new Date(eve - 60_000).toISOString() } });
  assert.deepEqual(await w.round(eve + 30 * MIN), [], '21:30, awake and low: armed');
  assert.deepEqual(await w.round(U(2026, 9, 3, 21, 40)), [], '23:40: full since about 23:22, but it is quiet hours');
  assert.equal(w.queue('Vane').length, 1);
  assert.deepEqual(await w.round(U(2026, 9, 4, 7)), [{ to: 'Vane', ...FULL }]);
});
