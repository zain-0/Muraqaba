/**
 * The rules a daily km reading meets, typed on the sheet or imported from Excel: an odometer only
 * goes up, and only as far as a bus can drive between two readings.
 */

// A bus covers far less than this in a day; more than it between two readings is a typing slip.
const MOST_KM_A_DAY = 2000;
const READING_MARGIN_KM = 20000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const READING_MESSAGES = {
  lower: 'This is lower than the reading on an earlier day',
  higher: 'This is higher than the reading on a later day',
  farAbove: 'This is far above the earlier reading. Check it.',
};

/**
 * Why `km` on `date` does not fit between the bus's nearest readings before and after it
 * (`{ date, km }` or null): 'lower', 'higher' or 'farAbove'; null when it fits.
 */
export const readingProblem = (date, km, earlier, later) => {
  if (earlier && km < earlier.km) return 'lower';
  if (later && km > later.km) return 'higher';
  if (earlier) {
    const days = (Date.parse(date) - Date.parse(earlier.date)) / DAY_MS;
    if (km - earlier.km > Math.max(READING_MARGIN_KM, days * MOST_KM_A_DAY)) return 'farAbove';
  }
  return null;
};
