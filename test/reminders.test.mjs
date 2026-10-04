// All Firestore and push requests are fake. No real notification endpoints are used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import ece from 'http_ece';
import { run } from '../core.mjs';
import { lockedStart, confirmedParticipants, duePlanReminders, reminderStillValid } from '../reminders.mjs';
import { firestoreStand } from './fakefs.mjs';
import { categoryOf, wants } from '../prefs.mjs';

const H = 3_600_000, M = 60_000;
const PEOPLE = ['Alex', 'Vane', 'Guille', 'Indar', 'Raul', 'Nadia'];
const plan = (over = {}) => ({ name: 'Cena', participants: PEOPLE, locked: { date: '2026-10-04', startHour: 12, endHour: 14 }, rsvpStatus: { Alex: 'yes', Vane: 'yes' }, ...over });
const START = Date.parse('2026-10-04T10:00:00Z');

test('locked start validates calendar dates and hours, including Madrid winter/summer and DST transitions', () => {
  assert.equal(lockedStart(plan()), START);
  assert.equal(lockedStart(plan({ locked: { date: '2026-01-04', startHour: 12, endHour: 14 } })), Date.parse('2026-01-04T11:00:00Z'));
  assert.equal(lockedStart(plan({ locked: { date: '2026-03-29', startHour: 12, endHour: 14 } })), Date.parse('2026-03-29T10:00:00Z'));
  assert.equal(lockedStart(plan({ locked: { date: '2026-10-25', startHour: 12, endHour: 14 } })), Date.parse('2026-10-25T11:00:00Z'));
  assert.equal(lockedStart(plan({ locked: { date: '2026-03-29', startHour: 2, endHour: 3 } })), null, 'spring clock gap');
  assert.equal(lockedStart(plan({ locked: { date: '2026-10-25', startHour: 2, endHour: 3 } })), Date.parse('2026-10-25T00:00:00Z'), 'first autumn occurrence');
  for (const locked of [null, {}, { date: '2026-02-30', startHour: 12, endHour: 14 }, { date: '2026-10-04', startHour: 14, endHour: 12 }, { date: '2026-10-04', startHour: 24, endHour: 25 }]) assert.equal(lockedStart(plan({ locked })), null);
});

test('confirmed means yes without hours, or legacy/full slots covering the fixed time, never maybe/no/pending/nonparticipants', () => {
  const full = ['2026-10-04-12', '2026-10-04-13'];
  const ev = plan({ participants: PEOPLE.slice(0, 5), rsvpStatus: { Alex: 'yes', Vane: 'maybe', Guille: 'no', Indar: 'pending', Nadia: 'yes' }, availability: { Vane: full, Guille: full, Indar: full, Raul: full, Nadia: full } });
  assert.deepEqual(confirmedParticipants(ev, PEOPLE).sort(), ['Alex', 'Raul']);
  ev.availability.Alex = ['2026-10-04-12'];
  assert.deepEqual(confirmedParticipants(ev, PEOPLE), ['Raul'], 'explicit yes with mismatched slots is excluded');
  ev.participants = [];
  assert.deepEqual(confirmedParticipants(ev, PEOPLE), []);
});

test('three reminder windows have limited catch-up and expire at their exact boundary', () => {
  for (const [key, lead, late] of [['before24h', 24 * H, 6 * H], ['before2h', 2 * H, 45 * M], ['start', 0, 15 * M]]) {
    const due = START - lead;
    assert.equal(duePlanReminders(plan(), due - 1).some(r => r.key === key), false);
    const r = duePlanReminders(plan(), due).find(r => r.key === key);
    assert.ok(r);
    assert.equal(r.startAt, START);
    assert.equal(r.dueAt, due);
    assert.equal(r.expiresAt, due + late);
    assert.ok(r.label);
    assert.equal(duePlanReminders(plan(), due + late).some(r => r.key === key), false);
  }
  assert.deepEqual(duePlanReminders(plan({ archived: true }), START), []);
  assert.deepEqual(duePlanReminders(plan({ locked: null }), START), []);
});

test('queued reminders must still refer to this start, confirmed recipient and unexpired active plan', () => {
  const notice = { kind: 'plan:reminder', reminderKey: 'before2h', eventId: 'e1', startAt: START, endHour: 14, expiresAt: START - 75 * M, to: 'Alex' };
  const now = START - 90 * M;
  assert.equal(reminderStillValid(notice, plan(), PEOPLE, now), true);
  for (const ev of [null, plan({ archived: true }), plan({ locked: null }), plan({ locked: { date: '2026-10-04', startHour: 13, endHour: 14 } }), plan({ rsvpStatus: { Alex: 'no' } }), plan({ participants: ['Vane'] })]) assert.equal(reminderStillValid(notice, ev, PEOPLE, now), false);
  assert.equal(reminderStillValid(notice, plan(), PEOPLE, notice.expiresAt), false);
  assert.equal(reminderStillValid(notice, plan({ locked: { date: '2026-10-04', startHour: 12, endHour: 15 } }), PEOPLE, now), false, 'changing only the end invalidates the queued block');
});

const json = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
function world(events, prefs, push = {}) {
  const fs = firestoreStand();
  Object.assign(fs.events, events);
  Object.assign(fs.config, { users: { list: PEOPLE }, preferences: { farmEnabled: false }, 'push-prefs': prefs,
    'push-state': { json: JSON.stringify({ logs: '2026-10-01T00:00:00Z', chat: '2026-10-01T00:00:00Z' }) } });
  const hits = [];
  return { fs, hits, async round(now, ignoreQuiet = true) {
    const real = globalThis.fetch, heard = [];
    globalThis.fetch = async (url, init = {}) => {
      if (String(url).startsWith('https://push.test/')) { hits.push({ url: String(url), ...init }); return { ok: true, status: 201 }; }
      if (init.method === 'PATCH') { fs.config['push-state'] = { json: JSON.parse(init.body).fields.json.stringValue }; return json({}); }
      const response = fs.handle(url, init);
      if (response) return response;
      if (init.method === 'POST' && String(url).includes(':runQuery')) return json([{ readTime: 'T' }]);
      throw new Error(`Unexpected mocked request ${url}`);
    };
    try { await run({ project: 'mi-gente-preprod', now, ignoreQuiet, vapidPublic: 'x', vapidPrivate: 'x', ...push, log: l => { if (l.startsWith('(no devices)')) heard.push(l); } }); }
    finally { globalThis.fetch = real; }
    return heard;
  }, state() { return JSON.parse(fs.config['push-state'].json); } };
}

test('normal rounds send due reminders, dedupe and allow a changed start; first run establishes a baseline', async () => {
  const w = world({ e1: plan() });
  const first = await w.round(START - 2 * H);
  assert.equal(first.length, 2);
  assert.deepEqual(await w.round(START - 2 * H + 5 * M), []);
  w.fs.events.e1.locked = { date: '2026-10-04', startHour: 13, endHour: 14 };
  assert.equal((await w.round(START - H)).length, 2);
  const old = world({ e1: plan() });
  delete old.fs.config['push-state'];
  assert.deepEqual(await old.round(START + H), []);
  const cold = world({ e1: plan() });
  delete cold.fs.config['push-state'];
  assert.deepEqual(await cold.round(START - 2 * H), [], 'first run does not announce preexisting due reminders');
  assert.deepEqual(await cold.round(START - 2 * H + 5 * M), [], 'the baseline also prevents catch-up next round');
});

test('unfixed plans and corrupt/nonconfirmed invitations are never scheduled', async () => {
  for (const ev of [plan({ locked: undefined }), plan({ participants: 'Alex' }), plan({ participants: ['Guille'] }), plan({ rsvpStatus: { Alex: 'maybe', Vane: 'maybe' }, availability: { Alex: ['2026-10-04-12', '2026-10-04-13'], Vane: ['2026-10-04-12', '2026-10-04-13'] } })]) {
    assert.deepEqual(confirmedParticipants(ev, PEOPLE), []);
    assert.deepEqual(await world({ e1: ev }).round(START - 2 * H), []);
  }
});

test('Discord switches and sent records cannot suppress scheduled push', async () => {
  const ev = plan({ discordOff: true, discordRemindersSent: { before24h: true, before2h: true, start: true } });
  assert.equal((await world({ e1: ev }).round(START - 2 * H)).length, 2);
});

test('a changed end hour has its own dedupe identity', async () => {
  const w = world({ e1: plan() });
  assert.equal((await w.round(START - 2 * H)).length, 2);
  w.fs.events.e1.locked.endHour = 15;
  assert.equal((await w.round(START - 2 * H + 5 * M)).length, 2);
  assert.deepEqual(await w.round(START - 2 * H + 10 * M), []);
});

test('actual Web Push encryption delivers only confirmed recipients with plan payload and window-limited TTL', async () => {
  const b64 = b => Buffer.from(b).toString('base64url');
  const vapid = createECDH('prime256v1'); vapid.generateKeys();
  const devices = Object.fromEntries(PEOPLE.map(name => {
    const key = createECDH('prime256v1'); key.generateKeys();
    const auth = randomBytes(16);
    return [name, { key, auth, endpoint: `https://push.test/${name}`, keys: { p256dh: b64(key.getPublicKey()), auth: b64(auth) } }];
  }));
  const w = world({ e1: plan() }, undefined, { vapidPublic: b64(vapid.getPublicKey()), vapidPrivate: b64(vapid.getPrivateKey()) });
  w.fs.config['push-subs'] = Object.fromEntries(Object.entries(devices).map(([name, d]) => [name, { d0: { endpoint: d.endpoint, keys: d.keys, at: 1 } }]));
  const now = START - 2 * H + 10 * M + 1234;
  await w.round(now);
  assert.deepEqual(w.hits.map(h => h.url).sort(), ['https://push.test/Alex', 'https://push.test/Vane']);
  for (const hit of w.hits) {
    const d = devices[hit.url.split('/').pop()];
    const payload = JSON.parse(ece.decrypt(Buffer.from(hit.body), { version: 'aes128gcm', privateKey: d.key, authSecret: b64(d.auth) }).toString('utf8'));
    assert.match(payload.title, /2 horas/);
    assert.match(payload.title, /Cena/);
    assert.match(payload.body, /2026-10-04.*12:00.*14:00/);
    assert.ok(payload.url.includes('e1'));
    assert.ok(payload.tag.includes('e1'));
    assert.equal(hit.headers.ttl, String(Math.floor((START - 75 * M - now) / 1000)));
    assert.equal(hit.headers['content-encoding'], 'aes128gcm');
  }
  const count = w.hits.length;
  await w.round(START - 75 * M);
  assert.equal(w.hits.length, count, 'no new push at the expiry boundary');
});

test('events queries only select fields and separately filter Madrid today/tomorrow, without scanning unrelated dates', async () => {
  const w = world({ e1: plan(), other: plan({ locked: { date: '2026-11-04', startHour: 12, endHour: 14 } }) });
  await w.round(START - 2 * H);
  const q = w.fs.queries.filter(q => q.from[0].collectionId === 'events');
  assert.equal(q.length, 2);
  assert.deepEqual(q.map(q => q.where.fieldFilter.value.stringValue).sort(), ['2026-10-04', '2026-10-05']);
  assert.ok(q.every(q => q.where.fieldFilter.field.fieldPath === 'locked.date' && q.select.fields.length > 0));
});

test('automatic reminders have their own preference and muted recipients do not receive them', async () => {
  assert.equal(categoryOf('plan:reminder'), 'recordatorios');
  assert.equal(wants({ Alex: { recordatorios: false } }, 'Alex', 'plan:reminder'), false);
  const w = world({ e1: plan() }, { Alex: { recordatorios: false }, Vane: { planes: false } });
  const heard = await w.round(START - 2 * H);
  assert.equal(heard.length, 1);
  assert.ok(heard[0].includes('Vane:'));
});

test('quiet queue drops expired, moved, unconfirmed and archived reminders before morning', async () => {
  for (const change of ['expired', 'moved', 'unconfirmed', 'archived', 'removed']) {
    // The 24h reminder at 05:00 is still valid at 09:00, so mutations test revalidation independently of expiry.
    const expired = change === 'expired';
    const ev = plan({ locked: { date: '2026-10-05', startHour: expired ? 0 : 5, endHour: expired ? 1 : 6 } });
    const w = world({ e1: ev });
    assert.deepEqual(await w.round(Date.parse(expired ? '2026-10-04T22:00:00Z' : '2026-10-04T03:00:00Z'), false), []);
    assert.ok(Object.values(w.state().queue).flat().some(n => n.kind === 'plan:reminder'));
    if (change === 'moved') ev.locked = { date: '2026-10-05', startHour: 12, endHour: 13 };
    if (change === 'unconfirmed') ev.rsvpStatus = { Alex: 'no', Vane: 'no' };
    if (change === 'archived') ev.archived = true;
    if (change === 'removed') delete w.fs.events.e1;
    assert.deepEqual(await w.round(Date.parse(expired ? '2026-10-05T07:00:00Z' : '2026-10-04T07:00:00Z'), false), [], change);
    assert.equal(Object.values(w.state().queue).flat().filter(n => n.kind === 'plan:reminder').length, 0);
  }
  const valid = world({ e1: plan({ locked: { date: '2026-10-05', startHour: 5, endHour: 6 } }) });
  await valid.round(Date.parse('2026-10-04T03:00:00Z'), false);
  assert.equal((await valid.round(Date.parse('2026-10-04T07:00:00Z'), false)).length, 2, 'unchanged 24h reminders survive quiet hours');
});
