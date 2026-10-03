// What people can switch off (config/push-prefs). Every notice the round makes has a kind, and every kind belongs to one
// category: the person's choice is per category. The app (src/lib/pushPrefs.ts) lists the same category ids with their
// labels; a test there and a test here (test/prefs.test.mjs) keep the two honest.
//
//   config/push-prefs = { [name]: { [category]: false } }
//
// Only what is switched off is stored: a person or a category that is not there is on, so everyone keeps getting
// everything until they change something. «Probar avisos» (kind 'test') has no category: a test always gets through.

/** The categories, in the order the app shows them. */
export const CATEGORIES = ['planes', 'recordatorios', 'chat', 'toques', 'tarde', 'cabrita', 'carreras', 'novedades', 'fallos'];

/** Each kind of notice and the category it belongs to. */
export const KIND_CATEGORY = {
  'plan:create': 'planes',          // «ha creado un plan»
  'plan:lock': 'planes',            // «Hora fijada»
  'plan:postpone': 'planes',        // «ha aplazado un plan»
  'plan:dates': 'planes',           // «ha cambiado las fechas»
  'plan:nudge': 'recordatorios',    // «te recuerda un plan»
  'plan:nudge-maybe': 'recordatorios', // «pide que confirmes»
  'late': 'tarde',                  // «llega tarde»
  'chat': 'chat',
  'poke': 'toques',                 // zumbidos that arrived while they were away
  'farm:need': 'cabrita',           // hungry, sad
  'farm:energy': 'cabrita',         // full of energy again
  'farm:box': 'cabrita',
  'farm:gift': 'cabrita',
  'farm:trip': 'cabrita',
  'farm:streak': 'cabrita',
  'farm:event': 'cabrita',          // an event on the farm: starts, last day
  'race': 'carreras',               // (no notice of this kind is sent yet)
  'app-update': 'novedades',
  'bug': 'fallos',                  // admins only
};

/** The category of a kind; undefined for a kind with none (a test, or an old queued notice) which is never muted. */
export const categoryOf = kind => Object.hasOwn(KIND_CATEGORY, kind) ? KIND_CATEGORY[kind] : undefined;

/** Whether `person` wants a notice of this kind: unless that person's category is switched off, yes. */
export function wants(prefs, person, kind) {
  const category = categoryOf(kind);
  if (!category || !prefs || !Object.hasOwn(prefs, person)) return true;
  const mine = prefs[person];
  return !(mine && typeof mine === 'object' && mine[category] === false);
}
