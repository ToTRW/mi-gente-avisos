// «Probar avisos»: an admin's test request (config/push-test) is sent to exactly the people it names, quiet hours or
// not, and the results go back into the same document. Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import ece from 'http_ece';
import { pendingPushTest, run } from '../core.mjs';
import { firestoreStand } from './fakefs.mjs';

const b64u = b => Buffer.from(b).toString('base64url');
const NOW = Date.UTC(2026, 9, 2, 1, 0, 0); // 03:00 in Madrid: quiet hours
const VAPID = createECDH('prime256v1');
VAPID.generateKeys();
const KEYS = { vapidPublic: b64u(VAPID.getPublicKey()), vapidPrivate: b64u(VAPID.getPrivateKey()) };

/** A browser's subscription, with the key pair kept so the test can read what it was sent. */
function device(name, n) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, auth, endpoint: `https://push.test/${name}/${n}-secret`, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) } };
}
const sub = d => ({ endpoint: d.endpoint, keys: d.keys, at: 1, device: 'x' });

// the Firestore REST encoding, both ways
const enc = v => typeof v === 'string' ? { stringValue: v } : typeof v === 'number' ? { integerValue: String(v) } : typeof v === 'boolean' ? { booleanValue: v }
  : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
const dec = v => 'stringValue' in v ? v.stringValue : 'integerValue' in v ? Number(v.integerValue) : 'booleanValue' in v ? v.booleanValue
  : 'arrayValue' in v ? (v.arrayValue.values || []).map(dec) : 'mapValue' in v ? Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, dec(x)])) : null;
const doc = (id, o, updateTime) => ({ name: `projects/p/databases/(default)/documents/config/${id}`, fields: enc(o).mapValue.fields, ...(updateTime ? { updateTime } : {}) });

/**
 * One round against a stand-in Firestore. `pushStatus(endpoint)` is what the push service answers.
 * Resolves to { hits: [endpoint], bodies: { endpoint: encrypted body }, patches: [{ id, query, fields }], raw: [request bodies], lines }.
 */
async function round({ docs = {}, subs = {}, pushStatus = () => 201, updateTime } = {}) {
  const hits = [], bodies = {}, patches = [], raw = [], lines = [];
  const real = globalThis.fetch;
  const json = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  const fs = firestoreStand();
  Object.assign(fs.config, {
    users: { list: ['Alex', 'Vane', 'Guille', 'Indar'] },
    roles: { admins: ['Alex'] },
    'push-state': { json: JSON.stringify({ logs: new Date(NOW - 60_000).toISOString(), chat: new Date(NOW - 60_000).toISOString() }) },
    ...docs,
    'push-subs': Object.fromEntries(Object.entries(subs).map(([p, ds]) => [p, Object.fromEntries(ds.map((d, i) => [`d${i}`, sub(d)]))])),
  });
  if (updateTime) fs.updateTimes['push-test'] = updateTime;
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.startsWith('https://push.test/')) {
      hits.push(url); bodies[url] = init.body;
      const status = pushStatus(url);
      return { ok: status < 300, status, text: async () => 'push service says no' };
    }
    if (init.method === 'PATCH') {
      const [path, query] = url.split('/config/')[1].split('?');
      patches.push({ id: path, query: decodeURIComponent(query), fields: dec({ mapValue: { fields: JSON.parse(init.body).fields } }) });
      raw.push(init.body);
      return json({});
    }
    const answered = fs.handle(url, init);
    if (answered) return answered;
    if (init.method === 'POST') return json([]);
    throw new Error(`unexpected ${url}`);
  };
  try { await run({ project: 'mi-gente-preprod', now: NOW, log: l => lines.push(l), ...KEYS }); } finally { globalThis.fetch = real; }
  return { hits, bodies, patches, raw, lines };
}

const request = (over = {}) => ({ id: 'pt-1759370000000-abc123', to: ['Vane', 'Guille'], text: 'Hola, prueba', by: 'Alex', at: NOW - 60_000, ...over });

test('pendingPushTest: only a fresh, open request from an admin, with clean names and text', () => {
  const admins = ['Alex'];
  assert.deepEqual(pendingPushTest({ ...request({ to: ['Vane', 'Vane', '', 7, 'Guille'], text: '  dos   líneas\n ' }), _updateTime: 'T' }, admins, NOW),
    { id: 'pt-1759370000000-abc123', to: ['Vane', 'Guille'], text: 'dos líneas', updateTime: 'T' });
  assert.equal(pendingPushTest(request({ text: '' }), admins, NOW).text, 'Prueba de avisos');
  assert.equal(pendingPushTest(request({ text: 'x'.repeat(500) }), admins, NOW).text.length, 140);
  assert.equal(pendingPushTest(request({ to: Array.from({ length: 20 }, (_, i) => `P${i}`) }), admins, NOW).to.length, 8);
  for (const bad of [null, undefined, request({ doneAt: NOW }), request({ by: 'Guille' }), request({ to: [] }), request({ to: 'Vane' }),
    request({ at: NOW - 31 * 60_000 }), request({ at: undefined }), request({ id: '' })]) assert.equal(pendingPushTest(bad, admins, NOW), null);
});

test('a pending request sends to exactly the people it names (even in quiet hours) and writes the results back', async () => {
  const vane = [device('vane', 1), device('vane', 2)], alex = [device('alex', 1)];
  const { hits, patches, lines } = await round({ docs: { 'push-test': request({ to: ['Vane', 'Guille', 'Nadie'] }) }, subs: { Vane: vane, Alex: alex, Guille: [] } });
  assert.deepEqual(hits.sort(), vane.map(d => d.endpoint).sort()); // Alex has avisos on and was not named: nothing for him
  const written = patches.find(p => p.id === 'push-test');
  assert.ok(written, 'results written');
  assert.deepEqual(written.query.split('&').sort(), ['updateMask.fieldPaths=doneAt', 'updateMask.fieldPaths=results']);
  assert.equal(typeof written.fields.doneAt, 'number');
  assert.deepEqual(written.fields.results, {
    Vane: { devices: 2, sent: 2, failed: 0 },
    Guille: { devices: 0, sent: 0, failed: 0 },
    Nadie: { devices: 0, sent: 0, failed: 0, unknown: true },
  });
  assert.ok(lines.some(l => l.includes('Vane: 2 devices, 2 sent')));
});

test('what a device receives: the text of the request, readable only with its own keys', async () => {
  const vane = device('vane', 1);
  const { bodies } = await round({ docs: { 'push-test': request({ to: ['Vane'], text: 'Buenas, ¿llega?' }) }, subs: { Vane: [vane] } });
  const plain = JSON.parse(ece.decrypt(Buffer.from(bodies[vane.endpoint]), { version: 'aes128gcm', privateKey: vane.ecdh, authSecret: b64u(vane.auth) }).toString('utf8'));
  assert.equal(plain.body, 'Buenas, ¿llega?');
  assert.equal(plain.tag, 'test');
});

test('an expired subscription is reported and removed; any other failure is reported with its status only', async () => {
  const dead = device('vane', 1), broken = device('vane', 2), fine = device('indar', 1);
  const { patches, raw } = await round({
    docs: { 'push-test': request({ to: ['Vane', 'Indar'] }) },
    subs: { Vane: [dead, broken], Indar: [fine] },
    pushStatus: url => url === dead.endpoint ? 410 : url === broken.endpoint ? 500 : 201,
  });
  const results = patches.find(p => p.id === 'push-test').fields.results;
  assert.deepEqual(results.Vane, { devices: 2, sent: 0, failed: 2, expired: 1, error: 'rechazado (500)' });
  assert.deepEqual(results.Indar, { devices: 1, sent: 1, failed: 0 });
  const subsPatch = patches.find(p => p.id === 'push-subs');
  assert.ok(subsPatch && subsPatch.query.includes('updateMask.fieldPaths=Vane.d0'), 'the dead subscription is deleted, like in a normal round');
  // nothing secret travels back: no endpoint, no key, no push service reply
  for (const body of raw) {
    assert.ok(!body.includes('push.test') && !body.includes('secret') && !body.includes(KEYS.vapidPrivate) && !body.includes('push service says no'));
  }
});

test('a request that is done, old, or not from an admin sends nothing and writes nothing', async () => {
  for (const over of [{ doneAt: NOW - 1000, results: { Vane: { devices: 1, sent: 1, failed: 0 } } }, { at: NOW - 40 * 60_000 }, { by: 'Guille' }]) {
    const { hits, patches } = await round({ docs: { 'push-test': request(over) }, subs: { Vane: [device('vane', 1)], Guille: [device('guille', 1)] } });
    assert.deepEqual(hits, [], JSON.stringify(over));
    assert.equal(patches.find(p => p.id === 'push-test'), undefined, JSON.stringify(over));
  }
});

test('the results are only saved if nobody replaced the request meanwhile (the update time of what was read)', async () => {
  const { patches } = await round({ docs: { 'push-test': request({ to: ['Vane'] }) }, subs: { Vane: [device('vane', 1)] }, updateTime: '2026-10-02T01:00:00.123456Z' });
  assert.ok(patches.find(p => p.id === 'push-test').query.includes('currentDocument.updateTime=2026-10-02T01:00:00.123456Z'));
});

test('without a request, a round sends nothing and writes nothing to push-test', async () => {
  const { hits, patches } = await round({ subs: { Vane: [device('vane', 1)] } });
  assert.deepEqual(hits, []);
  assert.equal(patches.find(p => p.id === 'push-test'), undefined);
});
