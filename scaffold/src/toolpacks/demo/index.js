/**
 * Brewline demo toolpack: 7 read tools (summary/raw dual mode) + 1 write tool
 * (create_credit_note, gated by the human confirm-gate).
 * This is the template to copy when wiring a real backend: keep the same
 * shape, but let handlers call your APIs (BACKEND_URL / BACKEND_API_KEY from
 * config) instead of the in-memory dataset.
 */
import { defineTool } from '../../runtime/tool.js';
import { wrapWriteTool } from '../../guardrails/confirm-gate.js';
import { withScope } from '../../guardrails/scoped-tool.js';
import { customers, suppliers, orders, invoices, deliveries, creditNotes, db, daysSince } from './data.js';

const MODE_PARAM = {
  type: 'string',
  enum: ['summary', 'raw'],
  description: 'summary (default) returns a compact human-readable digest; raw returns full JSON records. Prefer summary to save tokens.',
};

const usd = (n) => `$${n.toFixed(2)}`;
const customerById = (id) => customers.find((c) => c.id === id);

function topCustomers(limit) {
  const byCustomer = new Map();
  for (const o of orders) {
    const entry = byCustomer.get(o.customerId) ?? { customerId: o.customerId, orders: 0, revenueUsd: 0 };
    entry.orders += 1;
    entry.revenueUsd = Math.round((entry.revenueUsd + o.totalUsd) * 100) / 100;
    byCustomer.set(o.customerId, entry);
  }
  return [...byCustomer.values()]
    .sort((a, b) => b.revenueUsd - a.revenueUsd)
    .slice(0, limit)
    .map((e) => ({ ...e, name: customerById(e.customerId)?.name ?? e.customerId }));
}

const getTopCustomers = defineTool({
  name: 'get_top_customers',
  description:
    'Rank Brewline customers (cafes) by order revenue in the 90-day window. Returns rank, customer name/id, order count and revenue.',
  params: {
    properties: {
      limit: { type: 'integer', description: 'How many customers to return (default 5).' },
      mode: MODE_PARAM,
    },
    required: [],
  },
  handler({ limit = 5, mode = 'summary' } = {}) {
    const rows = topCustomers(limit);
    if (mode === 'raw') return rows;
    const lines = rows.map((r, i) => `${i + 1}. ${r.name} (${r.customerId}) - ${usd(r.revenueUsd)} across ${r.orders} orders`);
    return [`Top ${rows.length} customers by order revenue (90-day window):`, ...lines,
      'Hint: use get_customer_profile for one customer, get_unpaid_invoices for receivables risk.'].join('\n');
  },
});

const getOrderSummary = defineTool({
  name: 'get_order_summary',
  description: 'Aggregate order stats (count, kg, revenue, top beans), optionally for one month. Good first call for "how is business going".',
  params: {
    properties: {
      month: { type: 'string', description: 'Optional YYYY-MM filter, e.g. "2026-06".' },
      mode: MODE_PARAM,
    },
    required: [],
  },
  handler({ month, mode = 'summary' } = {}) {
    const rows = month ? orders.filter((o) => o.orderDate.startsWith(month)) : orders;
    if (mode === 'raw') return rows;
    const revenue = rows.reduce((s, o) => s + o.totalUsd, 0);
    const kg = rows.reduce((s, o) => s + o.kg, 0);
    const beanCount = {};
    for (const o of rows) beanCount[o.beans] = (beanCount[o.beans] ?? 0) + 1;
    const topBeans = Object.entries(beanCount).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([bean, n]) => `${bean} (${n})`).join(', ');
    return [
      `Order summary${month ? ` for ${month}` : ' (90-day window)'}:`,
      `- orders: ${rows.length}, volume: ${kg} kg, revenue: ${usd(revenue)}`,
      `- top beans: ${topBeans || 'n/a'}`,
    ].join('\n');
  },
});

const getUnpaidInvoices = defineTool({
  name: 'get_unpaid_invoices',
  description: 'List unpaid invoices with overdue days (dueDate vs today). Filter by customer and/or minimum overdue days.',
  params: {
    properties: {
      customerId: { type: 'string', description: 'Optional customer id, e.g. "cus-001".' },
      minOverdueDays: { type: 'integer', description: 'Only invoices overdue at least this many days (default 0 = all unpaid).' },
      mode: MODE_PARAM,
    },
    required: [],
  },
  handler({ customerId, minOverdueDays = 0, mode = 'summary' } = {}) {
    const rows = invoices
      .filter((inv) => inv.status === 'unpaid')
      .filter((inv) => !customerId || inv.customerId === customerId)
      .map((inv) => ({ ...inv, overdueDays: Math.max(0, daysSince(inv.dueDate)) }))
      .filter((inv) => inv.overdueDays >= minOverdueDays)
      .sort((a, b) => b.overdueDays - a.overdueDays);
    if (mode === 'raw') return rows;
    if (rows.length === 0) return 'No unpaid invoices match the filter.';
    const total = rows.reduce((s, r) => s + r.amountUsd, 0);
    const lines = rows.slice(0, 10).map((r) =>
      `- ${r.id} ${customerById(r.customerId)?.name ?? r.customerId}: ${usd(r.amountUsd)}, due ${r.dueDate}, overdue ${r.overdueDays}d`);
    return [`${rows.length} unpaid invoice(s), total ${usd(total)}:`, ...lines,
      rows.length > 10 ? `(showing 10 of ${rows.length}; use mode=raw for all)` : ''].filter(Boolean).join('\n');
  },
});

const getSupplierPerformance = defineTool({
  name: 'get_supplier_performance',
  description: 'Supplier scorecard: order volume, on-time delivery rate, average cupping score. Flags suppliers below the on-time threshold.',
  params: {
    properties: {
      supplierId: { type: 'string', description: 'Optional supplier id, e.g. "sup-001".' },
      mode: MODE_PARAM,
    },
    required: [],
  },
  handler({ supplierId, mode = 'summary' } = {}) {
    const rows = suppliers
      .filter((s) => !supplierId || s.id === supplierId)
      .map((s) => {
        const supplierOrders = orders.filter((o) => o.supplierId === s.id);
        return {
          ...s,
          orders: supplierOrders.length,
          kg: supplierOrders.reduce((sum, o) => sum + o.kg, 0),
        };
      });
    if (mode === 'raw') return rows;
    const lines = rows.map((r) =>
      `- ${r.name} (${r.id}, ${r.origin}): ${r.orders} orders / ${r.kg} kg, on-time ${(r.onTimeRate * 100).toFixed(0)}%, cupping ${r.cuppingScoreAvg}${r.onTimeRate < 0.9 ? '  [BELOW on-time threshold]' : ''}`);
    return ['Supplier performance:', ...lines].join('\n');
  },
});

const getDeliveryStatus = defineTool({
  name: 'get_delivery_status',
  description: 'Delivery board for recent orders. Filter by status: delivered | in_transit | delayed.',
  params: {
    properties: {
      status: { type: 'string', enum: ['delivered', 'in_transit', 'delayed'], description: 'Optional status filter.' },
      mode: MODE_PARAM,
    },
    required: [],
  },
  handler({ status, mode = 'summary' } = {}) {
    const rows = deliveries.filter((d) => !status || d.status === status);
    if (mode === 'raw') return rows;
    const counts = {};
    for (const d of deliveries) counts[d.status] = (counts[d.status] ?? 0) + 1;
    const lines = rows.slice(0, 10).map((d) =>
      `- ${d.id} (order ${d.orderId}, ${customerById(d.customerId)?.name ?? d.customerId}): ${d.status}, carrier ${d.carrier}, ETA ${d.eta}`);
    return [
      `Deliveries: delivered ${counts.delivered ?? 0} / in_transit ${counts.in_transit ?? 0} / delayed ${counts.delayed ?? 0}.`,
      ...(status ? [`Matching "${status}":`, ...lines] : []),
    ].join('\n');
  },
});

const getCustomerProfile = defineTool({
  name: 'get_customer_profile',
  description: 'One customer in depth: tier, payment terms, recent orders, unpaid invoices.',
  params: {
    properties: {
      customerId: { type: 'string', description: 'Customer id, e.g. "cus-001".' },
      mode: MODE_PARAM,
    },
    required: ['customerId'],
  },
  handler({ customerId, mode = 'summary' } = {}) {
    const customer = customerById(customerId);
    if (!customer) return `Error: unknown customerId "${customerId}". Try get_top_customers first.`;
    const customerOrders = orders.filter((o) => o.customerId === customerId);
    const unpaid = invoices.filter((i) => i.customerId === customerId && i.status === 'unpaid');
    if (mode === 'raw') return { customer, orders: customerOrders, unpaidInvoices: unpaid };
    const revenue = customerOrders.reduce((s, o) => s + o.totalUsd, 0);
    return [
      `${customer.name} (${customer.id}) - ${customer.city}, tier ${customer.tier}, payment terms ${customer.paymentTermsDays}d`,
      `- 90-day orders: ${customerOrders.length}, revenue ${usd(revenue)}`,
      `- unpaid invoices: ${unpaid.length} (${usd(unpaid.reduce((s, i) => s + i.amountUsd, 0))})`,
    ].join('\n');
  },
});

const queryRawData = defineTool({
  name: 'query_raw_data',
  description:
    'Escape hatch: dump raw JSON records from one dataset. Token-heavy - prefer the summary tools; use this only when they cannot answer.',
  params: {
    properties: {
      dataset: { type: 'string', enum: ['customers', 'suppliers', 'orders', 'invoices', 'deliveries', 'creditNotes'], description: 'Which dataset to read.' },
      limit: { type: 'integer', description: 'Max records to return (default 20).' },
    },
    required: ['dataset'],
  },
  handler({ dataset, limit = 20 } = {}) {
    const rows = db[dataset];
    return { dataset, total: rows.length, records: rows.slice(0, limit) };
  },
});

/** Raw write handler; ALWAYS exposed through the confirm-gate below. */
const createCreditNoteRaw = defineTool({
  name: 'create_credit_note',
  description:
    'Create a credit note against an invoice (e.g. quality claim compensation). Returns the created credit note.',
  params: {
    properties: {
      customerId: { type: 'string', description: 'Customer id the invoice belongs to.' },
      invoiceId: { type: 'string', description: 'Invoice id to credit against.' },
      amountUsd: { type: 'number', description: 'Credit amount in USD; must not exceed the invoice amount.' },
      reason: { type: 'string', description: 'Business reason, e.g. "roast defect claim".' },
    },
    required: ['customerId', 'invoiceId', 'amountUsd', 'reason'],
  },
  handler({ customerId, invoiceId, amountUsd, reason }) {
    const invoice = invoices.find((i) => i.id === invoiceId);
    if (!invoice) throw new Error(`unknown invoiceId "${invoiceId}"`);
    if (invoice.customerId !== customerId) throw new Error(`invoice ${invoiceId} does not belong to customer ${customerId}`);
    if (!(amountUsd > 0) || amountUsd > invoice.amountUsd) {
      throw new Error(`amountUsd must be in (0, ${invoice.amountUsd}]`);
    }
    const note = {
      id: `cn-${String(creditNotes.length + 1).padStart(3, '0')}`,
      customerId,
      invoiceId,
      amountUsd,
      reason,
      createdAt: new Date().toISOString(),
    };
    creditNotes.push(note);
    return { ok: true, creditNote: note };
  },
});

/** Tools that must be tenant-bound when serving a single customer. */
const CUSTOMER_BOUND = new Set(['get_customer_profile', 'get_unpaid_invoices', 'create_credit_note']);

/**
 * Build the demo tool list.
 * @param {object} [opts]
 * @param {object} opts.confirmations - confirmation center (createConfirmationCenter());
 *   required because the demo includes a write tool, which must go through the gate.
 * @param {{customerId?: string}} [opts.scope] - pass scope.customerId to get a
 *   customer-self-service variant: bound tools have customerId force-injected via
 *   withScope, so the LLM can neither see nor override the tenant binding.
 */
export function buildDemoTools({ confirmations, scope } = {}) {
  const createCreditNote = wrapWriteTool(createCreditNoteRaw, {
    center: confirmations,
    summarize: (args) =>
      `Create credit note of $${Number(args.amountUsd).toFixed(2)} against invoice ${args.invoiceId} for customer ${args.customerId}. Reason: ${args.reason}`,
  });
  const tools = [
    getTopCustomers,
    getOrderSummary,
    getUnpaidInvoices,
    getSupplierPerformance,
    getDeliveryStatus,
    getCustomerProfile,
    queryRawData,
    createCreditNote,
  ];
  if (scope?.customerId) {
    return tools.map((t) => (CUSTOMER_BOUND.has(t.name) ? withScope(t, { customerId: scope.customerId }) : t));
  }
  return tools;
}
