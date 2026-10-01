// Mi Gente's notifications as a Cloudflare Worker: every few minutes (wrangler.toml's cron) one round per project,
// the same run() as the command line (core.mjs). Cloudflare's cron fires on time, which GitHub's schedule didn't (it
// fired twice in the first 14 hours).
//
// Vars: PROJECTS (comma-separated), VAPID_PUBLIC. Secret: VAPID_PRIVATE (wrangler secret put VAPID_PRIVATE).
// FIRESTORE_BASE and IGNORE_QUIET only for local testing against the emulator (.dev.vars).
import { run } from './core.mjs';

export default {
  async scheduled(controller, env, ctx) {
    const projects = (env.PROJECTS || 'mi-gente-quedadas').split(',').map(p => p.trim()).filter(Boolean);
    ctx.waitUntil(Promise.all(projects.map(project => run({
      project,
      vapidPublic: env.VAPID_PUBLIC,
      vapidPrivate: env.VAPID_PRIVATE,
      firestoreBase: env.FIRESTORE_BASE || '',
      ignoreQuiet: env.IGNORE_QUIET === '1',
      now: controller.scheduledTime,
    }).catch(e => console.error(`${project}: ${e.stack || e.message}`)))));
  },
  // nothing to see: the Worker only works on its schedule
  async fetch() {
    return new Response('Mi Gente · avisos\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  },
};
