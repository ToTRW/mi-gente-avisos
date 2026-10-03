// The bug-report notices: who is told, about what, and never twice. Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bugSnippet, freshBugReports, run } from '../core.mjs';

const NOW = Date.UTC(2026, 9, 2, 12, 0, 0); // 14:00 in Madrid: not quiet hours
const bugId = (ms, tail = 'abc123') => `bug-${ms}-${tail}`;

test('bugSnippet: the first words, on one line, cut at a word', () => {
  assert.equal(bugSnippet('  no   carga\nla granja '), 'no carga la granja');
  const long = 'la pantalla se queda en blanco cuando abro la granja desde el enlace del grupo y no vuelve nunca más';
  const s = bugSnippet(long);
  assert.ok(s.endsWith('…') && s.length <= 81, s);
  assert.ok(long.startsWith(s.slice(0, -1)));
  assert.ok(!s.slice(0, -1).endsWith(' '));
  assert.equal(bugSnippet(undefined), '');
});

test('freshBugReports: only open reports of the last day, oldest first', () => {
  const doc = (id, over = {}) => ({ _doc: id, kind: 'bug', by: 'Vane', text: 'x', at: NOW - 1000, resolved: false, ...over });
  const config = [
    doc(bugId(NOW - 2000, 'bbbbbb'), { at: NOW - 2000 }),
    doc(bugId(NOW - 5000, 'aaaaaa'), { at: NOW - 5000 }),
    doc(bugId(NOW - 3000, 'cccccc'), { resolved: true }),
    doc(bugId(NOW - 25 * 3_600_000, 'dddddd'), { at: NOW - 25 * 3_600_000 }),
    doc('bugshot-1759400000000-eeeeee', { kind: undefined }),
    doc('users', { kind: undefined }),
    doc(bugId(NOW - 4000, 'ffffff'), { kind: 'other' }),
    doc(bugId(NOW - 4000, 'gggggg'), { at: undefined }),
  ];
  assert.deepEqual(freshBugReports(config, NOW).map(r => r.id), [bugId(NOW - 5000, 'aaaaaa'), bugId(NOW - 2000, 'bbbbbb')]);
  assert.equal(freshBugReports([doc(bugId(NOW - 5000), { by: undefined })], NOW)[0].by, 'Alguien');
});

// a stand-in for the app's Firestore (REST): config documents, nothing in the logs or the chat
const int = n => ({ integerValue: String(n) });
const str = s => ({ stringValue: s });
function fakeFirestore(docs, writes) {
  const toFields = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) =>
    [k, typeof v === 'number' ? int(v) : typeof v === 'boolean' ? { booleanValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(str) } } : str(v)]));
  const full = (id, o) => ({ name: `projects/p/databases/(default)/documents/config/${id}`, fields: toFields(o) });
  const json = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  return async (url, init = {}) => {
    url = String(url);
    if (init.method === 'POST') return json([]);
    if (init.method === 'PATCH') { writes.push(JSON.parse(init.body)); return json({}); }
    if (url.includes('/config?')) return json({ documents: Object.entries(docs).map(([id, o]) => full(id, o)) });
    if (url.includes('/presence?')) return json({});
    if (url.includes('/config/push-prefs')) return { ok: false, status: 404, json: async () => ({}), text: async () => '' }; // nobody has set preferences
    if (url.includes('/config/push-subs')) return json(full('push-subs', {}));
    throw new Error(`unexpected ${url}`);
  };
}

async function round(docs, state = {}) {
  const writes = [], lines = [];
  const real = globalThis.fetch;
  globalThis.fetch = fakeFirestore({
    users: { list: ['Alex', 'Vane', 'Guille'] },
    roles: { admins: ['Alex', 'Vane'] },
    'push-state': { json: JSON.stringify({ logs: new Date(NOW - 60_000).toISOString(), chat: new Date(NOW - 60_000).toISOString(), ...state }) },
    ...docs,
  }, writes);
  try {
    // a dry round: no keys, nothing sent or saved; it prints who would hear what
    // (push-subs is empty, so we read the "(no devices)" lines, which carry the same recipient and text)
    await run({ project: 'mi-gente-preprod', dry: true, ignoreQuiet: true, now: NOW, log: l => lines.push(l) });
  } finally { globalThis.fetch = real; }
  return lines.filter(l => l.startsWith('(no devices)'));
}

test('a new report tells the admins, not the one who sent it', async () => {
  const lines = await round({ [bugId(NOW - 60_000)]: { kind: 'bug', by: 'Vane', text: 'La granja no carga y se queda en blanco', at: NOW - 60_000, resolved: false } });
  assert.deepEqual(lines, ['(no devices) Alex: 🐞 Nuevo fallo de Vane']);
});

test('a report from a non-admin goes to every admin; resolved or old ones tell nobody', async () => {
  const fresh = { kind: 'bug', by: 'Guille', text: 'x', at: NOW - 60_000, resolved: false };
  const lines = await round({
    [bugId(NOW - 60_000)]: fresh,
    [bugId(NOW - 70_000, 'zzzzzz')]: { ...fresh, resolved: true, at: NOW - 70_000 },
    [bugId(NOW - 3 * 86_400_000, 'yyyyyy')]: { ...fresh, at: NOW - 3 * 86_400_000 },
  });
  assert.deepEqual(lines.sort(), ['(no devices) Alex: 🐞 Nuevo fallo de Guille', '(no devices) Vane: 🐞 Nuevo fallo de Guille']);
});

test('a report already told is not told again', async () => {
  const id = bugId(NOW - 60_000);
  const lines = await round({ [id]: { kind: 'bug', by: 'Vane', text: 'x', at: NOW - 60_000, resolved: false } }, { sent: { [`bug:${id}`]: NOW - 30_000 } });
  assert.deepEqual(lines, []);
});
