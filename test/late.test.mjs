// «Llego tarde»: the others on the plan hear when someone warns they're late. Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../core.mjs';

const NOW = Date.UTC(2026, 9, 2, 17, 0, 0); // 19:00 in Madrid: not quiet hours
const str = s => ({ stringValue: s });
const toFields = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) =>
  [k, typeof v === 'number' ? { integerValue: String(v) } : Array.isArray(v) ? { arrayValue: { values: v.map(str) } } : str(v)]));

async function round(log) {
  const lines = [];
  const real = globalThis.fetch;
  const doc = (path, o) => ({ name: `projects/p/databases/(default)/documents/${path}`, fields: toFields(o) });
  const json = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  const config = {
    users: { list: ['Alex', 'Vane', 'Guille'] },
    'push-state': { json: JSON.stringify({ logs: new Date(NOW - 60_000).toISOString(), chat: new Date(NOW - 60_000).toISOString() }) },
  };
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (init.method === 'POST') {
      const body = String(init.body);
      // the activity log query gets the warning; every other query (chat...) comes back empty
      return json(body.includes('activityLogs') ? [{ document: { ...doc('activityLogs/l1', log), updateTime: new Date(NOW - 30_000).toISOString() } }] : []);
    }
    if (init.method === 'PATCH') return json({});
    if (url.includes('/config?')) return json({ documents: Object.entries(config).map(([id, o]) => doc(`config/${id}`, o)) });
    if (url.includes('/events/e1')) return json(doc('events/e1', { name: 'Cena', participants: ['Alex', 'Vane', 'Guille'] }));
    if (url.includes('/presence?')) return json({});
    if (url.includes('/config/push-subs')) return json(doc('config/push-subs', {}));
    throw new Error(`unexpected ${url}`);
  };
  try {
    await run({ project: 'mi-gente-preprod', dry: true, ignoreQuiet: true, now: NOW, log: l => lines.push(l) });
  } finally { globalThis.fetch = real; }
  return lines.filter(l => l.startsWith('(no devices)'));
}

test('a late warning tells the others on the plan, not the one running late', async () => {
  const lines = await round({ action: 'late:set', actor: 'Vane', eventId: 'e1', eventName: 'Cena', until: '21:30', reason: 'el metro', at: new Date(NOW - 30_000).toISOString() });
  assert.deepEqual(lines.sort(), ['(no devices) Alex: 🕘 Vane llega tarde', '(no devices) Guille: 🕘 Vane llega tarde']);
});
