// Mi Gente's notifications as a Cloudflare Worker: every few minutes (wrangler.toml's cron) one round per project,
// the same run() as the command line (core.mjs). Cloudflare's cron fires on time, which GitHub's schedule didn't (it
// fired twice in the first 14 hours).
//
// Vars: PROJECTS (comma-separated) and CRONS (separated by |, a cron has commas of its own), in the same order:
// each cron runs its project. VAPID_PUBLIC. Secret: VAPID_PRIVATE (wrangler secret put VAPID_PRIVATE).
// FIRESTORE_BASE and IGNORE_QUIET only for local testing against the emulator (.dev.vars).
import { run } from './core.mjs';

export default {
  async scheduled(controller, env, ctx) {
    // one project per cron (wrangler.toml's crons and PROJECTS in the same order), so each run stays inside the free
    // plan's 10 ms of CPU; a cron that isn't listed (a test call) runs them all
    const all = (env.PROJECTS || 'mi-gente-quedadas').split(',').map(p => p.trim()).filter(Boolean);
    const crons = (env.CRONS || '').split('|').map(c => c.trim());
    const at = crons.indexOf(controller.cron);
    const projects = at >= 0 && all[at] ? [all[at]] : all;
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
