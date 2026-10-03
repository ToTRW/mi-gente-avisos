// Mi Gente's notifications: reads the app's Firestore (the plans' activity log, the chat, missed pokes and the goat
// farm), works out who should hear about what, and sends Web Push notifications to the devices people switched them on
// for (config/push-subs). What it has already said lives in config/push-state, so nothing is sent twice. Nothing
// between 23:00 and 9:00 in Madrid: those wait for the morning, and many at once become one.
//
// Plain fetch and WebCrypto only, so the same run() works in Node (send.mjs) and in the Cloudflare Worker (worker.mjs).
import { sendPush } from './webpush.mjs';
import { wants } from './prefs.mjs';

const APPS = { 'mi-gente-quedadas': 'https://mi-gente-quedadas.web.app', 'mi-gente-preprod': 'https://mi-gente-preprod.web.app' };
const HOUR = 3_600_000;
const MAX_PUSHES = 6;
// the app whose releases everyone hears about (preprod deploys all day: nobody wants a notice for each)
const RELEASE_PROJECT = 'mi-gente-quedadas';

// ---------- Firestore over REST (the app's rules let it read and write config without signing in) ----------

const value = v => v == null ? undefined
  : 'stringValue' in v ? v.stringValue
  : 'integerValue' in v ? Number(v.integerValue)
  : 'doubleValue' in v ? v.doubleValue
  : 'booleanValue' in v ? v.booleanValue
  : 'nullValue' in v ? null
  : 'timestampValue' in v ? Date.parse(v.timestampValue)
  : 'mapValue' in v ? fields(v.mapValue.fields)
  : 'arrayValue' in v ? (v.arrayValue.values || []).map(value)
  : undefined;
const fields = f => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, value(v)]));
// the document's own id is `_doc` (a goat has an `id` field of its own)
// (and `_updateTime`, so a write can say "only if nobody changed it since I read it")
const docOf = d => ({ ...fields(d.fields), _doc: d.name.split('/').pop(), _updateTime: d.updateTime });
const quote = s => /^[A-Za-z_][A-Za-z_0-9]*$/.test(s) ? s : '`' + s.replace(/[`\\]/g, m => '\\' + m) + '`';

/** Only these fields come back (the Worker's free plan counts every millisecond spent reading what it doesn't use). */
const maskQuery = (fields, sep) => fields.length ? sep + fields.map(f => `mask.fieldPaths=${encodeURIComponent(f)}`).join('&') : '';
// what each round reads from config (one mask for the whole collection: a document keeps the fields it has of these)
const CONFIG_FIELDS = ['list', 'admins', 'farmEnabled', 'farmOpen', 'json', 'id', 'from', 'to', 'name', 'blurb',
  'owner', 'soloTrip', 'needs', 'restedAt', 'personality', 'boxes', 'streak', 'status', 'toGoatId', 'fromGoatId', 'offeredAt',
  // «Reportar un fallo» (config/bug-*): never `thumb`, the little picture
  'kind', 'by', 'text', 'at', 'resolved',
  // «Probar avisos» (config/push-test): only whether it is done; the results are written, never read
  'doneAt'];

function firestore(base, dry) {
  return {
    async get(path, mask = []) {
      const r = await fetch(`${base}/${path}${maskQuery(mask, '?')}`);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`GET ${path}: ${r.status} ${await r.text()}`);
      return docOf(await r.json());
    },
    async list(collection, mask = []) {
      const out = [];
      let token = '';
      do {
        const r = await fetch(`${base}/${collection}?pageSize=300${token ? `&pageToken=${token}` : ''}${maskQuery(mask, '&')}`);
        if (!r.ok) throw new Error(`list ${collection}: ${r.status}`);
        const j = await r.json();
        out.push(...(j.documents || []).map(docOf));
        token = j.nextPageToken || '';
      } while (token);
      return out;
    },
    /**
     * Documents of a collection whose `field` (a timestamp) is after `cursor`, oldest first. The cursor is Firestore's
     * own timestamp string: it keeps microseconds, which a JS number would round away (and the last one would come
     * back every run). Each document carries its own as `_at`.
     */
    async since(collection, field, cursor, select = []) {
      const r = await fetch(`${base}:runQuery`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ structuredQuery: {
        ...(select.length ? { select: { fields: [field, ...select].map(fieldPath => ({ fieldPath })) } } : {}),
        from: [{ collectionId: collection }],
        where: { fieldFilter: { field: { fieldPath: field }, op: 'GREATER_THAN', value: { timestampValue: cursor } } },
        orderBy: [{ field: { fieldPath: field }, direction: 'ASCENDING' }], limit: 300 } }) });
      if (!r.ok) throw new Error(`query ${collection}: ${r.status} ${await r.text()}`);
      return (await r.json()).filter(x => x.document).map(x => ({ ...docOf(x.document), _at: x.document.fields?.[field]?.timestampValue }));
    },
    /**
     * Writes the named fields of config/<id> (a field left out of `data` is deleted). With `updateTime` (a document's
     * `_updateTime`) it only writes if the document has not changed since: otherwise it throws FAILED_PRECONDITION.
     */
    async patch(id, data, paths, updateTime = '') {
      if (dry) return;
      const encode = v => typeof v === 'string' ? { stringValue: v }
        : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v })
        : typeof v === 'boolean' ? { booleanValue: v }
        : Array.isArray(v) ? { arrayValue: { values: v.map(encode) } }
        : v && typeof v === 'object' ? { mapValue: { fields: Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, encode(x)])) } }
        : { nullValue: null };
      const body = { fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, encode(v)])) };
      const mask = paths.map(p => `updateMask.fieldPaths=${encodeURIComponent(p.map(quote).join('.'))}`).join('&')
        + (updateTime ? `&currentDocument.updateTime=${encodeURIComponent(updateTime)}` : '');
      const r = await fetch(`${base}/config/${id}?${mask}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`patch ${id}: ${r.status} ${await r.text()}`);
    },
  };
}

// ---------- Madrid time ----------

// By hand rather than with Intl (time zones were most of the Worker's CPU): Madrid is UTC+1, and UTC+2 from the last
// Sunday of March to the last Sunday of October, changing at 01:00 UTC both times (the EU rule).
const lastSunday = (year, month) => { const end = Date.UTC(year, month + 1, 0); return end - new Date(end).getUTCDay() * 86_400_000; };
export function madridOffset(t) {
  const year = new Date(t).getUTCFullYear();
  return t >= lastSunday(year, 2) + 3_600_000 && t < lastSunday(year, 9) + 3_600_000 ? 2 : 1;
}
const madrid = t => new Date(t + madridOffset(t) * 3_600_000); // read with the getUTC* methods
export const madridDay = t => madrid(t).toISOString().slice(0, 10);
export const madridHour = t => madrid(t).getUTCHours();

// ---------- The goat farm (mirrors src/lib/goats/model.ts in the app) ----------

const clamp = n => Math.max(0, Math.min(100, n));
const foodDecay = goat => goat.personality === 'comilona' ? 4 : 3;
function needsAt(goat, now) {
  const hours = Math.max(0, now - (goat.restedAt || now)) / HOUR;
  const n = goat.needs || {};
  return { food: Math.max(20, clamp((n.food ?? 75) - foodDecay(goat) * hours)), mood: Math.max(20, clamp((n.mood ?? 75) - 2 * hours)) };
}
const LOW = 30, BACK = 50; // a need at 30 or less is worth a word; it has to be back over 50 before it can be said again

// ---------- Bug reports («Reportar un fallo»: config/bug-<ms>-<random>) ----------

const BUG_ID = /^bug-\d{10,}-[0-9a-z]{6}$/;
const BUG_FRESH = 24 * HOUR; // an older one is not news (and the first round after this shipped must not announce the backlog)

/** The first words of a report, on one line, cut at a word. */
export function bugSnippet(text, max = 80) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max), space = cut.lastIndexOf(' ');
  return (space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, '') + '…';
}

/** The reports sent in the last day that are still open: [{ id, by, text }], oldest first. */
export function freshBugReports(config, now) {
  return config
    .filter(d => BUG_ID.test(d._doc) && d.kind === 'bug' && d.resolved !== true && typeof d.at === 'number' && now - d.at < BUG_FRESH)
    .sort((a, b) => a.at - b.at)
    .map(d => ({ id: d._doc, by: d.by || 'Alguien', text: d.text }));
}

// ---------- «Probar avisos» (Admin: config/push-test) ----------
// An admin picks people in the app, which writes { id, to: [names], text, by, at } to config/push-test. The next round
// sends each of them a test notification right away (quiet hours and batching don't apply) and writes back
// `results` ({ [name]: { devices, sent, failed, expired?, error?, unknown? } }) and `doneAt`, which the app shows. The
// results only ever hold counts and a short reason: never an endpoint, a key or the push service's own reply.

const TEST_FRESH = 30 * 60_000; // an older request is not sent (the app says it never left)
const TEST_MAX_PEOPLE = 8;
const TEST_TEXT_MAX = 140;

/** The request waiting in config/push-test, cleaned: { id, to, text, updateTime }; null when there is none (or it is done, old, or not an admin's). */
export function pendingPushTest(d, admins, now) {
  if (!d || typeof d.id !== 'string' || !d.id || d.doneAt || !Array.isArray(d.to)) return null;
  if (typeof d.at !== 'number' || now - d.at > TEST_FRESH) return null;
  if (!admins.includes(d.by)) return null; // the app only lets admins ask; so does the Worker
  const to = [...new Set(d.to.filter(n => typeof n === 'string' && n))].slice(0, TEST_MAX_PEOPLE);
  if (!to.length) return null;
  const text = typeof d.text === 'string' ? d.text.replace(/\s+/g, ' ').trim().slice(0, TEST_TEXT_MAX) : '';
  return { id: d.id, to, text: text || 'Prueba de avisos', updateTime: d._updateTime || '' };
}

// ---------- App updates (the live app's /version.json) ----------

/** The version the live app says it is (version.json: { version, sha, builtAt, mode }), or '' when it can't be read: a failure is never an error. */
export async function fetchAppVersion(app, now) {
  try {
    const r = await fetch(`${app}/version.json?t=${now}`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return '';
    const v = (await r.json())?.version;
    return typeof v === 'string' && /^[\w.+-]{1,40}$/.test(v) ? v : ''; // short and plain: it goes into a notification
  } catch { return ''; }
}

/**
 * One round for one Firebase project.
 *   project        mi-gente-quedadas or mi-gente-preprod
 *   vapidPublic    the public key (also in the app, src/data/push.ts)
 *   vapidPrivate   the private key (a secret)
 *   dry            print what would be sent, send and save nothing
 *   firestoreBase  another documents URL (the local emulator), for testing
 *   ignoreQuiet    send even in quiet hours (testing)
 *   now            pretend it's then (testing)
 *   testTo         also send that person a test notification right now, quiet hours or not
 *   testOnly       only that test notification: no round, nothing saved (so it never races the Worker)
 *   log            where the summary and errors go
 * Resolves to the one-line summary.
 */
export async function run({ project = 'mi-gente-quedadas', vapidPublic = '', vapidPrivate = '', dry = false, firestoreBase = '', ignoreQuiet = false, now = Date.now(), testTo = '', testOnly = false, log = console.log }) {
  // without the keys nothing can be sent: stop before the round empties the morning queue for nothing
  if (!dry && (!vapidPublic || !vapidPrivate)) throw new Error('VAPID keys missing: nothing sent, nothing saved');
  const NOW = now;
  const db = firestore(firestoreBase || `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`, dry);
  const APP = APPS[project] || APPS['mi-gente-quedadas'];
  const QUIET = !ignoreQuiet && (h => h >= 23 || h < 9)(madridHour(NOW));

  if (testOnly) {
    const subs = (await db.get('config/push-subs')) || {};
    const devices = Object.entries(subs[testTo] || {});
    const payload = JSON.stringify({ title: '🐐 Prueba de avisos', body: 'Si ves esto, los avisos de Mi Gente llegan a este dispositivo.', url: '/', tag: 'test' });
    const results = [];
    for (const [id, sub] of devices) {
      if (dry) { results.push(`${id}: dry`); continue; }
      const r = await sendPush({ endpoint: sub.endpoint, keys: sub.keys }, payload, { subject: APP, publicKey: vapidPublic, privateKey: vapidPrivate });
      results.push(`${id}: ${r.status}${r.text ? ' ' + r.text : ''}`);
    }
    const summary = `${project}: test to ${testTo || '(nobody)'}: ${devices.length ? results.join(', ') : 'no devices'}`;
    log(summary);
    return summary;
  }

  // push-subs on its own: its fields are people's names, which a mask can't list
  // push-prefs too: who switched which categories off (see prefs.mjs)
  const [config, presence, pushSubs, pushPrefs, appVersion] = await Promise.all([db.list('config', CONFIG_FIELDS), db.list('presence', ['missed']), db.get('config/push-subs'), db.get('config/push-prefs'),
    project === RELEASE_PROJECT ? fetchAppVersion(APP, NOW) : '']);
  const byId = Object.fromEntries(config.map(d => [d._doc, d]));
  const friends = byId.users?.list || [];
  const admins = byId.roles?.admins || ['Alex'];
  const prefs = byId.preferences || {};
  const { _doc, _updateTime, ...subs } = pushSubs || {};
  const { _doc: _prefsDoc, _updateTime: _prefsTime, ...prefsOf } = pushPrefs || {};
  let state = {};
  try { state = JSON.parse(byId['push-state']?.json || '{}'); } catch { state = {}; }
  const first = typeof state.logs !== 'string';
  if (first) state.logs = state.chat = new Date(NOW).toISOString(); state.sent ??= {}; state.low ??= {}; state.boxSeen ??= {}; state.missed ??= {}; state.queue ??= {};

  // «Probar avisos»: a request from an admin, to be sent to exactly the people it names
  const test = pendingPushTest(byId['push-test'], admins, NOW);
  const testDevices = test ? test.to.reduce((n, p) => n + (friends.includes(p) ? Object.keys(subs[p] || {}).length : 0), 0) : 0;

  /** { to, title, body, url, tag, kind } */
  const out = [];
  const say = (to, title, body, url = '/', tag, kind) => { if (to && friends.includes(to)) out.push({ to, title, body, url, tag, kind }); };
  const once = (key, fn) => { if (state.sent[key]) return; state.sent[key] = NOW; fn(); };

  // a new version of the app with something new in it: everyone with avisos on hears it once (a newer notice replaces an older one, also in the morning queue).
  // The first time there is no version on record: it is only written down.
  if (appVersion) {
    const known = state.appVersion;
    state.appVersion = appVersion;
    // a patch (3.20.1 > 3.20.2) is fixes only and goes out quietly; new things (3.21.0, 4.0.0) are announced
    const minor = v => String(v).split('.').slice(0, 2).join('.');
    if (known && minor(known) !== minor(appVersion)) once(`app:${appVersion}`, () => {
      for (const q of Object.values(state.queue)) for (let i = q.length - 1; i >= 0; i--) if (q[i].tag === 'app-update') q.splice(i, 1);
      Object.keys(subs).filter(p => Object.keys(subs[p] || {}).length).forEach(p => say(p, '✨ Mi Gente se ha actualizado', `Versión ${appVersion}: toca para ver las novedades`, '/?novedades', 'app-update', 'app-update'));
    });
  }

  // plans: from the activity log
  const logs = await db.since('activityLogs', 'at', state.logs, ['action', 'actor', 'eventId', 'eventName', 'range', 'datesChanged', 'names', 'until', 'reason']);
  const events = {};
  const eventOf = async id => id ? (events[id] ??= await db.get(`events/${id}`, ['participants', 'name', 'availability', 'rsvpStatus']).catch(() => null)) : null;
  // someone who answered «no» is still on the list, but the plan isn't theirs any more (the app's isMyPlan says the same)
  const saidNo = (ev, p) => {
    const rsvp = ev?.rsvpStatus || {}, avail = ev?.availability || {};
    if (Object.hasOwn(rsvp, p)) return rsvp[p] === 'no';
    return Object.hasOwn(avail, p) && Array.isArray(avail[p]) && avail[p].length === 0;
  };
  for (const entry of logs) {
    if (entry._at) state.logs = entry._at;
    const ev = await eventOf(entry.eventId);
    const who = entry.actor || 'Alguien', name = entry.eventName || ev?.name || 'un plan';
    const people = (ev?.participants ?? friends).filter(p => p !== who);
    // the time fixed and «llega tarde» only matter to whoever is still going; new dates (or a postponed plan) ask everyone again
    const going = people.filter(p => !saidNo(ev, p));
    const url = entry.eventId ? `/?evento=${encodeURIComponent(entry.eventId)}` : '/';
    if (entry.action === 'event:create') people.forEach(p => say(p, `📅 ${who} ha creado un plan`, name, url, `plan-${entry.eventId}`, 'plan:create'));
    if (entry.action === 'event:lock') going.forEach(p => say(p, `🔒 Hora fijada`, `${name}${entry.range ? ` · ${entry.range}` : ''}`, url, `plan-${entry.eventId}`, 'plan:lock'));
    if (entry.action === 'event:postpone') people.forEach(p => say(p, `⏩ ${who} ha aplazado un plan`, `${name}: vuelve a marcar tus horas`, url, `plan-${entry.eventId}`, 'plan:postpone'));
    if (entry.action === 'event:edit' && entry.datesChanged) people.forEach(p => say(p, `✏️ ${who} ha cambiado las fechas`, name, url, `plan-${entry.eventId}`, 'plan:dates'));
    if (entry.action === 'event:nudge') (entry.names || []).filter(p => p !== who).forEach(p => say(p, `📢 ${who} te recuerda un plan`, `Falta tu respuesta: ${name}`, url, `plan-${entry.eventId}`, 'plan:nudge'));
    if (entry.action === 'event:nudge-maybe') (entry.names || []).filter(p => p !== who).forEach(p => say(p, `❔ ${who} pide que confirmes`, `¿Vas o no? ${name}`, url, `plan-${entry.eventId}`, 'plan:nudge-maybe'));
    if (entry.action === 'late:set') going.forEach(p => say(p, `🕘 ${who} llega tarde`, `A las ${entry.until}${entry.reason ? ` · ${entry.reason}` : ''}: ${name}`, url, `late-${entry.eventId}-${who}`, 'late'));
  }

  // the chat: one notification per person for however many messages came in
  const messages = await db.since('messages', 'ts', state.chat, ['name', 'text']);
  if (messages.length) {
    state.chat = messages[messages.length - 1]._at || state.chat;
    for (const person of friends) {
      const theirs = messages.filter(m => m.name !== person);
      if (!theirs.length) continue;
      const last = theirs[theirs.length - 1];
      say(person, theirs.length === 1 ? `💬 ${last.name}` : `💬 ${theirs.length} mensajes en el chat`,
        theirs.length === 1 ? last.text : `${last.name}: ${last.text}`, '/?grupo', 'chat', 'chat');
    }
  }

  // pokes that arrived while they were away (presence/<name>.missed = { from: count })
  for (const p of presence) {
    const missed = p.missed || {}, seen = state.missed[p._doc] || {};
    for (const [from, n] of Object.entries(missed)) if (n > (seen[from] || 0)) say(p._doc, `👉 ${from} te ha dado un toque`, 'Entra a ver qué quiere', '/', `poke-${from}`, 'poke');
    state.missed[p._doc] = missed;
  }

  // a new bug report: every admin but the one who sent it
  for (const r of freshBugReports(config, NOW))
    once(`bug:${r.id}`, () => admins.filter(a => a !== r.by).forEach(a => say(a, `🐞 Nuevo fallo de ${r.by}`, bugSnippet(r.text) || 'Mira el informe en Admin', '/?admin', `bug-${r.id}`, 'bug')));

  // the farm, for whoever can play it
  if (prefs.farmEnabled) {
    const plays = person => prefs.farmOpen === true || admins.includes(person);
    const goats = config.filter(d => d._doc.startsWith('goat-'));
    const goatById = Object.fromEntries(goats.map(g => [g._doc.slice(5), g]));
    for (const goat of goats) {
      const owner = goat.owner, gid = goat._doc.slice(5);
      if (!plays(owner)) continue;
      const url = `/?cabrita=${encodeURIComponent(gid)}`;
      // back from a trip, with things to pick up
      const trip = goat.soloTrip;
      if (trip && !trip.collected && trip.startedAt + trip.durationMs <= NOW)
        once(`trip:${trip.id}`, () => say(owner, `🧭 ${goat.name} ha vuelto de la excursión`, 'Trae cosas para recoger', url, `trip-${gid}`, 'farm:trip'));
      // hungry or sad: once each time it drops, again only after it's been looked after
      const n = needsAt(goat, NOW), low = state.low[gid] ||= {};
      for (const [need, title] of [['food', `🌾 ${goat.name} tiene hambre`], ['mood', `💔 ${goat.name} está triste`]]) {
        if (n[need] <= LOW && !low[need]) { low[need] = true; say(owner, title, need === 'food' ? 'Pásate a darle de comer' : 'Pásate a hacerle caso', url, `need-${gid}`, 'farm:need'); }
        if (n[need] >= BACK) low[need] = false;
      }
      // a box waiting for an hour
      if ((goat.boxes || []).length) {
        const seen = state.boxSeen[gid] ||= NOW;
        if (NOW - seen >= HOUR) once(`box:${gid}:${seen}`, () => say(owner, `📦 ${goat.name} tiene una caja sin abrir`, '¿Qué habrá dentro?', url, `box-${gid}`, 'farm:box'));
      } else delete state.boxSeen[gid];
    }
    // gifts waiting to be accepted
    for (const gift of config.filter(d => d._doc.startsWith('farm-costume-gift-') && d.status === 'pending')) {
      const to = goatById[gift.toGoatId], from = goatById[gift.fromGoatId];
      if (!to || !plays(to.owner)) continue;
      once(`gift:${gift._doc}:${gift.offeredAt}`, () => say(to.owner, `🎁 ${from?.owner || 'Alguien'} te ha mandado un regalo`, `Para ${to.name}: ábrelo en su parcela`, `/?cabrita=${encodeURIComponent(gift.toGoatId)}`, `gift-${gift.toGoatId}`, 'farm:gift'));
    }
  }

  // a farm event: when it starts, and on its last day (everyone who plays)
  const ev = byId['farm-event'];
  if (prefs.farmEnabled && ev?.id && ev.from <= NOW && NOW < ev.to) {
    const name = ev.name || 'Evento en la granja', players = friends.filter(p => prefs.farmOpen === true || admins.includes(p));
    once(`event:${ev.id}:${ev.from}`, () => players.forEach(p => say(p, `🎉 Empieza: ${name}`, ev.blurb || 'Pásate por la granja.', '/?granja', 'event', 'farm:event')));
    if (ev.to - NOW < 24 * HOUR) once(`event-last:${ev.id}:${ev.from}`, () => players.forEach(p => say(p, `⏳ Último día: ${name}`, ev.blurb || 'Mañana se acaba.', '/?granja', 'event', 'farm:event')));
  }

  // a streak at stake: from 20:00, a run of three days or more that today's care hasn't counted yet
  if (prefs.farmEnabled && madridHour(NOW) >= 20) {
    const today = madridDay(NOW), yesterday = madridDay(NOW - 24 * HOUR);
    for (const goat of config.filter(d => d._doc.startsWith('goat-'))) {
      const s = goat.streak;
      if (!s || s.count < 3 || s.day !== yesterday) continue;
      once(`streak:${goat._doc}:${today}`, () => say(goat.owner, `☀️ Racha de ${s.count} días`, `Cuida hoy a ${goat.name} para no perderla`, `/?cabrita=${encodeURIComponent(goat._doc.slice(5))}`, 'streak', 'farm:streak'));
    }
  }

  // forget what's long gone
  for (const [k, t] of Object.entries(state.sent)) if (NOW - t > 14 * 24 * HOUR) delete state.sent[k];

  // the first run only sets the starting point: no history gets sent
  if (first) out.length = 0;

  // quiet hours: keep them for the morning
  for (const o of out) (state.queue[o.to] ||= []).push(o);
  // whatever a person switched off (config/push-prefs) is dropped here, whether it is new or has been waiting: the
  // choice of the moment it goes out is the one that counts. The test notices never come through here.
  let muted = 0;
  for (const k of Object.keys(state.queue)) {
    const wanted = state.queue[k].filter(o => wants(prefsOf, k, o.kind));
    muted += state.queue[k].length - wanted.length;
    state.queue[k] = wanted.slice(-30);
  }
  const sends = [];
  if (!QUIET) {
    // a round sends at most MAX_PUSHES (each one is encryption the Worker's CPU limit counts); whoever doesn't fit
    // keeps their queue for the next round, five minutes later (the first person always fits)
    let budget = Math.max(0, MAX_PUSHES - testDevices); // the test's pushes use the round's CPU too
    for (const [person, items] of Object.entries(state.queue)) {
      if (!items.length) continue;
      // several for one person become one
      const batch = items.length > 3
        ? [{ to: person, title: `Mi Gente: ${items.length} novedades`, body: items.slice(-3).map(i => i.title.replace(/^\S+\s/, '')).join(' · '), url: '/', tag: 'digest' }]
        : items;
      const cost = batch.length * Object.keys(subs[person] || {}).length;
      if (sends.length && cost > budget) continue;
      budget -= cost;
      sends.push(...batch);
      state.queue[person] = [];
    }
  }

  if (testTo) sends.push({ to: testTo, title: '🐐 Prueba de avisos', body: 'Si ves esto, los avisos de Mi Gente llegan a este dispositivo.', url: '/', tag: 'test' });

  // send
  const gone = [];
  let delivered = 0;
  // the test first: each named person's devices, whatever the hour
  const results = {};
  if (test) {
    const payload = JSON.stringify({ title: '🔔 Mi Gente · prueba', body: test.text, url: '/', tag: 'test' });
    for (const person of test.to) {
      if (!friends.includes(person)) { results[person] = { devices: 0, sent: 0, failed: 0, unknown: true }; continue; }
      const devices = Object.entries(subs[person] || {});
      const r = results[person] = { devices: devices.length, sent: 0, failed: 0 };
      for (const [id, sub] of devices) {
        if (dry) { log(`[dry] test ${person} (${id}): ${test.text}`); continue; }
        try {
          const res = await sendPush({ endpoint: sub.endpoint, keys: sub.keys }, payload, { subject: APP, publicKey: vapidPublic, privateKey: vapidPrivate });
          if (res.status >= 200 && res.status < 300) r.sent++;
          else if (res.status === 404 || res.status === 410) { r.failed++; r.expired = (r.expired || 0) + 1; gone.push([person, id]); }
          else { r.failed++; r.error = `rechazado (${res.status})`; }
        } catch {
          r.failed++; r.error = 'no se pudo enviar'; // never the exception's own text: it can carry the endpoint
        }
      }
      log(`test ${test.id}: ${person}: ${r.devices} devices, ${r.sent} sent, ${r.failed} failed`);
    }
  }
  for (const s of sends) {
    const devices = Object.entries(subs[s.to] || {});
    for (const [id, sub] of devices) {
      if (dry) { log(`[dry] ${s.to} (${id}): ${s.title} | ${s.body}`); continue; }
      try {
        const r = await sendPush({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify({ title: s.title, body: s.body, url: s.url, tag: s.tag }),
          { subject: APP, publicKey: vapidPublic, privateKey: vapidPrivate });
        if (r.status === 404 || r.status === 410) gone.push([s.to, id]);
        else if (r.status >= 200 && r.status < 300) delivered++;
        else log(`push to ${s.to} (${id}) failed: ${r.status} ${r.text}`);
      } catch (e) {
        log(`push to ${s.to} (${id}) failed: ${e.message}`);
      }
    }
    if (!devices.length) log(`(no devices) ${s.to}: ${s.title}`);
  }
  if (gone.length) await db.patch('push-subs', {}, gone.map(([p, id]) => [p, id]));

  // tell the app how the test went, unless someone asked for a new one in the meantime (then that one is next round's)
  if (test && !dry) {
    try { await db.patch('push-test', { doneAt: Date.now(), results }, [['doneAt'], ['results']], test.updateTime); }
    catch (e) { log(/FAILED_PRECONDITION|ABORTED/.test(e.message) ? `test ${test.id}: replaced by a newer request, results not saved` : `test ${test.id}: results not saved: ${e.message}`); }
  }

  await db.patch('push-state', { json: JSON.stringify(state) }, [['json']]);
  const summary = `${project}: ${logs.length} log entries, ${messages.length} messages; ${out.length} new, ${sends.length} to send${muted ? `, ${muted} muted by preferences` : ''}${QUIET ? ' (quiet hours: queued)' : ''}, ${delivered} delivered, ${gone.length} dead subscriptions removed${test ? `, test to ${test.to.length}` : ''}${first ? ' (first run: starting point set)' : ''}`;
  log(summary);
  return summary;
}
