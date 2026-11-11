/**
 * Daily km readings from an Excel workbook (owner's testing notes, 2026-11-11). Two layouts:
 *
 * - the client's own grid: a row per bus with its label in the first column, under a header row of
 *   dates (Excel dates or text such as 21-Jan-26; day numbers when the month is given);
 * - a list with the columns Side number, Date and Km.
 *
 * Labels match side numbers ignoring case and spacing, as the client's own sheets spell them: the
 * label may be "side plate model", where the plate finds the bus, and "64" is bus 0-64. Words such
 * as cancel, fire or scrapping, and 0, hold no reading and are skipped. Every reading meets the
 * rules typing it would, checked in date order against the bus's saved readings.
 */
import ExcelJS from 'exceljs';
import mongoose from 'mongoose';
import Bus from '../models/Bus.js';
import { BusDailyReading } from '../models/BusDaily.js';
import { AppError } from '../middleware/errorMiddleware.js';
import { READING_MESSAGES, readingProblem } from './readingRules.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// Rows looked at for a header; the client's grid has a title or two above it.
const HEADER_ROWS = 20;
// The preview lists this many changed and refused readings; the counts cover all of them.
const LISTED = 500;

export const REFUSAL_MESSAGES = {
  unknownBus: 'No bus matches this side number',
  futureDay: 'A day in the future cannot be changed',
  scrapped: 'This bus is scrapped from this day',
  notADate: 'This is not a date',
  notAReading: 'This is not a km reading',
  duplicate: 'Another row gives this bus a different reading for this day',
  ...READING_MESSAGES,
};

const importError = (message, field) => new AppError(message, 400, 'VALIDATION_ERROR', field ? [{ field, message }] : undefined);

// --- Cells ----------------------------------------------------------------------------------------

/** What a cell holds, with formulas, rich text and links read as their value. */
const plain = (value) => {
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    if ('result' in value) return plain(value.result);
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text).join('');
    if ('text' in value) return value.text;
    return null; // an error such as #REF!
  }
  return value ?? null;
};

const realDay = (year, month, day) => {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date.toISOString().slice(0, 10) : null;
};
// A minute's slack: Excel keeps dates as fractions of a day, which can land just short of midnight.
const dayOfDate = (date) => (Number.isNaN(date.getTime()) ? null : new Date(date.getTime() + 60000).toISOString().slice(0, 10));
const fromSerial = (serial) => dayOfDate(new Date(Math.round((serial - 25569) * DAY_MS)));
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** A day from text: 2026-10-01, 01/10/2026 (day first, as in the UAE) or 1-Oct-26. */
const dayOfText = (text) => {
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (m) return realDay(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(text);
  if (m) return realDay(+m[3], +m[2], +m[1]);
  m = /^(\d{1,2})[-\s]([a-z]{3})[a-z]*[-\s](\d{2}|\d{4})$/i.exec(text);
  if (m && MONTHS.includes(m[2].toLowerCase())) return realDay(m[3].length === 2 ? 2000 + +m[3] : +m[3], MONTHS.indexOf(m[2].toLowerCase()) + 1, +m[1]);
  return null;
};

/** The day a cell holds: an Excel date, a number formatted as one, or text. */
const dayOfCell = (cell) => {
  const value = plain(cell.value);
  if (value instanceof Date) return dayOfDate(value);
  if (typeof value === 'string') return dayOfText(value.trim());
  if (typeof value === 'number' && /[dy]/i.test(cell.numFmt ?? '') && value > 0) return fromSerial(value);
  return null;
};

/** A day number of the month (1 to 31) in a header cell. */
const dayNumberOf = (cell) => {
  const value = plain(cell.value);
  return Number.isInteger(value) && value >= 1 && value <= 31 ? value : null;
};

/**
 * What a km cell holds: nothing, a word or 0 (no reading: skipped), a reading in whole km (a
 * decimal from a formula is rounded), or a number that cannot be one.
 */
const readingOf = (cell) => {
  const value = plain(cell.value);
  if (value === null || value === '') return { kind: 'empty' };
  let km = null;
  if (typeof value === 'number') km = value;
  else if (typeof value === 'string' && /^\s*-?[\d,]+(\.\d+)?\s*$/.test(value)) km = Number(value.replace(/[,\s]/g, ''));
  else if (typeof value === 'string' && !value.trim()) return { kind: 'empty' };
  if (km === null || km === 0) return { kind: 'skip' };
  if (!Number.isFinite(km) || km < 0 || km > 1e12) return { kind: 'bad', value: String(value) };
  return { kind: 'km', km: Math.round(km) };
};

const textOf = (cell) => {
  const value = plain(cell.value);
  return value === null ? '' : String(value instanceof Date ? dayOfDate(value) : value).trim();
};

// --- Buses ----------------------------------------------------------------------------------------

const key = (text) => String(text).toLowerCase().replace(/\s+/g, '');
const LABEL = /^\s*(\S+?)\s+(\d{5})(?:\s|$)/;
// The "0-" prefix only sorts the client's old buses first; its sheets often drop it ("64" is bus 0-64).
const sideNumber = (text) => (/^\d{1,2}$/.test(text) ? `0-${text}` : text);

/** Finds the bus a label names: its side number, or "side plate model" as the client's sheets write it. */
export const busMatcher = (buses) => {
  const byFleet = new Map(buses.map((bus) => [key(bus.fleetNumber), bus]));
  const byPlate = new Map(buses.filter((bus) => bus.registrationNumber).map((bus) => [key(bus.registrationNumber), bus]));
  const fleet = (side) => byFleet.get(key(sideNumber(side.trim())));
  return (label) => {
    const text = String(label ?? '').trim();
    if (!text) return null;
    const whole = fleet(text);
    if (whole) return whole;
    const m = LABEL.exec(text);
    if (m) return (m[2] !== '00000' && byPlate.get(m[2])) || fleet(m[1]) || null;
    return fleet(text.split(/\s+/)[0]) ?? null;
  };
};

// --- Layouts --------------------------------------------------------------------------------------

const LIST_COLUMNS = {
  side: /^(side\s*(no\.?|number)|bus|fleet\s*(no\.?|number))$/i,
  date: /^(date|day)$/i,
  km: /^(km|kms|km reading|reading|odometer)$/i,
};

/** The list layout's header: the row and the column of each of Side number, Date and Km. */
const listHeader = (sheet) => {
  for (let r = 1; r <= Math.min(HEADER_ROWS, sheet.rowCount); r += 1) {
    const columns = {};
    sheet.getRow(r).eachCell((cell, col) => {
      const text = textOf(cell);
      Object.entries(LIST_COLUMNS).forEach(([name, pattern]) => {
        if (!columns[name] && pattern.test(text)) columns[name] = col;
      });
    });
    if (columns.side && columns.date && columns.km) return { row: r, columns };
  }
  return null;
};

/**
 * The grid's header row and the day of each of its date columns. With `month`, a row of day
 * numbers counts too; without it, such a row is reported so the dialog can ask for the month.
 */
const gridHeader = (sheet, month) => {
  let dayNumbersAt = null;
  for (let r = 1; r <= Math.min(HEADER_ROWS, sheet.rowCount); r += 1) {
    const days = new Map();
    const numbers = [];
    sheet.getRow(r).eachCell((cell, col) => {
      if (col === 1) return;
      const day = dayOfCell(cell);
      if (day) days.set(col, day);
      const number = dayNumberOf(cell);
      if (number) numbers.push([col, number]);
    });
    if (days.size) return { row: r, days };
    const increasing = numbers.length >= 2 && numbers.every(([, n], i) => i === 0 || n > numbers[i - 1][1]);
    if (increasing && !dayNumbersAt) dayNumbersAt = { row: r, numbers };
  }
  if (!dayNumbersAt) return null;
  if (!month) return { needsMonth: true };
  const [year, monthNumber] = month.split('-').map(Number);
  const days = new Map(dayNumbersAt.numbers.map(([col, n]) => [col, realDay(year, monthNumber, n)]).filter(([, day]) => day));
  return { row: dayNumbersAt.row, days };
};

/** The first sheet in a layout we read, with its readings as `{ row, label, date, cell }`. */
const readSheet = (workbook, month) => {
  let needsMonth = false;
  for (const sheet of workbook.worksheets) {
    const list = listHeader(sheet);
    if (list) {
      const entries = [];
      sheet.eachRow((row, r) => {
        if (r <= list.row) return;
        const { side, date, km } = list.columns;
        entries.push({ row: r, label: textOf(row.getCell(side)), date: dayOfCell(row.getCell(date)), cell: row.getCell(km) });
      });
      return { sheet: sheet.name, layout: 'list', entries };
    }
    const grid = gridHeader(sheet, month);
    if (grid?.needsMonth) needsMonth = true;
    else if (grid) {
      const entries = [];
      sheet.eachRow((row, r) => {
        if (r <= grid.row) return;
        const label = textOf(row.getCell(1));
        grid.days.forEach((date, col) => entries.push({ row: r, label, date, cell: row.getCell(col) }));
      });
      return { sheet: sheet.name, layout: 'grid', entries };
    }
  }
  if (needsMonth) throw importError('The dates in this sheet are day numbers. Choose the month they belong to.', 'month');
  throw importError('No sheet in this file has a row of dates, or the columns Side number, Date and Km');
};

// --- Checks ---------------------------------------------------------------------------------------

/**
 * One bus's readings from the file, checked as if typed in date order: against the saved reading
 * before it or a reading from the file accepted before it, and the saved reading after it. A refused
 * reading that would have replaced a saved one leaves that one in place, so the readings are checked
 * again with it until nothing more is refused.
 */
const checkBus = (saved, incoming) => {
  const kept = new Map(); // day -> why the file's reading was refused, where the saved one stays
  for (;;) {
    const touched = new Set(incoming.filter((r) => !kept.has(r.date)).map((r) => r.date));
    const untouched = [...saved].filter(([day]) => !touched.has(day)).map(([date, km]) => ({ date, km })).sort((a, b) => a.date.localeCompare(b.date));
    const accepted = [];
    const refused = [];
    let next = 0; // the first untouched reading after the day being checked
    let lastAccepted = null;
    for (const reading of incoming) {
      while (next < untouched.length && untouched[next].date < reading.date) next += 1;
      if (kept.has(reading.date)) {
        refused.push({ ...reading, reason: kept.get(reading.date) });
        continue;
      }
      const savedBefore = next > 0 ? untouched[next - 1] : null;
      const earlier = lastAccepted && (!savedBefore || lastAccepted.date > savedBefore.date) ? lastAccepted : savedBefore;
      const problem = readingProblem(reading.date, reading.km, earlier, untouched[next] ?? null);
      if (problem) refused.push({ ...reading, reason: problem });
      else {
        accepted.push(reading);
        lastAccepted = reading;
      }
    }
    const newlyKept = refused.filter((r) => saved.has(r.date) && !kept.has(r.date));
    if (!newlyKept.length) return { accepted, refused };
    newlyKept.forEach((r) => kept.set(r.date, r.reason));
  }
};

const refusal = ({ row, bus, label, date, km }, reason) => ({
  row,
  ...(bus ? { busId: String(bus._id), fleetNumber: bus.fleetNumber } : { label }),
  ...(date ? { date } : {}),
  ...(km !== undefined ? { km } : {}),
  reason,
  message: REFUSAL_MESSAGES[reason],
});

/**
 * Reads the workbook and works out what importing it would do, writing nothing: counts, the changed
 * and refused readings (the first LISTED of each), and `toSave`, the new and changed readings.
 */
export const planReadingImport = async (buffer, { month, today }) => {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw importError('This file could not be read as an Excel workbook', 'attachments');
  }
  const { sheet, layout, entries } = readSheet(workbook, month);

  const buses = await Bus.find().select('fleetNumber registrationNumber lifecycle scrappedOn sale.date').lean();
  const busOf = busMatcher(buses);
  const refused = [];
  let skipped = 0;
  const days = [];
  const unknownRows = new Set();
  const seen = new Map(); // bus|day -> km, the first time the file gives it
  const byBus = new Map();

  for (const entry of entries) {
    const cell = readingOf(entry.cell);
    if (cell.kind === 'empty') continue;
    const bus = busOf(entry.label);
    if (!bus) {
      // One refusal per row: a row the sheet has for something else names no bus at all.
      if (cell.kind === 'skip' || unknownRows.has(entry.row)) continue;
      unknownRows.add(entry.row);
      refused.push(refusal({ row: entry.row, label: entry.label, ...(layout === 'list' ? { date: entry.date, km: cell.km } : {}) }, 'unknownBus'));
      continue;
    }
    if (cell.kind === 'skip') {
      skipped += 1;
      continue;
    }
    const reading = { row: entry.row, bus, date: entry.date, km: cell.km };
    if (cell.kind === 'bad') {
      refused.push(refusal({ ...reading, km: undefined }, 'notAReading'));
      continue;
    }
    if (!entry.date) {
      refused.push(refusal(reading, 'notADate'));
      continue;
    }
    days.push(entry.date);
    const scrappedFrom = ['scrapped', 'sold'].includes(bus.lifecycle) ? bus.scrappedOn ?? bus.sale?.date : null;
    if (entry.date > today) refused.push(refusal(reading, 'futureDay'));
    else if (scrappedFrom && entry.date >= scrappedFrom) refused.push(refusal(reading, 'scrapped'));
    else {
      const id = `${bus._id}|${entry.date}`;
      if (seen.has(id)) {
        if (seen.get(id) !== cell.km) refused.push(refusal(reading, 'duplicate'));
        continue;
      }
      seen.set(id, cell.km);
      if (!byBus.has(String(bus._id))) byBus.set(String(bus._id), []);
      byBus.get(String(bus._id)).push(reading);
    }
  }

  const savedReadings = await BusDailyReading.find({ bus: mongoose.trusted({ $in: [...byBus.keys()] }) }).select('bus date km').lean();
  const savedByBus = new Map();
  savedReadings.forEach(({ bus, date, km }) => {
    if (!savedByBus.has(String(bus))) savedByBus.set(String(bus), new Map());
    savedByBus.get(String(bus)).set(date, km);
  });

  const counts = { new: 0, changed: 0, unchanged: 0, refused: 0, skipped };
  const changed = [];
  const toSave = [];
  byBus.forEach((readings, busId) => {
    const saved = savedByBus.get(busId) ?? new Map();
    const incoming = readings.filter((r) => saved.get(r.date) !== r.km).sort((a, b) => a.date.localeCompare(b.date));
    counts.unchanged += readings.length - incoming.length;
    const result = checkBus(saved, incoming);
    result.refused.forEach((r) => refused.push(refusal(r, r.reason)));
    result.accepted.forEach((r) => {
      toSave.push({ bus: r.bus._id, date: r.date, km: r.km });
      if (saved.has(r.date)) {
        counts.changed += 1;
        changed.push({ busId, fleetNumber: r.bus.fleetNumber, date: r.date, from: saved.get(r.date), to: r.km });
      } else counts.new += 1;
    });
  });
  counts.refused = refused.length;

  const byRow = (a, b) => a.row - b.row || (a.date ?? '').localeCompare(b.date ?? '');
  const sortedDays = days.sort();
  return {
    sheet,
    layout,
    firstDay: sortedDays[0] ?? null,
    lastDay: sortedDays.at(-1) ?? null,
    counts,
    changed: changed.sort((a, b) => a.fleetNumber.localeCompare(b.fleetNumber) || a.date.localeCompare(b.date)).slice(0, LISTED),
    refused: refused.sort(byRow).slice(0, LISTED),
    toSave,
  };
};
