// What a round reads from Firestore (billed per document: the free plan stops at 50,000 a day, and on Oct 3 2026 a
// round of about 95 reads, 288 times a day, was a big part of that; the stand-in in fakefs.mjs throws if a round lists
// config or presence again), and the notices that come from the documents it
// does read: pokes, gifts, the streak, bug reports. Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../core.mjs';
import { firestoreStand } from './fakefs.mjs';

const H = 3_600_000;
const NOON = Date.UTC(2026, 9, 3, 10, 0, 0);   // 12:00 in Madrid
const EVENING = Date.UTC(2026, 9, 3, 19, 0, 0); // 21:00 in Madrid (the streak notice starts at 20:00)
const PEOPLE = ['Alex', 'Vane', 'Guille', 'Indar', 'Raul', 'Nadia', 'Ines', 'Marc'];
const NOW_MINUS = hours => NOON - hours * H;
const json = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

const goat = (owner, over = {}) => ({ schemaVersion: 1, id: `id-${owner}`, owner, name: `Cabra de ${owner}`, personality: 'curiosa', needs: { food: 80, mood: 80, energy: 80 },
  restedAt: NOON - 60_000, asleep: false, xp: 10, leaves: 5, treats: 0, boxes: [], inventory: [], clean: true, createdAt: 1, look: { coat: 1, spots: 1, horns: 1, eyes: 1, head: null, neck: null },
  lastCare: {}, lastActionIds: [], openedBoxes: {}, ...over });

/** A farm of `PEOPLE.length` goats, plus whatever `extra` config documents there are. */
function farm(extra = {}) {
  return {
    users: { list: PEOPLE }, roles: { admins: ['Alex'] }, preferences: { farmEnabled: true, farmOpen: true },
    'push-state': { json: JSON.stringify({ logs: new Date(NOON - 60_000).toISOString(), chat: new Date(NOON - 60_000).toISOString() }) },
    'push-subs': {}, farm: { schemaVersion: 1, owners: {} },
    ...Object.fromEntries(PEOPLE.map(p => [`goat-id-${p}`, goat(p)])),
    ...extra,
  };
}

/** One round against the stand-in; push-state is written back into it, so rounds can be chained. */
async function round(fs, now) {
  const lines = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (init.method === 'PATCH') {
      const [path] = url.split('/config/')[1].split('?');
      if (path === 'push-state') fs.config['push-state'] = { json: JSON.parse(init.body).fields.json.stringValue };
      return json({});
    }
    const answered = fs.handle(url, init);
    if (answered) return answered;
    if (init.method === 'POST') { fs.logsAndChat = (fs.logsAndChat || 0) + 1; return json([{ readTime: 'T' }]); } // the plans' log and the chat: nothing new, one read each
    throw new Error(`unexpected ${url}`);
  };
  try { await run({ project: 'mi-gente-preprod', now, ignoreQuiet: true, vapidPublic: 'x', vapidPrivate: 'x', log: l => lines.push(l) }); } finally { globalThis.fetch = real; }
  return lines.filter(l => l.startsWith('(no devices)')).map(l => l.replace('(no devices) ', ''));
}
const stand = (config, presence = {}) => { const fs = firestoreStand(); Object.assign(fs.config, config); Object.assign(fs.presence, presence); return fs; };

// ---------- how many reads ----------

test('a typical round: 8 goats, 2 fresh bug reports, 1 gift, 60 other config documents, 12 people: far fewer reads than listing config', async () => {
  const other = {};
  for (let i = 0; i < 8; i++) other[`bugshot-${NOON - (30 + i) * H}-aaaa${String(i).padStart(2, '0')}`] = { shot: 'x'.repeat(50) }; // screenshots
  for (let i = 0; i < 12; i++) other[`farm-social-a${i}_b${i}`] = { schemaVersion: 1, a: `a${i}`, b: `b${i}`, affection: i };
  for (let i = 0; i < 10; i++) other[`farm-race-r${i}`] = { schemaVersion: 1, status: 'done', entries: {} };
  for (let i = 0; i < 8; i++) other[`bug-${NOON - (50 + i) * H}-old${String(i).padStart(3, '0')}`] = { kind: 'bug', by: 'Vane', text: 'viejo', at: NOW_MINUS(50 + i), resolved: i % 2 === 0 };
  for (let i = 0; i < 6; i++) other[`farm-costume-gift-s${i}-r${i}`] = { schemaVersion: 1, fromGoatId: `s${i}`, toGoatId: `r${i}`, status: i % 2 ? 'accepted' : 'declined', offeredAt: 1 };
  for (let i = 0; i < 4; i++) other[`farm-pairtrip-p${i}`] = { schemaVersion: 1, status: 'completed', a: 'x', b: 'y' };
  for (const id of ['colors', 'avatars', 'series', 'admin-keys', 'admin-recovery', 'farm-rig', 'farm-beams', 'farm-reveal', 'farm-rarities', 'farm-live', 'farm-codes', 'farm-projects']) other[id] = { x: 1 };
  assert.equal(Object.keys(other).length, 60);
  const config = farm({
    ...other,
    [`bug-${NOON - 600_000}-abcdef`]: { kind: 'bug', by: 'Vane', text: 'La granja no carga', at: NOON - 600_000, resolved: false, thumb: 'x'.repeat(2000) },
    [`bug-${NOON - 300_000}-ghijkl`]: { kind: 'bug', by: 'Guille', text: 'Se ve mal', at: NOON - 300_000, resolved: false },
    'farm-costume-gift-id-Vane-id-Guille': { schemaVersion: 1, fromGoatId: 'id-Vane', toGoatId: 'id-Guille', status: 'pending', offeredAt: NOON - 120_000, itemId: 'hat', price: 0 },
  });
  const presence = Object.fromEntries([...PEOPLE, 'Vicente', 'Lucia', 'Ana', 'Pablo'].map(p => [p, { lastSeen: 1, poke: { from: 'x' } }]));
  presence.Indar = { lastSeen: 1, missed: { Raul: 2 } };
  const fs = stand(config, presence);
  const heard = await round(fs, NOON);

  // what it did: the pending gift, both bug reports (to the one admin, who sent neither) and the poke
  assert.deepEqual(heard.sort(), [
    'Alex: 🐞 Nuevo fallo de Guille', 'Alex: 🐞 Nuevo fallo de Vane',
    'Guille: 🎁 Vane te ha mandado un regalo', 'Indar: 👉 Raul te ha dado un toque',
  ].sort());

  // what it read: 6 named documents, push-subs, push-prefs (absent: still a read), 1 presence document, 2 bug reports, 8 goats, 1 gift
  assert.equal(fs.reads, 6 + 2 + 1 + 2 + 8 + 1 + 2);
  const total = fs.reads + fs.logsAndChat; // and the activity log and the chat, one read each when there is nothing new
  // before: every config document (the 60, the 8 goats, 2 bug reports, 1 gift, and users, roles, preferences, push-state, farm, push-subs), every presence
  // document, push-subs and push-prefs once more, and the log and the chat
  const before = Object.keys(config).length + Object.keys(presence).length + 2 + 2;
  assert.ok(total <= 26, `${total} reads a round`);
  assert.ok(total * 3 < before, `${total} is not far below ${before}`);
  console.log(`reads per round: ${total} now, ${before} before`);
});

test('with the farm switched off, the goats and the gifts are not read at all', async () => {
  const fs = stand(farm({ preferences: { farmEnabled: false } }));
  await round(fs, NOON);
  assert.equal(fs.reads, 6 + 2 + 1 + 1 + 2); // named docs, push prefs, empty presence/bugs and today's/tomorrow's plans
});

// ---------- what comes out of the documents it does read ----------

test('pokes: told once, and again after the person came in and saw them (the field is gone from presence)', async () => {
  const fs = stand(farm(), { Indar: { missed: { Raul: 1 } } });
  assert.deepEqual(await round(fs, NOON), ['Indar: 👉 Raul te ha dado un toque']);
  assert.deepEqual(await round(fs, NOON + 5 * 60_000), [], 'not twice');
  fs.presence.Indar = { lastSeen: 2 };              // he came in: the app deletes `missed`
  assert.deepEqual(await round(fs, NOON + 10 * 60_000), []);
  fs.presence.Indar = { missed: { Raul: 1 } };      // and Raul pokes again
  assert.deepEqual(await round(fs, NOON + 15 * 60_000), ['Indar: 👉 Raul te ha dado un toque'], 'the count started over');
  fs.presence.Indar = { missed: { Raul: 2 } };
  assert.deepEqual(await round(fs, NOON + 20 * 60_000), ['Indar: 👉 Raul te ha dado un toque'], 'a bigger count is a new poke');
});

test('gifts: only a pending one to a goat that plays is told, once; an accepted one is not even read', async () => {
  const gift = (status, over = {}) => ({ schemaVersion: 1, fromGoatId: 'id-Vane', toGoatId: 'id-Guille', status, offeredAt: NOON - 60_000, itemId: 'hat', price: 0, ...over });
  const fs = stand(farm({ 'farm-costume-gift-id-Vane-id-Guille': gift('pending'), 'farm-costume-gift-id-Vane-id-Indar': gift('accepted', { toGoatId: 'id-Indar' }) }));
  assert.deepEqual(await round(fs, NOON), ['Guille: 🎁 Vane te ha mandado un regalo']);
  assert.equal(fs.reads, 6 + 2 + 1 + 1 + 8 + 1 + 2, 'one gift read, not two');
  assert.deepEqual(await round(fs, NOON + 5 * 60_000), [], 'told once');
});

test('the streak at stake: from 20:00, a run of three days that today has not counted', async () => {
  const yesterday = '2026-10-02';
  const fs = stand(farm({ 'goat-id-Vane': goat('Vane', { streak: { count: 4, day: yesterday } }), 'goat-id-Guille': goat('Guille', { streak: { count: 2, day: yesterday } }) }));
  assert.deepEqual(await round(fs, NOON), [], 'not before 20:00');
  const later = await round(fs, EVENING);
  assert.deepEqual(later, ['Vane: ☀️ Racha de 4 días']);
});

test('a goat back from a trip, and a box waiting an hour', async () => {
  const fs = stand(farm({ 'goat-id-Vane': goat('Vane', { soloTrip: { id: 't1', startedAt: NOON - 3 * H, durationMs: H, collected: false } }), 'goat-id-Guille': goat('Guille', { boxes: ['b1'] }) }));
  assert.deepEqual(await round(fs, NOON), ['Vane: 🧭 Cabra de Vane ha vuelto de la excursión']);
  assert.deepEqual(await round(fs, NOON + 61 * 60_000), ['Guille: 📦 Cabra de Guille tiene una caja sin abrir']);
});

test('bug reports: an old or resolved one is not read, a fresh open one tells the admins once', async () => {
  const bug = (hoursAgo, over = {}) => ({ kind: 'bug', by: 'Vane', text: 'roto', at: NOON - hoursAgo * H, resolved: false, ...over });
  const fs = stand(farm({ [`bug-${NOON - H}-fresh1`]: bug(1), [`bug-${NOON - 30 * H}-older1`]: bug(30), [`bug-${NOON - 2 * H}-closed`]: bug(2, { resolved: true }) }));
  assert.deepEqual(await round(fs, NOON), ['Alex: 🐞 Nuevo fallo de Vane']);
  assert.deepEqual(await round(fs, NOON + 5 * 60_000), []);
});
