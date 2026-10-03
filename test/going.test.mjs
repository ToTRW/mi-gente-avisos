// Plan notices go to the people on the plan, and the time fixed and «llega tarde» skip whoever said no. Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../core.mjs';

const NOW = Date.UTC(2026, 9, 2, 17, 0, 0); // 19:00 in Madrid: not quiet hours
const str = s => ({ stringValue: s });
const enc = v => typeof v === 'string' ? str(v) : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } }
  : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
const toFields = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => [k, enc(v)]));

// Vane said no (rsvp), Indar said no the old way (no hours marked), Guille hasn't answered, Raul isn't on the plan
const EVENT = { name: 'Cena', participants: ['Alex', 'Vane', 'Guille', 'Indar'],
  rsvpStatus: { Alex: 'yes', Vane: 'no' }, availability: { Alex: ['2026-10-03-21'], Indar: [] } };

async function round(log) {
  const lines = [];
  const real = globalThis.fetch;
  const doc = (path, o) => ({ name: `projects/p/databases/(default)/documents/${path}`, fields: toFields(o) });
  const json = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  const config = {
    users: { list: ['Alex', 'Vane', 'Guille', 'Indar', 'Raul'] },
    'push-state': { json: JSON.stringify({ logs: new Date(NOW - 60_000).toISOString(), chat: new Date(NOW - 60_000).toISOString() }) },
  };
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (init.method === 'POST') {
      const body = String(init.body);
      return json(body.includes('activityLogs') ? [{ document: { ...doc('activityLogs/l1', log), updateTime: new Date(NOW - 30_000).toISOString() } }] : []);
    }
    if (init.method === 'PATCH') return json({});
    if (url.includes('/config?')) return json({ documents: Object.entries(config).map(([id, o]) => doc(`config/${id}`, o)) });
    if (url.includes('/events/e1')) return json(doc('events/e1', EVENT));
    if (url.includes('/presence?')) return json({});
    if (url.includes('/config/push-prefs')) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    if (url.includes('/config/push-subs')) return json(doc('config/push-subs', {}));
    throw new Error(`unexpected ${url}`);
  };
  try {
    await run({ project: 'mi-gente-preprod', dry: true, ignoreQuiet: true, now: NOW, log: l => lines.push(l) });
  } finally { globalThis.fetch = real; }
  return lines.filter(l => l.startsWith('(no devices)')).map(l => l.split(':')[0].replace('(no devices) ', '')).sort();
}

const at = new Date(NOW - 30_000).toISOString();

test('a new plan reaches everyone on it but its creator, and nobody off it', async () => {
  assert.deepEqual(await round({ action: 'event:create', actor: 'Alex', eventId: 'e1', eventName: 'Cena', at }), ['Guille', 'Indar', 'Vane']);
});

test('the fixed time skips whoever said no', async () => {
  assert.deepEqual(await round({ action: 'event:lock', actor: 'Alex', eventId: 'e1', eventName: 'Cena', at }), ['Guille']);
});

test('«llega tarde» skips whoever said no', async () => {
  assert.deepEqual(await round({ action: 'late:set', actor: 'Guille', eventId: 'e1', eventName: 'Cena', until: '21:30', at }), ['Alex']);
});

test('new dates ask everyone on the plan again, the ones who said no too', async () => {
  assert.deepEqual(await round({ action: 'event:edit', actor: 'Alex', eventId: 'e1', eventName: 'Cena', datesChanged: 'true', at }), ['Guille', 'Indar', 'Vane']);
});
