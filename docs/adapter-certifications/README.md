# Adapter self-reported check records

Generated adapter descriptors and initializer smoke tests prove structural
conformance only. A JSON file committed beside the checker is controlled by the
same repository, so it cannot prove that a trusted person or system tested a
specific desktop/CLI client.

Repository-local observations may be stored at
`docs/adapter-certifications/<tool>/<client-version>.json`, but their status
must be `self-reported-manual-check`. They record client version, OS, a
canonical `verifiedAt`, an expiry no more than 90 days later, and the three
checks in `kit/adapters/conformance.schema.json`. Future timestamps, expired
records, long validity windows, extra issuer/signature claims, and the legacy
`manual-certified` status are rejected.

These records never change the public support matrix. Every shipped adapter
remains `native_not_yet_manually_certified`.

Trusted certification is intentionally not implemented. It would require all
of the following outside this repository's trust domain:

1. an externally managed policy and allowlisted issuer public key;
2. a detached signature over canonical evidence;
3. verification that the signed adapter/source digest matches the exact
   released artifact;
4. bounded freshness, client-version binding, and revocation handling.

Until those controls exist and are independently verified, console output and
counts report repository files only as self-reported records and always report
zero trusted certifications.
