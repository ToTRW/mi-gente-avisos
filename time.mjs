// Madrid's calendar, shared by scheduled plan reminders and the rest of the round.
const lastSunday = (year, month) => { const end = Date.UTC(year, month + 1, 0); return end - new Date(end).getUTCDay() * 86_400_000; };
export function madridOffset(t) {
  const year = new Date(t).getUTCFullYear();
  return t >= lastSunday(year, 2) + 3_600_000 && t < lastSunday(year, 9) + 3_600_000 ? 2 : 1;
}
const madrid = t => new Date(t + madridOffset(t) * 3_600_000);
export const madridDay = t => madrid(t).toISOString().slice(0, 10);
export const madridHour = t => madrid(t).getUTCHours();
