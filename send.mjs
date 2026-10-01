// Mi Gente's notifications, one round from the command line (the logic is in core.mjs; the Cloudflare Worker in
// worker.mjs runs the same thing on a schedule).
//
// PROJECT         Firebase project (mi-gente-quedadas or mi-gente-preprod)
// VAPID_PUBLIC    the public key (also in the app, src/data/push.ts)
// VAPID_PRIVATE   the private key (a secret)
// DRY_RUN=1       print what would be sent, send and save nothing
// FIRESTORE_BASE  another documents URL (the local emulator), for testing
// IGNORE_QUIET=1  send even in quiet hours (testing)
// FAKE_NOW=<ms>   pretend it's then (testing)
// TEST_TO=<name>  also send that person a test notification right now, quiet hours or not
import { run } from './core.mjs';

const e = process.env;
run({
  project: e.PROJECT || 'mi-gente-quedadas',
  vapidPublic: e.VAPID_PUBLIC || '',
  vapidPrivate: e.VAPID_PRIVATE || '',
  dry: e.DRY_RUN === '1',
  firestoreBase: e.FIRESTORE_BASE || '',
  ignoreQuiet: e.IGNORE_QUIET === '1',
  now: Number(e.FAKE_NOW) || Date.now(),
  testTo: e.TEST_TO || '',
}).catch(err => { console.error(err); process.exit(1); });
