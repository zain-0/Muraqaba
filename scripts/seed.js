/**
 * Seeds a development database with one account per role, two vendors, a small fleet,
 * repair requests, and tickets at every stage of the lifecycle so each dashboard has data.
 *
 *   npm run seed          # adds demo data if the demo accounts do not exist yet
 *   npm run seed:reset    # wipes users, buses, tickets, invoices and repair requests first
 *
 * All demo accounts share the password in SEED_PASSWORD (default: Password123!).
 */
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import config from '../config/config.js';
import connectDB from '../config/db.js';
import User from '../models/User.js';
import Bus from '../models/Bus.js';
import Ticket from '../models/Ticket.js';
import Invoice from '../models/Invoice.js';
import RepairRequest from '../models/RepairRequest.js';

const PASSWORD = process.env.SEED_PASSWORD || 'Password123!';
const reset = process.argv.includes('--reset');

const ACCOUNTS = [
  { name: 'Sara Ahmed', email: 'creator@muraqaba.dev', role: 'serviceCreator' },
  { name: 'Omar Farooq', email: 'supervisor@muraqaba.dev', role: 'supervisor' },
  { name: 'Hina Raza', email: 'purchasing@muraqaba.dev', role: 'purchaseManager' },
  { name: 'Al Noor Motors', email: 'vendor@muraqaba.dev', role: 'vendor' },
  { name: 'Metro Fleet Services', email: 'vendor2@muraqaba.dev', role: 'vendor' },
];

const part = (serviceKm, currentKm) => ({ serviceKm, currentKm });

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

async function main() {
  if (config.isProduction && !process.env.SEED_ALLOW_PRODUCTION) {
    throw new Error('Refusing to seed a production database. Set SEED_ALLOW_PRODUCTION=1 to override.');
  }
  await connectDB({ maxAttempts: 3 });

  if (reset) {
    await Promise.all([User, Bus, Ticket, Invoice, RepairRequest].map((M) => M.deleteMany({})));
    console.log('Cleared existing data');
  } else if (await User.exists({ email: ACCOUNTS[0].email })) {
    console.log('Demo accounts already exist. Run with --reset to recreate everything.');
    await mongoose.connection.close();
    return;
  }

  const hashed = await bcrypt.hash(PASSWORD, config.bcryptRounds);
  const users = {};
  for (const account of ACCOUNTS) {
    users[account.email] = await User.create({ ...account, password: hashed });
  }
  const creator = users['creator@muraqaba.dev'];
  const supervisor = users['supervisor@muraqaba.dev'];
  const vendor1 = users['vendor@muraqaba.dev'];
  const vendor2 = users['vendor2@muraqaba.dev'];

  const buses = await Bus.create([
    {
      fleetNumber: 'BUS-101', chassisNumber: 'CH-101-AX', registrationNumber: 'LEA-1011', make: 'Hino', model: 'RK8J', year: 2019,
      engine: part(15000, 14200), ac: part(10000, 3200), tyre: part(40000, 38900), transmission: part(60000, 21000), brakePad: part(20000, 20500),
      vendor: vendor1._id,
    },
    {
      fleetNumber: 'BUS-102', chassisNumber: 'CH-102-BX', registrationNumber: 'LEA-1022', make: 'Yutong', model: 'ZK6122', year: 2021,
      engine: part(15000, 4000), ac: part(10000, 9800), tyre: part(40000, 12000), transmission: part(60000, 8000), brakePad: part(20000, 6000),
      vendor: vendor1._id,
    },
    {
      fleetNumber: 'BUS-103', chassisNumber: 'CH-103-CX', registrationNumber: 'LEA-1033', make: 'Isuzu', model: 'LT134', year: 2018,
      engine: part(15000, 7600), ac: part(10000, 500), tyre: part(40000, 31000), transmission: part(60000, 59000), brakePad: part(20000, 11000),
      vendor: vendor2._id,
    },
    {
      fleetNumber: 'BUS-104', chassisNumber: 'CH-104-DX', registrationNumber: 'LEA-1044', make: 'Hino', model: 'AK1J', year: 2022,
      engine: part(15000, 1200), ac: part(10000, 800), tyre: part(40000, 2500), transmission: part(60000, 1200), brakePad: part(20000, 900),
      vendor: vendor2._id,
    },
  ]);
  const [bus101, bus102, bus103, bus104] = buses;

  /** Create a ticket and replay its lifecycle up to `stage`. */
  const makeTicket = async ({ bus, serviceType, repairCategory, description, stage, createdDaysAgo, amount }) => {
    const ticket = new Ticket({
      busId: bus._id,
      serviceType,
      repairCategory,
      description,
      vendorId: bus.vendor,
      createdBy: creator._id,
      createdAt: daysAgo(createdDaysAgo),
    });
    const vendor = String(bus.vendor) === String(vendor1._id) ? vendor1 : vendor2;
    let t = createdDaysAgo;
    const step = (status, by, note) => {
      t -= 1;
      ticket.transition(status, by._id, note);
      ticket.history[ticket.history.length - 1].at = daysAgo(Math.max(t, 0));
    };
    ticket.history.push({ status: 'pending', by: creator._id, note: 'Ticket created', at: daysAgo(createdDaysAgo) });

    const order = ['pending', 'approved', 'acknowledged', 'invoiceSubmitted', 'invoiceRejected', 'resubmitted', 'invoiceAccepted', 'completed'];
    const target = order.indexOf(stage);
    if (target >= 1) step('approved', supervisor);
    if (target >= 2) step('acknowledged', vendor);
    if (target >= 3) {
      const inv = await Invoice.create({ ticketId: ticket._id, vendorId: vendor._id, amount, description: `Work completed on ${bus.fleetNumber}`, invoiceNumber: `INV-${bus.fleetNumber}-1` });
      ticket.invoice = inv._id;
      step('invoiceSubmitted', vendor, `Invoice ${inv.invoiceNumber}`);
      if (target >= 4) {
        inv.status = 'rejected';
        inv.rejectedBy = supervisor._id;
        inv.rejectedAt = daysAgo(Math.max(t - 1, 0));
        inv.rejectionReason = 'Labour hours look too high for this job. Please itemise.';
        await inv.save();
        step('invoiceRejected', supervisor, inv.rejectionReason);
      }
      if (target >= 5) {
        const inv2 = await Invoice.create({ ticketId: ticket._id, vendorId: vendor._id, amount: Math.round(amount * 0.85), description: `Itemised invoice for ${bus.fleetNumber}`, invoiceNumber: `INV-${bus.fleetNumber}-2` });
        ticket.invoice = inv2._id;
        step('invoiceSubmitted', vendor, `Invoice ${inv2.invoiceNumber}`);
      }
      if (target >= 6) {
        const current = await Invoice.findById(ticket.invoice);
        current.status = 'approved';
        current.approvedBy = supervisor._id;
        current.approvedAt = daysAgo(Math.max(t - 1, 0));
        await current.save();
        step('invoiceAccepted', supervisor);
      }
      if (target >= 7) step('completed', vendor);
    }
    await ticket.save();
    return ticket;
  };

  await makeTicket({ bus: bus101, serviceType: 'repair', repairCategory: 'BATTERY REPLACEMENT', description: 'Bus failed to start twice this week; battery not holding charge.', stage: 'pending', createdDaysAgo: 1 });
  await makeTicket({ bus: bus102, serviceType: 'minor', description: 'Scheduled minor service: oil, filters, fluid top-up.', stage: 'approved', createdDaysAgo: 3 });
  await makeTicket({ bus: bus103, serviceType: 'repair', repairCategory: 'AC REPAIR', description: 'Rear AC unit blowing warm air on afternoon routes.', stage: 'acknowledged', createdDaysAgo: 5 });
  await makeTicket({ bus: bus101, serviceType: 'major', description: 'Major service at 14,000 km: engine, transmission inspection, brake pads.', stage: 'invoiceSubmitted', createdDaysAgo: 9, amount: 185000 });
  await makeTicket({ bus: bus104, serviceType: 'repair', repairCategory: 'ELECTRICAL', description: 'Dashboard warning lights flickering intermittently.', stage: 'invoiceRejected', createdDaysAgo: 12, amount: 42000 });
  await makeTicket({ bus: bus103, serviceType: 'repair', repairCategory: 'TYRE REPLACEMENT', description: 'Replace both rear tyres, tread below legal limit.', stage: 'invoiceAccepted', createdDaysAgo: 15, amount: 96000 });
  await makeTicket({ bus: bus102, serviceType: 'other', description: 'Interior deep clean and seat repairs after charter.', stage: 'completed', createdDaysAgo: 20, amount: 28000 });
  await makeTicket({ bus: bus104, serviceType: 'minor', description: 'First minor service for new vehicle.', stage: 'completed', createdDaysAgo: 30, amount: 35000 });

  await RepairRequest.create([
    { busId: bus101._id, vendorId: vendor1._id, repairCategory: 'MECHANICAL', description: 'Grinding noise from the front axle under braking; needs inspection before weekend routes.' },
    { busId: bus103._id, vendorId: vendor2._id, repairCategory: 'BODY', description: 'Rear bumper cracked after depot reversing incident; water getting into the engine bay.' },
    { busId: bus102._id, vendorId: vendor1._id, repairCategory: 'ENGINE', description: 'Coolant level dropping every two days, possible hose leak.', status: 'rejected', rejectedBy: creator._id, rejectedAt: daysAgo(4), resolutionNote: 'Covered by the upcoming minor service.' },
  ]);

  console.log('\nSeed complete. Demo accounts (password: %s):', PASSWORD);
  ACCOUNTS.forEach((a) => console.log(`  ${a.role.padEnd(16)} ${a.email}`));
  console.log(`\nBuses: ${buses.length}, tickets: ${await Ticket.countDocuments()}, repair requests: ${await RepairRequest.countDocuments()}`);
  await mongoose.connection.close();
}

main().catch(async (err) => {
  console.error('Seed failed:', err.message);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
