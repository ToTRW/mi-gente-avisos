// App updates: when the live app's /version.json changes, everyone with avisos on hears it once (quiet hours wait for
// the morning). Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import ece from 'http_ece';
import { run, fetchAppVersion } from '../core.mjs';

const b64u = b => Buffer.from(b).toString('base64url');
const DAY = Date.UTC(2026, 9, 3, 10, 0, 0);    // 12:00 in Madrid
const NIGHT = Date.UTC(2026, 9, 3, 1, 0, 0);   // 03:00 in Madrid: quiet hours
const MORNING = Date.UTC(2026, 9, 3, 8, 0, 0); // 10:00 in Madrid
const VAPID = createECDH('prime256v1');
VAPID.generateKeys();
const KEYS = { vapidPublic: b64u(VAPID.getPublicKey()), vapidPrivate: b64u(VAPID.getPrivateKey()) };

function device(name, n) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, auth, endpoint: `https://push.test/${name}/${n}`, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) } };
}

const enc = v => typeof v === 'string' ? { stringValue: v } : typeof v === 'number' ? { integerValue: String(v) } : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } }
  : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
const doc = (id, o) => ({ name: `projects/p/databases/(default)/documents/config/${id}`, fields: enc(o).mapValue.fields });

/**
 * A stand-in world that keeps push-state between rounds, like the real Firestore does.
 * `site.version` is what version.json says ('FAIL' = the request throws, a number = that HTTP status, an object = that body).
 */
function world({ subs = {}, version = '1.0.0', admins = ['Alex'] } = {}) {
  const w = { site: { version }, state: JSON.stringify({ logs: new Date(DAY - 60_000).toISOString(), chat: new Date(DAY - 60_000).toISOString() }), hits: [], bodies: {}, versionUrls: [], patches: [], lines: [] };
  const people = Object.keys(subs);
  w.round = async (now, project = 'mi-gente-quedadas') => {
    const real = globalThis.fetch;
    const json = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    globalThis.fetch = async (url, init = {}) => {
      url = String(url);
      if (url.startsWith('https://push.test/')) { w.hits.push(url); w.bodies[url] = init.body; return { ok: true, status: 201, text: async () => '' }; }
      if (url.includes('/version.json')) {
        w.versionUrls.push(url);
        if (w.site.version === 'FAIL') throw new Error('network down');
        if (typeof w.site.version === 'number') return { ok: false, status: w.site.version, json: async () => ({}) };
        return json(typeof w.site.version === 'object' ? w.site.version : { version: w.site.version, sha: 'abc', builtAt: 1, mode: 'production' });
      }
      if (init.method === 'PATCH') {
        const [path] = url.split('/config/')[1].split('?');
        if (path === 'push-state') w.state = JSON.parse(init.body).fields.json.stringValue;
        w.patches.push(path);
        return json({});
      }
      if (init.method === 'POST') return json([]);
      if (url.includes('/config/push-subs')) return json(doc('push-subs', Object.fromEntries(Object.entries(subs).map(([p, ds]) => [p, Object.fromEntries(ds.map((d, i) => [`d${i}`, { endpoint: d.endpoint, keys: d.keys, at: 1 }]))]))));
      if (url.includes('/config?')) return json({ documents: Object.entries({ users: { list: [...people, 'SinAvisos'] }, roles: { admins }, 'push-state': { json: w.state } }).map(([id, o]) => doc(id, o)) });
      if (url.includes('/presence?')) return json({});
      throw new Error(`unexpected ${url}`);
    };
    w.hits.length = 0;
    try { await run({ project, now, log: l => w.lines.push(l), ...KEYS }); } finally { globalThis.fetch = real; }
    return w;
  };
  return w;
}
const read = (w, d) => JSON.parse(ece.decrypt(Buffer.from(w.bodies[d.endpoint]), { version: 'aes128gcm', privateKey: d.ecdh, authSecret: b64u(d.auth) }).toString('utf8'));

test('the first round only remembers the version: nothing is sent', async () => {
  const vane = device('vane', 1);
  const w = world({ subs: { Vane: [vane] }, version: '3.19.0' });
  await w.round(DAY);
  assert.deepEqual(w.hits, []);
  assert.equal(JSON.parse(w.state).appVersion, '3.19.0');
  assert.ok(/^https:\/\/mi-gente-quedadas\.web\.app\/version\.json\?/.test(w.versionUrls[0]), 'asks the live app, with a cache-busting query');
});

test('a new version goes once to everyone with avisos on, and the notice says what it is', async () => {
  const vane = device('vane', 1), alexA = device('alex', 1), alexB = device('alex', 2), guille = device('guille', 1);
  const w = world({ subs: { Vane: [vane], Alex: [alexA, alexB], Guille: [guille], Indar: [] }, version: '3.19.0' });
  await w.round(DAY); // starting point
  w.site.version = '3.20.0';
  await w.round(DAY + 5 * 60_000);
  assert.deepEqual(w.hits.sort(), [vane, alexA, alexB, guille].map(d => d.endpoint).sort()); // every device; Indar and SinAvisos have none
  const n = read(w, vane);
  assert.equal(n.title, '✨ Mi Gente se ha actualizado');
  assert.equal(n.body, 'Versión 3.20.0: toca para ver las novedades');
  assert.equal(n.url, '/?novedades');
  assert.equal(n.tag, 'app-update');
  assert.equal(JSON.parse(w.state).appVersion, '3.20.0');
});

test('the same version again sends nothing, and neither does a version already told coming back', async () => {
  const vane = device('vane', 1);
  const w = world({ subs: { Vane: [vane] }, version: '3.19.0' });
  await w.round(DAY);
  w.site.version = '3.20.0';
  await w.round(DAY + 5 * 60_000);
  assert.equal(w.hits.length, 1);
  await w.round(DAY + 10 * 60_000);
  assert.deepEqual(w.hits, []);
  w.site.version = '3.19.0'; await w.round(DAY + 15 * 60_000); // a stale edge answering during a deploy
  w.site.version = '3.20.0'; await w.round(DAY + 20 * 60_000);
  assert.deepEqual(w.hits, [], '3.20.0 was already told');
});

test('a failed or odd version.json is harmless: no notice, the remembered version stays', async () => {
  const vane = device('vane', 1);
  const w = world({ subs: { Vane: [vane] }, version: '3.19.0' });
  await w.round(DAY);
  for (const bad of ['FAIL', 503, { nope: 1 }, { version: '' }, { version: 'x'.repeat(200) }, { version: '<script>alert(1)</script>' }, { version: 7 }]) {
    w.site.version = bad;
    await w.round(DAY + 5 * 60_000);
    assert.deepEqual(w.hits, [], JSON.stringify(bad));
    assert.equal(JSON.parse(w.state).appVersion, '3.19.0', JSON.stringify(bad));
  }
  w.site.version = '3.20.0';
  await w.round(DAY + 10 * 60_000);
  assert.equal(w.hits.length, 1, 'and it still works afterwards');
  assert.equal(await fetchAppVersion('http://127.0.0.1:1', 1), '');
});

test('a deploy at night waits for the morning, and two deploys overnight are one notice for the last version', async () => {
  const vane = device('vane', 1);
  const w = world({ subs: { Vane: [vane] }, version: '3.19.0' });
  await w.round(NIGHT - 10 * 60_000);
  w.site.version = '3.20.0';
  await w.round(NIGHT);
  assert.deepEqual(w.hits, [], 'quiet hours');
  w.site.version = '3.20.1';
  await w.round(NIGHT + 60 * 60_000);
  assert.deepEqual(w.hits, []);
  await w.round(MORNING);
  assert.equal(w.hits.length, 1);
  assert.equal(read(w, vane).body, 'Versión 3.20.1: toca para ver las novedades');
  await w.round(MORNING + 5 * 60_000);
  assert.deepEqual(w.hits, [], 'and only once');
});

test('preprod never asks for the live version and never sends an update notice', async () => {
  const vane = device('vane', 1);
  const w = world({ subs: { Vane: [vane] }, version: '3.19.0' });
  await w.round(DAY, 'mi-gente-preprod');
  w.site.version = '3.20.0';
  await w.round(DAY + 5 * 60_000, 'mi-gente-preprod');
  assert.deepEqual(w.versionUrls, []);
  assert.deepEqual(w.hits, []);
  assert.equal(JSON.parse(w.state).appVersion, undefined);
});
