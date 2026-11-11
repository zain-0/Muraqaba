/**
 * Owner's testing notes, 2026-11-11: "import from excel option" on the daily km sheet. The service
 * creator uploads an .xlsx in the client's own grid (a row per bus, a header row of dates) or as a
 * list (Side number, Date, Km). A preview says what would change and why anything is refused;
 * importing saves the new and changed readings. Every reading meets the rules typing it would.
 */
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { api, createBus, multipart, run, scrapBus, signInEveryone } from './helpers.js';
import { uaeDay } from '../utils/uaeTime.js';

let users;
const DAY = 24 * 60 * 60 * 1000;
/** A UAE day `n` days from today ('YYYY-MM-DD'), and the same day as an Excel date. */
const d = (n) => uaeDay(new Date(Date.now() + n * DAY));
const excelDate = (day) => new Date(`${day}T00:00:00Z`);
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** An .xlsx built here: `sheets` is { name: rows }. */
const workbook = async (sheets, name = 'km.xlsx') => {
  const wb = new ExcelJS.Workbook();
  Object.entries(sheets).forEach(([sheetName, rows]) => wb.addWorksheet(sheetName).addRows(rows));
  return new File([Buffer.from(await wb.xlsx.writeBuffer())], name, { type: XLSX });
};
const preview = (file, fields = {}, token = users.creator.token) => multipart('/sheets/readings/import/preview', token, fields, file ? [file] : []);
const importFile = (file, fields = {}) => multipart('/sheets/readings/import', users.creator.token, fields, [file]);
const setReading = async (bus, date, km) => {
  const res = await api('PUT', '/sheets/readings', { token: users.creator.token, body: { busId: bus._id, date, km } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
};
const readingsOf = async (bus, month) => (await api('GET', `/sheets/readings?month=${month}`, { token: users.creator.token })).body.data.buses.find((b) => b._id === bus._id)?.readings ?? {};
/** Every saved reading of the bus over the days asked for. */
const savedOn = async (bus, days) => {
  const months = [...new Set(days.map((day) => day.slice(0, 7)))];
  const all = Object.assign({}, ...(await Promise.all(months.map((month) => readingsOf(bus, month)))));
  return Object.fromEntries(days.filter((day) => all[day] !== undefined).map((day) => [day, all[day]]));
};
const reasons = (body) => body.data.refused.map(({ fleetNumber, label, date, km, reason }) => [fleetNumber ?? label, date ?? null, km ?? null, reason]);

describe('importing daily km readings from Excel', () => {
  before(async () => {
    users = await signInEveryone();
  });

  test('only the service creator imports, and only one .xlsx file', async () => {
    const file = await workbook({ Km: [['Bus', excelDate(d(-1))]] });
    assert.equal((await preview(file, {}, users.supervisor.token)).status, 403, 'the supervisor only reads the sheets');
    assert.equal((await preview(file, {}, users.vendor1.token)).status, 403);

    const none = await preview(null);
    assert.equal(none.status, 400);
    assert.deepEqual(none.body.errors[0], { field: 'attachments', message: 'Choose an Excel file (.xlsx) to import' });

    const pdf = await preview(new File(['%PDF-1.4'], 'km.pdf', { type: 'application/pdf' }));
    assert.equal(pdf.status, 400);
    assert.equal(pdf.body.errors[0].message, 'Choose an Excel file (.xlsx). Save an older .xls file as .xlsx first.');

    const broken = await preview(new File(['not a workbook'], 'km.xlsx', { type: XLSX }));
    assert.equal(broken.status, 400);
    assert.equal(broken.body.message, 'This file could not be read as an Excel workbook');

    const nothing = await preview(await workbook({ Notes: [['Nothing here'], ['Still nothing']] }));
    assert.equal(nothing.status, 400);
    assert.equal(nothing.body.message, 'No sheet in this file has a row of dates, or the columns Side number, Date and Km');

    const badMonth = await preview(file, { month: '2026-13' });
    assert.equal(badMonth.status, 400);
    assert.equal(badMonth.body.errors[0].field, 'month');
  });

  test('the client\'s grid: a preview says what would change and why anything is refused, and saves nothing', async () => {
    const plain = await createBus(users, 'IMP1', users.vendor1.id);
    const byPlate = await createBus(users, 'IMP2', users.vendor1.id, { registrationNumber: `7${String(Date.now()).slice(-4)}` });
    const short = await createBus(users, 'IMP3', users.vendor1.id, { fleetNumber: `0-${String(Date.now()).slice(-2)}` });
    const scrapped = await createBus(users, 'IMP4', users.vendor1.id);
    await scrapBus(users, scrapped._id);
    await setReading(plain, d(-3), 900);
    await setReading(plain, d(-2), 1100);

    const days = [d(-3), d(-2), d(-1), d(0), d(1)];
    const file = await workbook({
      'Daily Kms': [
        ['Daily km readings 2026'],
        ['Bus', ...days.map(excelDate), 'Monthly km'],
        // Matched ignoring case and spacing; an unchanged day, a changed one, a word, a typing slip.
        [`  ${plain.fleetNumber.toLowerCase().replace('-', ' - ')} `, 1000, 1100, 'cancel', 90000, 1300],
        // The label as the client writes it: side number, plate, model. The plate finds the bus.
        [`X9 ${byPlate.registrationNumber} Hino Coach`, 5000, 4000, 5200, null, null],
        // "64" is bus 0-64.
        [short.fleetNumber.slice(2), 300, 400, null, 'FIRE', null],
        [scrapped.fleetNumber, null, null, 700, 800, null],
        ['Not a bus we have', 5, 6, null, null, null],
        ['Total', null, null, null, null, null],
      ],
      'Service Due': [['Bus', 'Next service']],
    });

    const res = await preview(file);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const data = res.body.data;
    assert.equal(data.sheet, 'Daily Kms');
    assert.equal(data.layout, 'grid');
    assert.deepEqual(data.counts, { new: 5, changed: 1, unchanged: 1, refused: 5, skipped: 2 });
    assert.deepEqual(data.changed, [{ busId: plain._id, fleetNumber: plain.fleetNumber, date: d(-3), from: 900, to: 1000 }]);
    assert.deepEqual(reasons(res.body).sort(), [
      [byPlate.fleetNumber, d(-2), 4000, 'lower'],
      [plain.fleetNumber, d(0), 90000, 'farAbove'],
      [plain.fleetNumber, d(1), 1300, 'futureDay'],
      [scrapped.fleetNumber, d(0), 800, 'scrapped'],
      ['Not a bus we have', null, null, 'unknownBus'],
    ].sort());
    const unknown = data.refused.find((r) => r.reason === 'unknownBus');
    assert.equal(unknown.row, 7, 'the row in the sheet, counted as Excel does');
    assert.equal(unknown.message, 'No bus matches this side number');
    assert.equal(data.refused.find((r) => r.reason === 'lower').message, 'This is lower than the reading on an earlier day');
    assert.deepEqual([data.firstDay, data.lastDay], [d(-3), d(1)]);

    assert.deepEqual(await savedOn(plain, days), { [d(-3)]: 900, [d(-2)]: 1100 }, 'a preview saves nothing');
    assert.deepEqual(await savedOn(byPlate, days), {});

    // Importing saves the new and changed readings, and nothing refused.
    const saved = await importFile(file);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.data.saved, 6);
    assert.deepEqual(await savedOn(plain, days), { [d(-3)]: 1000, [d(-2)]: 1100 });
    assert.deepEqual(await savedOn(byPlate, days), { [d(-3)]: 5000, [d(-1)]: 5200 });
    assert.deepEqual(await savedOn(short, days), { [d(-3)]: 300, [d(-2)]: 400 });
    assert.deepEqual(await savedOn(scrapped, days), { [d(-1)]: 700 }, 'its days before it was scrapped still take readings');

    // The same file again has nothing new.
    const again = await preview(file);
    assert.deepEqual(again.body.data.counts, { new: 0, changed: 0, unchanged: 7, refused: 5, skipped: 2 });
  });

  test('day numbers in the header need the month they belong to', async () => {
    const bus = await createBus(users, 'IMP5', users.vendor1.id);
    const file = await workbook({ October: [['Bus', 1, 2, 3], [bus.fleetNumber, 100, 150, 210]] });
    const noMonth = await preview(file);
    assert.equal(noMonth.status, 400);
    assert.deepEqual(noMonth.body.errors[0], { field: 'month', message: 'The dates in this sheet are day numbers. Choose the month they belong to.' });

    const res = await importFile(file, { month: '2026-10' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.counts, { new: 3, changed: 0, unchanged: 0, refused: 0, skipped: 0 });
    assert.deepEqual(await readingsOf(bus, '2026-10'), { '2026-10-01': 100, '2026-10-02': 150, '2026-10-03': 210 });
  });

  test('a list with the columns Side number, Date and Km', async () => {
    const bus = await createBus(users, 'IMP6', users.vendor1.id);
    const other = await createBus(users, 'IMP7', users.vendor1.id);
    const file = await workbook({
      Sheet1: [
        ['Side number', 'Date', 'Km'],
        [bus.fleetNumber, excelDate('2026-09-01'), 2000],
        [bus.fleetNumber, '2026-09-02', '2,150'],
        [bus.fleetNumber, '03/09/2026', 2300],
        [bus.fleetNumber, '4-Sep-26', 2400.4],
        [bus.fleetNumber, 'yesterday', 2500],
        [other.fleetNumber, excelDate('2026-09-01'), 10],
        [other.fleetNumber, excelDate('2026-09-01'), 12],
        [other.fleetNumber, excelDate('2026-09-02'), 'scrapping'],
        // 0 is how the client's sheet leaves a day blank, not a reading.
        [other.fleetNumber, excelDate('2026-09-03'), 0],
        [],
      ],
    });
    const res = await preview(file);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.layout, 'list');
    assert.deepEqual(res.body.data.counts, { new: 5, changed: 0, unchanged: 0, refused: 2, skipped: 2 });
    assert.deepEqual(reasons(res.body).sort(), [
      [bus.fleetNumber, null, 2500, 'notADate'],
      [other.fleetNumber, '2026-09-01', 12, 'duplicate'],
    ]);
    await importFile(file);
    assert.deepEqual(await readingsOf(bus, '2026-09'), { '2026-09-01': 2000, '2026-09-02': 2150, '2026-09-03': 2300, '2026-09-04': 2400 }, 'kilometres are whole: a decimal from a formula is rounded');
    assert.deepEqual(await readingsOf(other, '2026-09'), { '2026-09-01': 10 }, 'the first row for a day counts; a second, different one is refused');
  });

  test('readings in the file are checked in date order, with the saved ones around them', async () => {
    const bus = await createBus(users, 'IMP8', users.vendor1.id);
    await setReading(bus, '2026-08-05', 2000);
    const file = await workbook({
      Km: [
        ['Side number', 'Date', 'Km'],
        [bus.fleetNumber, '2026-08-01', 1000],
        [bus.fleetNumber, '2026-08-02', 900], // the slip is this one, not the day before
        [bus.fleetNumber, '2026-08-03', 1100],
        [bus.fleetNumber, '2026-08-04', 2500], // above the saved reading of the day after
        [bus.fleetNumber, '2026-08-06', 2100],
      ],
    });
    const res = await preview(file);
    assert.deepEqual(reasons(res.body).sort(), [
      [bus.fleetNumber, '2026-08-02', 900, 'lower'],
      [bus.fleetNumber, '2026-08-04', 2500, 'higher'],
    ]);
    assert.equal(res.body.data.refused.find((r) => r.reason === 'higher').message, 'This is higher than the reading on a later day');
    await importFile(file);
    assert.deepEqual(await readingsOf(bus, '2026-08'), { '2026-08-01': 1000, '2026-08-03': 1100, '2026-08-05': 2000, '2026-08-06': 2100 });
  });

  test('a changed reading refused keeps the saved one, and nothing before it may pass it', async () => {
    const bus = await createBus(users, 'IMP9', users.vendor1.id);
    await setReading(bus, '2026-07-01', 1000);
    await setReading(bus, '2026-07-03', 1200);
    const file = await workbook({
      Km: [
        ['Side number', 'Date', 'Km'],
        [bus.fleetNumber, '2026-07-02', 1500],
        [bus.fleetNumber, '2026-07-03', 900000], // refused as far above, so 1,200 stays
      ],
    });
    const res = await preview(file);
    assert.deepEqual(reasons(res.body).sort(), [
      [bus.fleetNumber, '2026-07-02', 1500, 'higher'],
      [bus.fleetNumber, '2026-07-03', 900000, 'farAbove'],
    ]);
    assert.deepEqual(res.body.data.counts, { new: 0, changed: 0, unchanged: 0, refused: 2, skipped: 0 });
  });
});
