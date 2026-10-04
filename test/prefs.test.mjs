// Notification preferences (config/push-prefs = { [name]: { [category]: false } }): a person who switched a category off
// does not hear that kind of notice; a missing person or category is on; others are unaffected; «Probar avisos» ignores
// the lot. Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import ece from 'http_ece';
import { run } from '../core.mjs';
import { firestoreStand } from './fakefs.mjs';
import { CATEGORIES, KIND_CATEGORY, categoryOf, wants } from '../prefs.mjs';

const b64u = b => Buffer.from(b).toString('base64url');
const DAY = Date.UTC(2026, 9, 3, 10, 0, 0);     // 12:00 in Madrid
const NIGHT = Date.UTC(2026, 9, 3, 21, 30, 0);  // 23:30 in Madrid: quiet hours, and past 20:00 for the streak
const MORNING = Date.UTC(2026, 9, 4, 8, 0, 0);  // 10:00 in Madrid
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
const read = (w, d) => JSON.parse(ece.decrypt(Buffer.from(w.bodies[d.endpoint]), { version: 'aes128gcm', privateKey: d.ecdh, authSecret: b64u(d.auth) }).toString('utf8'));

const ts = iso => ({ $ts: iso });
const enc = v => v && v.$ts ? { timestampValue: v.$ts }
  : typeof v === 'string' ? { stringValue: v } : typeof v === 'number' ? { integerValue: String(v) } : typeof v === 'boolean' ? { booleanValue: v }
  : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } }
  : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
const doc = (path, o) => ({ name: `projects/p/databases/(default)/documents/${path}`, fields: enc(o).mapValue.fields });

/**
 * A stand-in Firestore. `prefs` is config/push-prefs (undefined = the document does not exist), `logs`, `messages`,
 * `presence` and `config` what the round reads. push-state is kept between rounds.
 */
function world({ prefs, logs = [], messages = [], presence = {}, config = {}, devices = PEOPLE, state = {} } = {}) {
  const w = {
    prefs, logs, messages, presence, config, hits: [], bodies: {}, patches: [],
    devices: Object.fromEntries(devices.map(p => [p, device(p)])),
    state: JSON.stringify({ logs: new Date(DAY - 60_000).toISOString(), chat: new Date(DAY - 60_000).toISOString(), ...state }),
  };
  w.round = async (now, extra = {}) => {
    const fs = firestoreStand();
    Object.assign(fs.config, { users: { list: PEOPLE }, roles: { admins: ['Alex'] }, 'push-state': { json: w.state }, ...w.config },
      { 'push-subs': Object.fromEntries(Object.entries(w.devices).map(([p, d]) => [p, { d0: { endpoint: d.endpoint, keys: d.keys, at: 1 } }])) },
      w.prefs === undefined ? {} : { 'push-prefs': w.prefs });
    Object.assign(fs.presence, w.presence);
    const real = globalThis.fetch;
    const json = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    globalThis.fetch = async (url, init = {}) => {
      url = String(url);
      if (url.startsWith('https://push.test/')) { w.hits.push(url); w.bodies[url] = init.body; return { ok: true, status: 201, text: async () => '' }; }
      if (init.method === 'PATCH') {
        const [path] = url.split('/config/')[1].split('?');
        if (path === 'push-state') w.state = JSON.parse(init.body).fields.json.stringValue;
        w.patches.push(path);
        return json({});
      }
      const answered = fs.handle(url, init);
      if (answered) return answered;
      if (init.method === 'POST') {
        const body = String(init.body);
        const rows = body.includes('activityLogs') ? w.logs.map((o, i) => [`activityLogs/l${i}`, o]) : body.includes('"messages"') ? w.messages.map((o, i) => [`messages/m${i}`, o]) : [];
        return json(rows.map(([path, o]) => ({ document: { ...doc(path, o), updateTime: (o.at ?? o.ts).$ts } })));
      }
      if (url.includes('/events/e1')) return json(doc('events/e1', { name: 'Cena', participants: PEOPLE }));
      throw new Error(`unexpected ${url}`);
    };
    w.hits.length = 0;
    try { await run({ project: 'mi-gente-preprod', now, log: () => {}, ...KEYS, ...extra }); } finally { globalThis.fetch = real; }
    return w;
  };
  return w;
}

const create = { action: 'event:create', actor: 'Alex', eventId: 'e1', eventName: 'Cena', at: ts(new Date(DAY - 30_000).toISOString()) };
const chat = { name: 'Alex', text: 'hola', ts: ts(new Date(DAY - 20_000).toISOString()) };
const heard = (w, p) => w.hits.includes(w.devices[p].endpoint);

test('the table: every kind has a known category, every category is used (the races included, though none is sent yet)', () => {
  for (const [kind, category] of Object.entries(KIND_CATEGORY)) assert.ok(CATEGORIES.includes(category), `${kind} -> ${category}`);
  const used = new Set(Object.values(KIND_CATEGORY));
  assert.deepEqual(CATEGORIES.filter(c => !used.has(c)), []);
  assert.equal(categoryOf('test'), undefined);
  assert.equal(categoryOf('constructor'), undefined);
  assert.equal(categoryOf(undefined), undefined);
});

test('wants: only a category switched off with false is muted', () => {
  assert.equal(wants(undefined, 'Vane', 'chat'), true);
  assert.equal(wants({}, 'Vane', 'chat'), true);
  assert.equal(wants({ Vane: {} }, 'Vane', 'chat'), true);
  assert.equal(wants({ Vane: { chat: false } }, 'Vane', 'chat'), false);
  assert.equal(wants({ Vane: { chat: false } }, 'Vane', 'plan:create'), true, 'another category');
  assert.equal(wants({ Vane: { chat: false } }, 'Guille', 'chat'), true, 'another person');
  assert.equal(wants({ Vane: { chat: true } }, 'Vane', 'chat'), true);
  assert.equal(wants({ Vane: 'nonsense' }, 'Vane', 'chat'), true);
  assert.equal(wants({ Vane: { chat: false } }, 'Vane', 'test'), true, 'a test has no category');
  assert.equal(wants({ Vane: { chat: false } }, 'Vane', undefined), true, 'an old queued notice with no kind');
  assert.equal(wants({ Vane: { planes: false, recordatorios: false } }, 'Vane', 'plan:nudge'), false);
  assert.equal(wants({ Vane: { planes: false } }, 'Vane', 'plan:nudge'), true, 'reminders are their own category');
});

test('no preferences document: everybody hears everything', async () => {
  const w = world({ logs: [create], messages: [chat] });
  await w.round(DAY);
  assert.ok(heard(w, 'Vane') && heard(w, 'Guille'));
});

test('a person with planes off does not hear the plan, the others do', async () => {
  const w = world({ prefs: { Vane: { planes: false } }, logs: [create] });
  await w.round(DAY);
  assert.equal(heard(w, 'Vane'), false);
  assert.equal(heard(w, 'Guille'), true);
  assert.equal(heard(w, 'Alex'), false, 'the one who made it is never told');
});

test('only that category is muted: Vane keeps the chat', async () => {
  const w = world({ prefs: { Vane: { planes: false } }, logs: [create], messages: [chat] });
  await w.round(DAY);
  assert.equal(heard(w, 'Vane'), true);
  assert.equal(read(w, w.devices.Vane).tag, 'chat');
  assert.equal(heard(w, 'Guille'), true);
});

test('a missing person or category means on', async () => {
  const w = world({ prefs: { Guille: { chat: false }, Alex: {} }, logs: [create] });
  await w.round(DAY);
  assert.ok(heard(w, 'Vane') && heard(w, 'Guille'));
});

test('reminders (nudges) are their own category, apart from the plans', async () => {
  const nudge = { action: 'event:nudge', actor: 'Alex', eventId: 'e1', eventName: 'Cena', names: ['Vane', 'Guille'], at: ts(new Date(DAY - 30_000).toISOString()) };
  const w = world({ prefs: { Vane: { planes: false }, Guille: { recordatorios: false } }, logs: [nudge] });
  await w.round(DAY);
  assert.equal(heard(w, 'Vane'), true, 'switching plans off does not switch the reminders off');
  assert.equal(heard(w, 'Guille'), false);
});

test('«llega tarde», pokes and bug reports have a category each', async () => {
  const late = { action: 'late:set', actor: 'Vane', eventId: 'e1', eventName: 'Cena', until: '21:30', at: ts(new Date(DAY - 30_000).toISOString()) };
  const bug = { kind: 'bug', by: 'Vane', text: 'se rompe', at: DAY - 60_000 };
  const w = world({
    prefs: { Alex: { tarde: false, toques: false, fallos: false }, Guille: { tarde: false } },
    logs: [late], presence: { Alex: { missed: { Vane: 1 } }, Guille: { missed: { Vane: 1 } } },
    config: { 'bug-1777777777777-abc123': bug },
  });
  await w.round(DAY);
  assert.equal(heard(w, 'Alex'), false, 'late, poke and bug all muted');
  assert.equal(heard(w, 'Guille'), true, 'late muted, but the poke gets through');
});

test('a notice that waited for the morning follows the choice made by then', async () => {
  const w = world({ logs: [{ ...create, at: ts(new Date(NIGHT - 30_000).toISOString()) }], state: { logs: new Date(NIGHT - 60_000).toISOString(), chat: new Date(NIGHT - 60_000).toISOString() } });
  await w.round(NIGHT);
  assert.deepEqual(w.hits, [], 'quiet hours');
  w.prefs = { Vane: { planes: false } };
  await w.round(MORNING);
  assert.equal(heard(w, 'Vane'), false);
  assert.equal(heard(w, 'Guille'), true);
});

test('«Probar avisos» ignores the preferences', async () => {
  const everything = Object.fromEntries(CATEGORIES.map(c => [c, false]));
  const request = { id: 'pt-1', to: ['Vane'], text: 'hola prueba', by: 'Alex', at: DAY - 60_000 };
  const w = world({ prefs: { Vane: everything, Guille: everything }, config: { 'push-test': request } });
  await w.round(DAY);
  assert.deepEqual(w.hits, [w.devices.Vane.endpoint]);
  assert.equal(read(w, w.devices.Vane).tag, 'test');
  assert.equal(read(w, w.devices.Vane).body, 'hola prueba');
  assert.ok(w.patches.includes('push-test'), 'and the results are written back');
});

test('every kind the round sends is in the table (all of them, queued at night)', async () => {
  const at = new Date(NIGHT - 30_000).toISOString();
  const entry = (action, more = {}) => ({ action, actor: 'Alex', eventId: 'e1', eventName: 'Cena', at: ts(at), ...more });
  const old = NIGHT - 40 * 3_600_000;
  const w = world({
    devices: [],
    logs: [entry('event:create'), entry('event:lock'), entry('event:postpone'), entry('event:edit', { datesChanged: true }), entry('event:nudge', { names: ['Vane'] }),
      entry('event:nudge-maybe', { names: ['Vane'] }), entry('late:set', { until: '22:00' })],
    messages: [{ name: 'Alex', text: 'hola', ts: ts(at) }],
    presence: { Vane: { missed: { Alex: 1 } } },
    config: {
      preferences: { farmEnabled: true, farmOpen: true },
      'bug-1777777777777-abc123': { kind: 'bug', by: 'Vane', text: 'se rompe', at: NIGHT - 60_000 },
      'goat-g1': { owner: 'Vane', name: 'Lola', restedAt: old, needs: { food: 70, mood: 70 }, boxes: ['x'], streak: { count: 5, day: '2026-10-02' }, soloTrip: { id: 't1', collected: false, startedAt: old, durationMs: 1000 } },
      'goat-g2': { owner: 'Guille', name: 'Pepa', restedAt: NIGHT },
      'goat-g3': { owner: 'Alex', name: 'Nina', restedAt: NIGHT - 3 * 3_600_000, asleep: true, needs: { food: 70, mood: 70, energy: 20 } }, // full again by now, and seen low before
      'farm-costume-gift-1': { status: 'pending', toGoatId: 'g1', fromGoatId: 'g2', offeredAt: 5 },
      'farm-event': { id: 'ev1', from: NIGHT - 3_600_000, to: NIGHT + 3_600_000, name: 'Fiesta' },
    },
    state: { logs: new Date(NIGHT - 60_000).toISOString(), chat: new Date(NIGHT - 60_000).toISOString(), boxSeen: { g1: old }, low: { g3: { energy: true } } },
  });
  await w.round(NIGHT);
  const queued = Object.values(JSON.parse(w.state).queue).flat();
  const kinds = new Set(queued.map(o => o.kind));
  assert.ok(queued.length > 10, `got ${queued.length}`);
  assert.ok(queued.every(o => categoryOf(o.kind)), `a notice without a category: ${JSON.stringify(queued.find(o => !categoryOf(o.kind)))}`);
  // the update notice only exists for the live project (test/update.test.mjs), and no race notice is sent yet
  const missing = Object.keys(KIND_CATEGORY).filter(k => !kinds.has(k) && !['race', 'app-update', 'plan:reminder'].includes(k));
  assert.deepEqual(missing, [], 'every kind was triggered');
});
