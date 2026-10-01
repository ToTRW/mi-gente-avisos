// Web Push with nothing but WebCrypto, so the same code runs in Node and in a Cloudflare Worker: VAPID (RFC 8292)
// signs who is sending, and the payload is encrypted for the browser that subscribed (RFC 8291, aes128gcm).

const enc = new TextEncoder();
const b64u = {
  decode: s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0)),
  encode: b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
};
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

/** The VAPID signing key, from the base64url public (65 bytes, uncompressed point) and private (32 bytes) keys. */
async function signingKey(publicKey, privateKey) {
  const pub = b64u.decode(publicKey);
  const jwk = { kty: 'EC', crv: 'P-256', x: b64u.encode(pub.slice(1, 33)), y: b64u.encode(pub.slice(33, 65)), d: privateKey, ext: true };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/** `Authorization: vapid t=<JWT>, k=<public key>` for this push service, valid 12 hours. */
export async function vapidHeader(endpoint, subject, publicKey, privateKey, now = Date.now()) {
  const header = b64u.encode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u.encode(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const key = await signingKey(publicKey, privateKey);
  // WebCrypto's ECDSA signature is already r || s, which is what a JWT wants
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64u.encode(sig)}, k=${publicKey}`;
}

const hkdf = async (salt, ikm, info, bytes) => new Uint8Array(await crypto.subtle.deriveBits(
  { name: 'HKDF', hash: 'SHA-256', salt, info },
  await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), bytes * 8));

/** The payload encrypted for one subscription (`keys.p256dh`, `keys.auth`), as a single aes128gcm record. */
export async function encrypt(payload, keys) {
  const uaPublic = b64u.decode(keys.p256dh), authSecret = b64u.decode(keys.auth);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // one record, the last one: the payload then the 0x02 delimiter, no padding
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(enc.encode(payload), Uint8Array.of(2))));
  const rs = 4096;
  const head = concat(salt, Uint8Array.of(rs >>> 24, (rs >>> 16) & 255, (rs >>> 8) & 255, rs & 255, asPublic.length), asPublic);
  return concat(head, sealed);
}

/**
 * Sends one notification. Resolves to the push service's status: 201 delivered, 404/410 the subscription is gone
 * (the caller drops it), anything else an error worth logging.
 */
export async function sendPush(sub, payload, { subject, publicKey, privateKey, ttl = 6 * 3600, urgency = 'normal' }) {
  const body = await encrypt(payload, sub.keys);
  const r = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      authorization: await vapidHeader(sub.endpoint, subject, publicKey, privateKey),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(ttl),
      urgency,
    },
    body,
  });
  return { status: r.status, text: r.ok ? '' : await r.text().catch(() => '') };
}
