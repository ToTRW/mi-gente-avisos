// Mi Gente's notifications: reads the app's Firestore (the plans' activity log, the chat, missed pokes and the goat
// farm), works out who should hear about what, and sends Web Push notifications to the devices people switched them on
// for (config/push-subs). What it has already said lives in config/push-state, so nothing is sent twice. Nothing
// between 23:00 and 9:00 in Madrid: those wait for the morning, and many at once become one.
//
// Plain fetch and WebCrypto only, so the same run() works in Node (send.mjs) and in the Cloudflare Worker (worker.mjs).
import { sendPush } from './webpush.mjs';

const APPS = { 'mi-gente-quedadas': 'https://mi-gente-quedadas.web.app', 'mi-gente-preprod': 'https://mi-gente-preprod.web.app' };
const HOUR = 3_600_000;

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
const docOf = d => ({ ...fields(d.fields), _doc: d.name.split('/').pop() });
const quote = s => /^[A-Za-z_][A-Za-z_0-9]*$/.test(s) ? s : '`' + s.replace(/[`\\]/g, m => '\\' + m) + '`';

function firestore(base, dry) {
  return {
    async get(path) {
      const r = await fetch(`${base}/${path}`);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`GET ${path}: ${r.status} ${await r.text()}`);
      return docOf(await r.json());
    },
    async list(collection) {
      const out = [];
      let token = '';
      do {
        const r = await fetch(`${base}/${collection}?pageSize=300${token ? `&pageToken=${token}` : ''}`);
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
    async since(collection, field, cursor) {
      const r = await fetch(`${base}:runQuery`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ structuredQuery: {
        from: [{ collectionId: collection }],
        where: { fieldFilter: { field: { fieldPath: field }, op: 'GREATER_THAN', value: { timestampValue: cursor } } },
        orderBy: [{ field: { fieldPath: field }, direction: 'ASCENDING' }], limit: 300 } }) });
      if (!r.ok) throw new Error(`query ${collection}: ${r.status} ${await r.text()}`);
      return (await r.json()).filter(x => x.document).map(x => ({ ...docOf(x.document), _at: x.document.fields?.[field]?.timestampValue }));
    },
    /** Writes the named fields of config/<id> (a field left out of `data` is deleted). */
    async patch(id, data, paths) {
      if (dry) return;
      const encode = v => typeof v === 'string' ? { stringValue: v } : typeof v === 'number' ? { doubleValue: v } : { nullValue: null };
      const body = { fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, encode(v)])) };
      const mask = paths.map(p => `updateMask.fieldPaths=${encodeURIComponent(p.map(quote).join('.'))}`).join('&');
      const r = await fetch(`${base}/config/${id}?${mask}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`patch ${id}: ${r.status} ${await r.text()}`);
    },
  };
}

// ---------- Madrid time ----------

const madridDay = t => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
const madridHour = t => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', hourCycle: 'h23' }).format(t));

// ---------- The goat farm (mirrors src/lib/goats/model.ts in the app) ----------

const clamp = n => Math.max(0, Math.min(100, n));
const foodDecay = goat => goat.personality === 'comilona' ? 4 : 3;
function needsAt(goat, now) {
  const hours = Math.max(0, now - (goat.restedAt || now)) / HOUR;
  const n = goat.needs || {};
  return { food: Math.max(20, clamp((n.food ?? 75) - foodDecay(goat) * hours)), mood: Math.max(20, clamp((n.mood ?? 75) - 2 * hours)) };
}
const LOW = 30, BACK = 50; // a need at 30 or less is worth a word; it has to be back over 50 before it can be said again

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
 *   log            where the summary and errors go
 * Resolves to the one-line summary.
 */
export async function run({ project = 'mi-gente-quedadas', vapidPublic = '', vapidPrivate = '', dry = false, firestoreBase = '', ignoreQuiet = false, now = Date.now(), testTo = '', log = console.log }) {
  const NOW = now;
  const db = firestore(firestoreBase || `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`, dry);
  const APP = APPS[project] || APPS['mi-gente-quedadas'];
  const QUIET = !ignoreQuiet && (h => h >= 23 || h < 9)(madridHour(NOW));

  const [config, presence] = await Promise.all([db.list('config'), db.list('presence')]);
  const byId = Object.fromEntries(config.map(d => [d._doc, d]));
  const friends = byId.users?.list || [];
  const admins = byId.roles?.admins || ['Alex'];
  const prefs = byId.preferences || {};
  const { _doc, ...subs } = byId['push-subs'] || {};
  let state = {};
  try { state = JSON.parse(byId['push-state']?.json || '{}'); } catch { state = {}; }
  const first = typeof state.logs !== 'string';
  if (first) state.logs = state.chat = new Date(NOW).toISOString(); state.sent ??= {}; state.low ??= {}; state.boxSeen ??= {}; state.missed ??= {}; state.queue ??= {};

  /** { to, title, body, url, tag } */
  const out = [];
  const say = (to, title, body, url = '/', tag) => { if (to && friends.includes(to)) out.push({ to, title, body, url, tag }); };
  const once = (key, fn) => { if (state.sent[key]) return; state.sent[key] = NOW; fn(); };

  // plans: from the activity log
  const logs = await db.since('activityLogs', 'at', state.logs);
  const events = {};
  const eventOf = async id => id ? (events[id] ??= await db.get(`events/${id}`).catch(() => null)) : null;
  for (const entry of logs) {
    if (entry._at) state.logs = entry._at;
    const ev = await eventOf(entry.eventId);
    const who = entry.actor || 'Alguien', name = entry.eventName || ev?.name || 'un plan';
    const people = (ev?.participants ?? friends).filter(p => p !== who);
    const url = entry.eventId ? `/?evento=${encodeURIComponent(entry.eventId)}` : '/';
    if (entry.action === 'event:create') people.forEach(p => say(p, `📅 ${who} ha creado un plan`, name, url, `plan-${entry.eventId}`));
    if (entry.action === 'event:lock') people.forEach(p => say(p, `🔒 Hora fijada`, `${name}${entry.range ? ` · ${entry.range}` : ''}`, url, `plan-${entry.eventId}`));
    if (entry.action === 'event:postpone') people.forEach(p => say(p, `⏩ ${who} ha aplazado un plan`, `${name}: vuelve a marcar tus horas`, url, `plan-${entry.eventId}`));
    if (entry.action === 'event:edit' && entry.datesChanged) people.forEach(p => say(p, `✏️ ${who} ha cambiado las fechas`, name, url, `plan-${entry.eventId}`));
    if (entry.action === 'event:nudge') (entry.names || []).filter(p => p !== who).forEach(p => say(p, `📢 ${who} te recuerda un plan`, `Falta tu respuesta: ${name}`, url, `plan-${entry.eventId}`));
    if (entry.action === 'event:nudge-maybe') (entry.names || []).filter(p => p !== who).forEach(p => say(p, `❔ ${who} pide que confirmes`, `¿Vas o no? ${name}`, url, `plan-${entry.eventId}`));
  }

  // the chat: one notification per person for however many messages came in
  const messages = await db.since('messages', 'ts', state.chat);
  if (messages.length) {
    state.chat = messages[messages.length - 1]._at || state.chat;
    for (const person of friends) {
      const theirs = messages.filter(m => m.name !== person);
      if (!theirs.length) continue;
      const last = theirs[theirs.length - 1];
      say(person, theirs.length === 1 ? `💬 ${last.name}` : `💬 ${theirs.length} mensajes en el chat`,
        theirs.length === 1 ? last.text : `${last.name}: ${last.text}`, '/?grupo', 'chat');
    }
  }

  // pokes that arrived while they were away (presence/<name>.missed = { from: count })
  for (const p of presence) {
    const missed = p.missed || {}, seen = state.missed[p._doc] || {};
    for (const [from, n] of Object.entries(missed)) if (n > (seen[from] || 0)) say(p._doc, `👉 ${from} te ha dado un toque`, 'Entra a ver qué quiere', '/', `poke-${from}`);
    state.missed[p._doc] = missed;
  }

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
        once(`trip:${trip.id}`, () => say(owner, `🧭 ${goat.name} ha vuelto de la excursión`, 'Trae cosas para recoger', url, `trip-${gid}`));
      // hungry or sad: once each time it drops, again only after it's been looked after
      const n = needsAt(goat, NOW), low = state.low[gid] ||= {};
      for (const [need, title] of [['food', `🌾 ${goat.name} tiene hambre`], ['mood', `💔 ${goat.name} está triste`]]) {
        if (n[need] <= LOW && !low[need]) { low[need] = true; say(owner, title, need === 'food' ? 'Pásate a darle de comer' : 'Pásate a hacerle caso', url, `need-${gid}`); }
        if (n[need] >= BACK) low[need] = false;
      }
      // a box waiting for an hour
      if ((goat.boxes || []).length) {
        const seen = state.boxSeen[gid] ||= NOW;
        if (NOW - seen >= HOUR) once(`box:${gid}:${seen}`, () => say(owner, `📦 ${goat.name} tiene una caja sin abrir`, '¿Qué habrá dentro?', url, `box-${gid}`));
      } else delete state.boxSeen[gid];
    }
    // gifts waiting to be accepted
    for (const gift of config.filter(d => d._doc.startsWith('farm-costume-gift-') && d.status === 'pending')) {
      const to = goatById[gift.toGoatId], from = goatById[gift.fromGoatId];
      if (!to || !plays(to.owner)) continue;
      once(`gift:${gift._doc}:${gift.offeredAt}`, () => say(to.owner, `🎁 ${from?.owner || 'Alguien'} te ha mandado un regalo`, `Para ${to.name}: ábrelo en su parcela`, `/?cabrita=${encodeURIComponent(gift.toGoatId)}`, `gift-${gift.toGoatId}`));
    }
  }

  // a farm event: when it starts, and on its last day (everyone who plays)
  const ev = byId['farm-event'];
  if (prefs.farmEnabled && ev?.id && ev.from <= NOW && NOW < ev.to) {
    const name = ev.name || 'Evento en la granja', players = friends.filter(p => prefs.farmOpen === true || admins.includes(p));
    once(`event:${ev.id}:${ev.from}`, () => players.forEach(p => say(p, `🎉 Empieza: ${name}`, ev.blurb || 'Pásate por la granja.', '/?granja', 'event')));
    if (ev.to - NOW < 24 * HOUR) once(`event-last:${ev.id}:${ev.from}`, () => players.forEach(p => say(p, `⏳ Último día: ${name}`, ev.blurb || 'Mañana se acaba.', '/?granja', 'event')));
  }

  // a streak at stake: from 20:00, a run of three days or more that today's care hasn't counted yet
  if (prefs.farmEnabled && madridHour(NOW) >= 20) {
    const today = madridDay(NOW), yesterday = madridDay(NOW - 24 * HOUR);
    for (const goat of config.filter(d => d._doc.startsWith('goat-'))) {
      const s = goat.streak;
      if (!s || s.count < 3 || s.day !== yesterday) continue;
      once(`streak:${goat._doc}:${today}`, () => say(goat.owner, `☀️ Racha de ${s.count} días`, `Cuida hoy a ${goat.name} para no perderla`, `/?cabrita=${encodeURIComponent(goat._doc.slice(5))}`, 'streak'));
    }
  }

  // forget what's long gone
  for (const [k, t] of Object.entries(state.sent)) if (NOW - t > 14 * 24 * HOUR) delete state.sent[k];

  // the first run only sets the starting point: no history gets sent
  if (first) out.length = 0;

  // quiet hours: keep them for the morning
  for (const o of out) (state.queue[o.to] ||= []).push(o);
  for (const k of Object.keys(state.queue)) state.queue[k] = state.queue[k].slice(-30);
  const sends = [];
  if (!QUIET) {
    for (const [person, items] of Object.entries(state.queue)) {
      if (!items.length) continue;
      // several for one person become one
      const batch = items.length > 3
        ? [{ to: person, title: `Mi Gente: ${items.length} novedades`, body: items.slice(-3).map(i => i.title.replace(/^\S+\s/, '')).join(' · '), url: '/', tag: 'digest' }]
        : items;
      sends.push(...batch);
      state.queue[person] = [];
    }
  }

  if (testTo) sends.push({ to: testTo, title: '🐐 Prueba de avisos', body: 'Si ves esto, los avisos de Mi Gente llegan a este dispositivo.', url: '/', tag: 'test' });

  // send
  const gone = [];
  let delivered = 0;
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

  await db.patch('push-state', { json: JSON.stringify(state) }, [['json']]);
  const summary = `${project}: ${logs.length} log entries, ${messages.length} messages; ${out.length} new, ${sends.length} to send${QUIET ? ' (quiet hours: queued)' : ''}, ${delivered} delivered, ${gone.length} dead subscriptions removed${first ? ' (first run: starting point set)' : ''}`;
  log(summary);
  return summary;
}
