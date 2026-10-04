// Scheduled PUSH only. Never reads/writes discordRemindersSent or the Discord switches.
import { madridDay, madridHour, madridOffset } from './time.mjs';

const HOUR = 3_600_000;
export const PLAN_REMINDERS = [
  { key: 'before24h', label: '⏰ Mañana', offset: 24 * HOUR, maxLate: 6 * HOUR },
  { key: 'before2h', label: '⏰ En 2 horas', offset: 2 * HOUR, maxLate: 45 * 60_000 },
  { key: 'start', label: '🚨 Empieza ahora', offset: 0, maxLate: 15 * 60_000 },
];
const map = v => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const dateValid = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)
  && Number.isFinite(Date.parse(`${d}T12:00:00Z`)) && new Date(`${d}T12:00:00Z`).toISOString().slice(0, 10) === d;

/** Same validation as the app's normalizeEventLock, including an optional voting range. */
function lockOf(ev) {
  const lock = map(ev?.locked), { date, startHour: s, endHour: e } = lock;
  if (!dateValid(date) || !Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e > 24 || s >= e) return null;
  if (dateValid(ev.startDate) && dateValid(ev.endDate) && (date < ev.startDate || date > ev.endDate)) return null;
  if (Number.isInteger(ev.startHour) && Number.isInteger(ev.endHour) && (s < ev.startHour || e > ev.endHour)) return null;
  return lock;
}

/** Madrid wall hour to UTC, verified by round-trip (rejects the spring DST gap). */
export function lockedStart(ev) {
  const lock = lockOf(ev);
  if (!lock) return null;
  const wall = Date.parse(`${lock.date}T${String(lock.startHour).padStart(2, '0')}:00:00Z`);
  for (const offset of [2, 1]) {
    const t = wall - offset * HOUR;
    if (madridOffset(t) === offset && madridDay(t) === lock.date && madridHour(t) === lock.startHour) return t;
  }
  return null;
}

/** Mirrors lockedResponseStatus: explicit yes wins, legacy selections imply yes, hours must cover the fixed block. */
export function confirmedParticipants(ev, friends) {
  const lock = lockOf(ev);
  if (!lock || ev.archived) return [];
  const people = ev.participants === undefined ? friends : Array.isArray(ev.participants) ? ev.participants : [];
  const availability = map(ev.availability), rsvp = map(ev.rsvpStatus);
  const keys = Array.from({ length: lock.endHour - lock.startHour }, (_, i) => `${lock.date}-${lock.startHour + i}`);
  const slotsOf = name => (Array.isArray(availability[name]) ? availability[name] : []).filter(key => {
    const m = typeof key === 'string' && /^(\d{4}-\d{2}-\d{2})-(\d{1,2})$/.exec(key);
    if (!m || !dateValid(m[1]) || Number(m[2]) > 23) return false;
    return (!dateValid(ev.startDate) || m[1] >= ev.startDate) && (!dateValid(ev.endDate) || m[1] <= ev.endDate)
      && (!Number.isInteger(ev.startHour) || Number(m[2]) >= ev.startHour) && (!Number.isInteger(ev.endHour) || Number(m[2]) < ev.endHour);
  });
  return [...new Set(people)].filter(name => {
    if (typeof name !== 'string' || !friends.includes(name)) return false;
    const slots = slotsOf(name);
    const response = typeof rsvp[name] === 'string' ? rsvp[name].trim().toLowerCase() : '';
    const explicit = ['yes', 'maybe', 'no', 'pending'].includes(response);
    if (explicit ? response !== 'yes' : !slots.length) return false;
    return !slots.length || keys.every(k => slots.includes(k));
  });
}

export function duePlanReminders(ev, now) {
  const startAt = lockedStart(ev);
  if (startAt === null || ev.archived) return [];
  return PLAN_REMINDERS.map(r => ({ key: r.key, label: r.label, startAt, dueAt: startAt - r.offset,
    expiresAt: Math.min(startAt - r.offset + r.maxLate, r.key === 'start' ? Infinity : startAt) }))
    .filter(r => now >= r.dueAt && now < r.expiresAt);
}

/** Queued notices must still be true when sent, not merely when put in the queue. */
export function reminderStillValid(notice, ev, friends, now) {
  if (!ev || !Number.isFinite(notice.expiresAt) || now >= notice.expiresAt) return false;
  if (notice.endHour !== undefined && notice.endHour !== ev.locked?.endHour) return false;
  const due = duePlanReminders(ev, now).find(r => r.key === notice.reminderKey && r.startAt === notice.startAt);
  return !!due && confirmedParticipants(ev, friends).includes(notice.to);
}
