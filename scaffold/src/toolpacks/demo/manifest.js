const policy = ({
  audiences,
  tenantScope,
  dataClass,
  effect = 'read',
  approval = 'none',
  idempotency = 'none',
  outputSchema = {},
}) =>
  Object.freeze({
    version: '1.0.0',
    audiences: Object.freeze(audiences),
    tenantScope,
    dataClass,
    effect,
    approval,
    idempotency,
    timeoutMs: 30_000,
    audit: 'metadata',
    outputSchema: Object.freeze(outputSchema),
  });

const operatorRead = (dataClass) => policy({
  audiences: ['operator'],
  tenantScope: 'global',
  dataClass,
});

const customerRead = (dataClass) => policy({
  audiences: ['operator', 'customer'],
  tenantScope: 'customer',
  dataClass,
});

/** Mandatory, fail-closed policy for every demo tool. */
export const DEMO_TOOL_MANIFEST = Object.freeze({
  get_top_customers: operatorRead('internal-commercial'),
  get_order_summary: operatorRead('internal-order'),
  get_unpaid_invoices: customerRead('customer-financial'),
  get_supplier_performance: operatorRead('internal-sourcing'),
  get_delivery_status: operatorRead('internal-fulfillment'),
  get_customer_profile: customerRead('customer-profile'),
  query_raw_data: operatorRead('internal-raw'),
  create_credit_note: policy({
    audiences: ['operator', 'customer'],
    tenantScope: 'customer',
    dataClass: 'customer-financial',
    effect: 'write',
    approval: 'human',
    idempotency: 'required',
  }),
});
