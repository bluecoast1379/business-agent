# Finance Operations Template

Version: `1.0.0`

This is a fictional, offline template for evaluating tenant-bound finance-operations workflows. It contains no credentials, bank data, payment tokens, production ledger records, or executable integration wiring.

## Behavior

The agent summarizes a reconciliation batch, inspects a scoped exception, and prepares—but never directly posts—a human-approved adjustment request. Trusted tenant identity is supplied by runtime policy, not model or caller text.

## Package contents

- `agent.json`: versioned agent blueprint.
- `workflow.json`: reconcile, classify, review, approval, and handoff flow.
- `tool-manifest.json`: input/output schemas and mandatory policy metadata.
- `evals.jsonl`: deterministic mock cases, including a cross-tenant safety case.
- `thresholds.json`: exact pass, safety, slice, and cost gates.

Validate or run this package from the repository root:

```bash
node bin/run-template-matrix.mjs validate --template finance-ops
node bin/run-template-matrix.mjs run --template finance-ops
```

Replace the mock handlers, identity source, and fixtures only in a separately reviewed runtime integration. This template does not claim production certification or accounting correctness.
