/**
 * What one bus has cost over its whole life, for the scrap request form (owner's testing notes,
 * 2026-11-11). A VSR's cost is the cost reports' own rule (spendFils): its current invoice once
 * accepted, otherwise nothing, so a declined job or a no-charge job adds AED 0. Declined VSRs are
 * left out of the counts as well.
 */
import { kindOf, spendFils, spendPerKm, toAed } from './reportMaths.js';

export const COST_GROUPS = ['repair', 'maintenance', 'tyre', 'battery', 'accident', 'other'];

// Both shapes of service type land in the same group: before 2026-11-11 transmission was a
// maintenance service, brake pads a service of their own and an accident a repair category; after
// it accident is a service type and transmission and brake pads are repair categories.
const GROUP_OF_KIND = { repair: 'repair', brakePads: 'repair', oil: 'maintenance', transmission: 'maintenance', accident: 'accident', tyre: 'tyre', battery: 'battery' };

/** The group a VSR's cost goes under; anything not known is other work. */
export const costGroupOf = (ticket) => GROUP_OF_KIND[kindOf(ticket)] ?? 'other';

/**
 * The figures for one bus from its VSRs (each with its invoice populated) and its current km.
 * The cost per km has four decimals, as in the cost per bus report, and is null with no km.
 */
export const busCosts = (tickets, currentKm) => {
  const fils = Object.fromEntries(COST_GROUPS.map((group) => [group, 0]));
  const counted = tickets.filter((ticket) => ticket.status !== 'declined');
  counted.forEach((ticket) => {
    fils[costGroupOf(ticket)] += spendFils(ticket);
  });
  const totalFils = COST_GROUPS.reduce((total, group) => total + fils[group], 0);
  const count = (group) => counted.filter((ticket) => costGroupOf(ticket) === group).length;
  return {
    costs: Object.fromEntries(COST_GROUPS.map((group) => [group, toAed(fils[group])])),
    grandTotal: toAed(totalFils),
    repairs: count('repair'),
    accidents: count('accident'),
    vsrs: counted.length,
    currentKm,
    costPerKm: spendPerKm(totalFils, currentKm),
  };
};
