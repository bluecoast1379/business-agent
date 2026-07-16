# Retail Operations Template

Version: `1.0.0`

This is a fictional, offline template for evaluating tenant-bound retail inventory and restock workflows. It contains no credentials, production endpoints, store records, supplier orders, or executable integration wiring.

## Behavior

The agent reads a trusted tenant's store inventory, identifies reorder candidates, and prepares—but never places—a human-approved restock request. Store and tenant scope must be supplied by trusted runtime identity.

## Package contents

- `agent.json`: versioned agent blueprint.
- `workflow.json`: inspect, route, approval, and handoff flow.
- `tool-manifest.json`: input/output schemas and mandatory policy metadata.
- `evals.jsonl`: deterministic mock cases, including a cross-tenant safety case.
- `thresholds.json`: exact pass, safety, slice, and cost gates.

Validate or run this package from the repository root:

```bash
node bin/run-template-matrix.mjs validate --template retail
node bin/run-template-matrix.mjs run --template retail
```

Replace the mock handlers, identity source, and fixtures only in a separately reviewed runtime integration. This template does not claim production certification or supplier-order authority.
