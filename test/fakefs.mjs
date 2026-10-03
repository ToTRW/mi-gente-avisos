// A stand-in for the app's Firestore (REST) that the tests share: the config and presence collections, answering the
// request shapes the Worker uses (a single get, batchGet, and runQuery with a filter and a field list) and counting
// the reads Firestore would bill. It is strict on purpose: a field the Worker did not ask for in its mask or select
// does not come back, a query filters like the real one, and listing a whole collection throws (that is what a round
// must never do again).
//
//   const fs = firestoreStand();
//   fs.config.users = { list: ['Alex'] };            // config/users (undefined or absent = does not exist)
//   fs.presence.Vane = { missed: { Alex: 1 } };      // presence/Vane
//   fs.updateTimes['push-test'] = '2026-10-02T...';  // a document's updateTime, when a test needs it
//   const r = fs.handle(url, init);                  // a Response-like, or undefined when it is not for config/presence
//   fs.reads                                         // documents billed so far (reset with fs.reads = 0)

const DOCS = 'projects/p/databases/(default)/documents';

/** A JS value in Firestore's REST encoding ({ $ts: iso } is a timestamp; undefined entries of a map are left out). */
export const enc = v => v === null ? { nullValue: null }
  : v && v.$ts ? { timestampValue: v.$ts }
  : typeof v === 'string' ? { stringValue: v }
  : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v })
  : typeof v === 'boolean' ? { booleanValue: v }
  : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } }
  : { mapValue: { fields: Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, enc(x)])) } };
/** A document as Firestore sends it. */
export const docOf = (path, o, updateTime) => ({ name: `${DOCS}/${path}`, fields: enc(o).mapValue.fields, ...(updateTime ? { updateTime } : {}) });
const plain = v => 'stringValue' in v ? v.stringValue : 'integerValue' in v ? Number(v.integerValue) : 'doubleValue' in v ? v.doubleValue : 'booleanValue' in v ? v.booleanValue : null;

const json = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const notFound = { ok: false, status: 404, json: async () => ({}), text: async () => '' };
const keep = (o, paths) => paths.length ? Object.fromEntries(Object.entries(o).filter(([k]) => paths.includes(k))) : o;

/** Whether the document `o` passes a structured query's filter (top-level fields only, which is all the Worker filters on). */
function passes(o, filter) {
  if (!filter) return true;
  if (filter.compositeFilter) return filter.compositeFilter.filters.every(f => passes(o, f));
  if (filter.unaryFilter) {
    const v = o[filter.unaryFilter.field.fieldPath];
    if (filter.unaryFilter.op === 'IS_NOT_NULL') return v !== undefined && v !== null;
    throw new Error(`the stand-in does not know ${filter.unaryFilter.op}`);
  }
  const { field, op, value } = filter.fieldFilter, have = o[field.fieldPath], want = plain(value);
  if (op === 'EQUAL') return have === want;
  if (typeof have !== typeof want || have === undefined) return false; // a range only matches the same kind of value
  if (op === 'GREATER_THAN') return have > want;
  if (op === 'GREATER_THAN_OR_EQUAL') return have >= want;
  throw new Error(`the stand-in does not know ${op}`);
}

export function firestoreStand() {
  const fs = { config: {}, presence: {}, updateTimes: {}, reads: 0 };
  const table = collection => fs[collection];
  const exists = (collection, id) => table(collection) && table(collection)[id] !== undefined;
  const full = (collection, id, paths) => docOf(`${collection}/${id}`, keep(table(collection)[id], paths), collection === 'config' ? fs.updateTimes[id] : undefined);

  fs.handle = (url, init = {}) => {
    url = String(url);
    if (!/\/documents/.test(url)) return undefined;
    const path = url.split('/documents')[1] ?? '';
    // listing a whole collection is what the Worker no longer does
    if (!init.method && /^\/(config|presence)(\?|$)/.test(path)) throw new Error(`a round listed the whole ${path.split(/[?]/)[0].slice(1)} collection`);
    if (path.startsWith(':batchGet')) {
      const body = JSON.parse(init.body), paths = body.mask?.fieldPaths || [];
      return json(body.documents.map(name => {
        const [collection, id] = name.split('/documents/')[1].split('/');
        fs.reads++; // a document that is not there is billed as well
        return exists(collection, id) ? { found: full(collection, id, paths), readTime: 'T' } : { missing: name, readTime: 'T' };
      }));
    }
    if (path.startsWith(':runQuery')) {
      const q = JSON.parse(init.body).structuredQuery, collection = q.from[0].collectionId;
      if (collection !== 'config' && collection !== 'presence') return undefined; // activityLogs and messages are the test's own
      const paths = (q.select?.fields || []).map(f => f.fieldPath);
      const ids = Object.keys(table(collection)).filter(id => table(collection)[id] !== undefined && passes(table(collection)[id], q.where)).sort();
      fs.reads += Math.max(1, ids.length); // a query that finds nothing is billed one read
      return json(ids.length ? ids.map(id => ({ document: full(collection, id, paths), readTime: 'T' })) : [{ readTime: 'T' }]);
    }
    const one = path.match(/^\/(config|presence)\/([^/?]+)/);
    if (one && !init.method) {
      fs.reads++;
      return exists(one[1], one[2]) ? json(full(one[1], one[2], [])) : notFound;
    }
    return undefined;
  };
  return fs;
}
