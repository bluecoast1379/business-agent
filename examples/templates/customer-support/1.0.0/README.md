# Customer Support Template

Version: `1.0.0`

This is a fictional, offline template for evaluating tenant-bound customer-support workflows. It contains no credentials, production endpoints, customer records, or executable integration wiring.

## Behavior

The agent reads one trusted tenant's case, searches approved help content, and requests a human-approved handoff when self-service is insufficient. Caller text never supplies trusted tenant identity.

## Package contents

- `agent.json`: versioned agent blueprint.
- `workflow.json`: classify, route, answer, approval, and handoff flow.
- `tool-manifest.json`: input/output schemas and mandatory policy metadata.
- `evals.jsonl`: deterministic mock cases, including a cross-tenant safety case.
- `thresholds.json`: exact pass, safety, slice, and cost gates.

Validate or run this package from the repository root:

```bash
node bin/run-template-matrix.mjs validate --template customer-support
node bin/run-template-matrix.mjs run --template customer-support
```

Replace the mock handlers, identity source, and fixtures only in a separately reviewed runtime integration. This template does not claim production certification.
