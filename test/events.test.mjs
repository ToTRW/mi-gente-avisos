// Farm events: the Worker follows the app's schedule (src/lib/goats/events.ts: EVENT_SCHEDULE), and config/farm-event is only a
// manual override that wins while it is on. «Empieza» once when an event starts, «Último día» in its final 24 hours, never twice.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import ece from 'http_ece';
import { run, farmEventAt, EVENT_SCHEDULE } from '../core.mjs';
import { firestoreStand } from './fakefs.mjs';

const U = (y, m, d, h, mi = 0) => Date.UTC(y, m, d, h, mi);
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

/** A stand-in Firestore with no goats; push-state is kept between rounds. `doc` is config/farm-event (it can change between rounds). */
function world({ doc, farmEnabled = true, farmOpen = true } = {}) {
  const w = {
    doc, reads: [], devices: Object.fromEntries(PEOPLE.map(p => [p, device(p)])),
    state: JSON.stringify({ logs: new Date(U(2026, 9, 1, 0)).toISOString(), chat: new Date(U(2026, 9, 1, 0)).toISOString() }),
  };
  const read = (hit, p) => JSON.parse(ece.decrypt(Buffer.from(hit.body), { version: 'aes128gcm', privateKey: w.devices[p].ecdh, authSecret: b64u(w.devices[p].auth) }).toString('utf8'));
  /** One round at `now`; resolves to the notices that went out: [{ to, title, body, url, tag }]. */
  w.round = async now => {
    const fs = firestoreStand();
    Object.assign(fs.config, { users: { list: PEOPLE }, roles: { admins: ['Alex'] }, preferences: { farmEnabled, farmOpen }, 'push-state': { json: w.state },
      'push-subs': Object.fromEntries(Object.entries(w.devices).map(([p, d]) => [p, { d0: { endpoint: d.endpoint, keys: d.keys, at: 1 } }])) },
      w.doc ? { 'farm-event': w.doc } : {});
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
      const answered = fs.handle(url, init);
      if (answered) return answered;
      if (init.method === 'POST') return json([]);
      throw new Error(`unexpected ${url}`);
    };
    try { await run({ project: 'mi-gente-preprod', now, log: () => {}, ...KEYS }); } finally { globalThis.fetch = real; }
    w.reads.push(fs.reads);
    return hits.map(h => ({ to: h.to, ...read(h, h.to) }));
  };
  return w;
}

const titles = sent => [...new Set(sent.map(s => s.title))];
const START_CASTANAS = '🎉 Empieza: Castañas', LAST_CASTANAS = '⏳ Último día: Castañas';
const CASTANAS_BLURB = 'Caen castañas por la granja: recógelas, cada una da una hoja.';

test("the schedule is the app's: castañas 12 to 19 Oct at 12:00 Madrid, Halloween 22 Oct to 3 Nov (the clocks change inside it)", () => {
  assert.deepEqual(EVENT_SCHEDULE.map(e => [e.id, new Date(e.from).toISOString(), new Date(e.to).toISOString()]), [
    ['castanas', '2026-10-12T10:00:00.000Z', '2026-10-19T10:00:00.000Z'],
    ['halloween', '2026-10-22T10:00:00.000Z', '2026-11-03T11:00:00.000Z'],
  ]);
  assert.equal(farmEventAt(null, U(2026, 9, 12, 9, 59)), null);
  assert.equal(farmEventAt(null, U(2026, 9, 12, 10))?.id, 'castanas');
  assert.equal(farmEventAt(null, U(2026, 9, 19, 9, 59))?.id, 'castanas');
  assert.equal(farmEventAt(null, U(2026, 9, 19, 10)), null, 'the end is exclusive');
  assert.equal(farmEventAt(null, U(2026, 10, 3, 10, 59))?.id, 'halloween');
  assert.equal(farmEventAt(null, U(2026, 10, 3, 11)), null);
});

test('no doc: the start notice goes out on 12 Oct at 12:00 Madrid, once, to everyone who plays', async () => {
  const w = world();
  assert.deepEqual(await w.round(U(2026, 9, 12, 9, 55)), [], '11:55 in Madrid: not yet');
  const sent = await w.round(U(2026, 9, 12, 10));
  assert.deepEqual(sent.map(s => s.to).sort(), PEOPLE.slice().sort());
  assert.deepEqual(sent[0], { to: sent[0].to, title: START_CASTANAS, body: CASTANAS_BLURB, url: '/?granja', tag: 'event' });
  assert.deepEqual(await w.round(U(2026, 9, 12, 10, 5)), [], 'not twice');
  assert.deepEqual(await w.round(U(2026, 9, 15, 10)), [], 'nor on a day in the middle');
});

test("only the farm's players hear it, and with the farm off nobody does", async () => {
  const closed = world({ farmOpen: false });
  assert.deepEqual((await closed.round(U(2026, 9, 14, 18))).map(s => s.to), ['Alex'], 'the farm is closed to the others: only the admin plays');
  assert.deepEqual(await world({ farmEnabled: false }).round(U(2026, 9, 14, 18)), [], 'no farm, no event');
});

test('no doc: the last-day notice in the final 24 hours, once', async () => {
  const w = world();
  await w.round(U(2026, 9, 12, 10));
  assert.deepEqual(await w.round(U(2026, 9, 18, 9, 55)), [], 'a little over a day left');
  const sent = await w.round(U(2026, 9, 18, 10, 5));
  assert.deepEqual(titles(sent), [LAST_CASTANAS]);
  assert.equal(sent.length, 3);
  assert.deepEqual(await w.round(U(2026, 9, 18, 16)), [], 'not twice');
  assert.deepEqual(await w.round(U(2026, 9, 19, 9, 55)), []);
});

test("Halloween's last day: 2 Nov, up to 12:00 on the 3rd in winter time", async () => {
  const w = world();
  assert.deepEqual(titles(await w.round(U(2026, 9, 22, 10))), ['🎉 Empieza: Halloween']);
  assert.deepEqual(await w.round(U(2026, 10, 2, 10, 55)), [], '11:55 in Madrid on the 2nd: more than 24 hours to go');
  assert.deepEqual(titles(await w.round(U(2026, 10, 2, 11, 5))), ['⏳ Último día: Halloween']);
});

test('nothing from 19 to 21 Oct', async () => {
  const w = world();
  await w.round(U(2026, 9, 12, 10));
  await w.round(U(2026, 9, 18, 10, 5));
  for (const [d, h, mi] of [[19, 10, 0], [19, 12, 30], [19, 18, 0], [20, 10, 0], [20, 17, 35], [21, 10, 0], [21, 18, 0], [22, 9, 55]])
    assert.deepEqual(await w.round(U(2026, 9, d, h, mi)), [], `${d} Oct ${h}:${mi}Z`);
  assert.deepEqual(titles(await w.round(U(2026, 9, 22, 10))), ['🎉 Empieza: Halloween'], 'and then Halloween');
});

test('the override wins while it is on: its own name and blurb, and the schedule says nothing meanwhile', async () => {
  const w = world({ doc: { id: 'halloween', from: U(2026, 9, 13, 10), to: U(2026, 9, 15, 10), name: 'Fiesta', blurb: 'Una fiesta suelta.' } });
  const sent = await w.round(U(2026, 9, 13, 11)); // castañas is scheduled on this day: it is not what is said
  assert.deepEqual(sent[0], { to: sent[0].to, title: '🎉 Empieza: Fiesta', body: 'Una fiesta suelta.', url: '/?granja', tag: 'event' });
  assert.deepEqual(titles(await w.round(U(2026, 9, 14, 10, 5))), ['⏳ Último día: Fiesta']);
  assert.deepEqual(await w.round(U(2026, 9, 14, 12)), [], 'castañas is scheduled all this time and stays quiet');
});

test('a doc that is over, not yet on, or not a real one is no override: the schedule applies', () => {
  const doc = { id: 'halloween', from: U(2026, 9, 13, 10), to: U(2026, 9, 15, 10), name: 'Fiesta' };
  assert.equal(farmEventAt(doc, U(2026, 9, 13, 9)).source, 'schedule');
  assert.equal(farmEventAt(doc, U(2026, 9, 13, 10)).source, 'doc');
  assert.equal(farmEventAt(doc, U(2026, 9, 14, 12)).id, 'halloween', 'on: it wins over the castañas of the schedule');
  assert.equal(farmEventAt(doc, U(2026, 9, 15, 10)).id, 'castanas', 'over: the schedule is back');
  assert.equal(farmEventAt({ id: 'castanas', from: 'x', to: 5 }, U(2026, 9, 14, 12)).source, 'schedule', 'a doc without real numbers is not one');
  assert.equal(farmEventAt(undefined, U(2026, 9, 20, 12)), null);
});

test("a doc without a name takes the event's own", async () => {
  const w = world({ doc: { id: 'castanas', from: U(2026, 9, 11, 10), to: U(2026, 9, 12, 10) } });
  const sent = await w.round(U(2026, 9, 11, 12));
  assert.deepEqual(sent[0], { to: sent[0].to, title: START_CASTANAS, body: CASTANAS_BLURB, url: '/?granja', tag: 'event' });
});

test('a doc started over the scheduled event keeps the scheduled start: no second «Empieza»', async () => {
  const w = world();
  assert.deepEqual(titles(await w.round(U(2026, 9, 12, 10))), [START_CASTANAS]);
  // Admin presses «Empezar ahora» two days in (the app keeps the scheduled `from` and sets its own end)
  w.doc = { id: 'castanas', from: U(2026, 9, 12, 10), to: U(2026, 9, 21, 10), name: 'Castañas', blurb: CASTANAS_BLURB };
  assert.deepEqual(await w.round(U(2026, 9, 14, 12)), []);
  // ...and even if the doc carries a `from` of its own inside the window, it is the same event
  w.doc = { ...w.doc, from: U(2026, 9, 14, 10) };
  assert.deepEqual(await w.round(U(2026, 9, 14, 12, 5)), []);
  // it runs past the schedule's 19 Oct: still the same event, and its last day is said once, at the end of the doc
  assert.deepEqual(await w.round(U(2026, 9, 19, 12)), [], 'not the last day yet');
  assert.deepEqual(titles(await w.round(U(2026, 9, 20, 12))), [LAST_CASTANAS]);
  assert.deepEqual(await w.round(U(2026, 9, 20, 18)), [], 'once');
});

test('a doc that ran before the schedule does not make the schedule start it again', async () => {
  const w = world({ doc: { id: 'castanas', from: U(2026, 9, 9, 10), to: U(2026, 9, 11, 10), name: 'Castañas', blurb: CASTANAS_BLURB } });
  assert.deepEqual(titles(await w.round(U(2026, 9, 9, 12))), [START_CASTANAS], 'early, by hand');
  assert.deepEqual(await w.round(U(2026, 9, 12, 12)), [], 'the schedule takes over the same event: no second start');
  assert.deepEqual(titles(await w.round(U(2026, 9, 18, 12))), [LAST_CASTANAS], 'but its last day is still said');
});

test('no new Firestore reads: a round with the schedule on reads what one with nothing on reads', async () => {
  const on = world(), off = world();
  await on.round(U(2026, 9, 12, 10));
  await off.round(U(2026, 9, 20, 10));
  assert.equal(on.reads[0], off.reads[0]);
});
