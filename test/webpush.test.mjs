// Checks the WebCrypto Web Push against the reference implementation the web-push library uses (http_ece), and the
// VAPID token against Node's own ECDSA verify. Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createPublicKey, verify, randomBytes } from 'node:crypto';
import ece from 'http_ece';
import { encrypt, vapidHeader } from '../webpush.mjs';

const b64u = b => Buffer.from(b).toString('base64url');

test('a payload encrypted here decrypts with the reference implementation', async () => {
  // a browser's subscription: its key pair and auth secret
  const browser = createECDH('prime256v1');
  browser.generateKeys();
  const auth = randomBytes(16);
  const payload = JSON.stringify({ title: '🐐 Prueba de avisos', body: 'Áéíóú ñ, con acentos y emojis 🎁', url: '/', tag: 'test' });
  const sealed = await encrypt(payload, { p256dh: b64u(browser.getPublicKey()), auth: b64u(auth) });
  const plain = ece.decrypt(Buffer.from(sealed), { version: 'aes128gcm', privateKey: browser, authSecret: b64u(auth) });
  assert.equal(plain.toString('utf8'), payload);
});

test('every encryption is fresh (new salt and key each time)', async () => {
  const browser = createECDH('prime256v1');
  browser.generateKeys();
  const keys = { p256dh: b64u(browser.getPublicKey()), auth: b64u(randomBytes(16)) };
  const [a, b] = await Promise.all([encrypt('same', keys), encrypt('same', keys)]);
  assert.notDeepEqual(Buffer.from(a).subarray(0, 16), Buffer.from(b).subarray(0, 16));
});

test('the VAPID token is a valid ES256 JWT for the push service, signed by the key pair', async () => {
  const pair = createECDH('prime256v1');
  pair.generateKeys();
  const publicKey = b64u(pair.getPublicKey()), privateKey = b64u(pair.getPrivateKey());
  const now = Date.parse('2026-10-01T10:00:00Z');
  const h = await vapidHeader('https://fcm.googleapis.com/fcm/send/abc', 'https://mi-gente-quedadas.web.app', publicKey, privateKey, now);
  const [, jwt, k] = h.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, publicKey);
  const [head, claims, sig] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url')), { typ: 'JWT', alg: 'ES256' });
  const c = JSON.parse(Buffer.from(claims, 'base64url'));
  assert.equal(c.aud, 'https://fcm.googleapis.com');
  assert.equal(c.sub, 'https://mi-gente-quedadas.web.app');
  assert.equal(c.exp, now / 1000 + 12 * 3600);
  const pub = pair.getPublicKey();
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) }, format: 'jwk' });
  assert.ok(verify('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
});

test('Madrid time by hand matches the time zone database, every hour across the clock changes', async () => {
  const { madridDay, madridHour } = await import('../core.mjs');
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' });
  const hour = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', hourCycle: 'h23' });
  for (let t = Date.parse('2026-01-01T00:00:00Z'); t < Date.parse('2031-01-01T00:00:00Z'); t += 3_600_000 + 17 * 60_000) {
    assert.equal(madridDay(t), day.format(t), new Date(t).toISOString());
    assert.equal(madridHour(t), Number(hour.format(t)), new Date(t).toISOString());
  }
  // right at the changes
  for (const iso of ['2026-03-29T00:59:59Z', '2026-03-29T01:00:00Z', '2026-10-25T00:59:59Z', '2026-10-25T01:00:00Z', '2027-03-28T01:00:00Z', '2027-10-31T00:30:00Z']) {
    const t = Date.parse(iso);
    assert.equal(madridHour(t), Number(hour.format(t)), iso);
  }
});
