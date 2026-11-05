/**
 * The depot works on UAE time. The UAE is UTC+4 all year with no daylight saving, so a
 * fixed offset is enough, and a day is stored as plain 'YYYY-MM-DD' so it can never shift.
 */
const UAE_OFFSET_MS = 4 * 60 * 60 * 1000;

export const uaeDay = (when = new Date()) => new Date(when.getTime() + UAE_OFFSET_MS).toISOString().slice(0, 10);

export const uaeMonth = (when = new Date()) => uaeDay(when).slice(0, 7);

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole UAE calendar days from the day of `from` to the day of `when`; negative once it has passed. */
export const uaeDaysUntil = (when, from = new Date()) => (Date.parse(uaeDay(when)) - Date.parse(uaeDay(from))) / DAY_MS;

/** Every day of a 'YYYY-MM' month. */
export const daysInMonth = (month) => {
  const [year, monthNumber] = month.split('-').map(Number);
  const count = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
};

export const endOfUaeDay = (day) => new Date(`${day}T23:59:59.999+04:00`);

export const startOfUaeDay = (day) => new Date(`${day}T00:00:00.000+04:00`);
