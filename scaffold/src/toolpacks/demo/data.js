/**
 * Brewline synthetic dataset (in-memory, fully fictional).
 * Brewline is an imaginary specialty coffee bean B2B supplier; customers are
 * cafes. Orders/invoices/deliveries are generated with a seeded PRNG so the
 * dataset is stable across runs (dates are relative to "now" for realism).
 * NOT a runtime source of truth for anything real - replace with your backend.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Deterministic LCG so demo numbers are reproducible. */
function createRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

export const customers = [
  { id: 'cus-001', name: 'Blue Finch Cafe', city: 'Portland', tier: 'gold', paymentTermsDays: 30 },
  { id: 'cus-002', name: 'Driftwood Coffee House', city: 'Seattle', tier: 'silver', paymentTermsDays: 30 },
  { id: 'cus-003', name: 'Lantern & Bean', city: 'Austin', tier: 'gold', paymentTermsDays: 45 },
  { id: 'cus-004', name: 'Paper Crane Espresso', city: 'Denver', tier: 'bronze', paymentTermsDays: 14 },
  { id: 'cus-005', name: 'Morning Meadow Cafe', city: 'Chicago', tier: 'silver', paymentTermsDays: 30 },
];

export const suppliers = [
  { id: 'sup-001', name: 'Altiplano Growers Co-op', origin: 'Colombia', onTimeRate: 0.96, cuppingScoreAvg: 86.5 },
  { id: 'sup-002', name: 'Yirga Highlands Collective', origin: 'Ethiopia', onTimeRate: 0.91, cuppingScoreAvg: 88.2 },
  { id: 'sup-003', name: 'Rio Verde Farms', origin: 'Brazil', onTimeRate: 0.81, cuppingScoreAvg: 84.1 },
];

const BEANS = [
  'Ember Ridge Espresso',
  'Cloudline Single Origin',
  'Harbor Fog Blend',
  'Sunrise Decaf',
  'Velvet Peak Omni',
];

function isoDay(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function pad3(n) {
  return String(n).padStart(3, '0');
}

function generate() {
  const rng = createRng(20260101);
  const now = Date.now();
  const orders = [];
  const invoices = [];
  const deliveries = [];

  for (let i = 0; i < 30; i += 1) {
    const customer = customers[Math.floor(rng() * customers.length)];
    const supplier = suppliers[Math.floor(rng() * suppliers.length)];
    const kg = (1 + Math.floor(rng() * 20)) * 5; // 5..100 kg
    const unitPriceUsd = Math.round((14 + rng() * 10) * 100) / 100;
    const totalUsd = Math.round(kg * unitPriceUsd * 100) / 100;
    const orderTs = now - (90 - i * 3) * DAY_MS; // spread across the last ~90 days
    const orderId = `ord-${pad3(i + 1)}`;

    orders.push({
      id: orderId,
      customerId: customer.id,
      supplierId: supplier.id,
      beans: BEANS[Math.floor(rng() * BEANS.length)],
      kg,
      unitPriceUsd,
      totalUsd,
      orderDate: isoDay(orderTs),
    });

    const dueTs = orderTs + customer.paymentTermsDays * DAY_MS;
    const paid = rng() < 0.7;
    invoices.push({
      id: `inv-${pad3(i + 1)}`,
      orderId,
      customerId: customer.id,
      amountUsd: totalUsd,
      issueDate: isoDay(orderTs),
      dueDate: isoDay(dueTs),
      status: paid ? 'paid' : 'unpaid',
      paidDate: paid ? isoDay(Math.min(dueTs, orderTs + 20 * DAY_MS)) : null,
    });

    const roll = rng();
    deliveries.push({
      id: `dlv-${pad3(i + 1)}`,
      orderId,
      customerId: customer.id,
      status: roll < 0.7 ? 'delivered' : roll < 0.9 ? 'in_transit' : 'delayed',
      carrier: roll < 0.5 ? 'Northbound Freight' : 'Cascade Courier',
      eta: isoDay(orderTs + 5 * DAY_MS),
    });
  }

  return { orders, invoices, deliveries };
}

const generated = generate();

export const orders = generated.orders;
export const invoices = generated.invoices;
export const deliveries = generated.deliveries;
/** Mutable on purpose: create_credit_note appends here (demo write path). */
export const creditNotes = [];

export const db = { customers, suppliers, orders, invoices, deliveries, creditNotes };

/** Days between an ISO date and now (positive = in the past). */
export function daysSince(isoDate, now = Date.now()) {
  return Math.floor((now - new Date(`${isoDate}T00:00:00Z`).getTime()) / DAY_MS);
}
