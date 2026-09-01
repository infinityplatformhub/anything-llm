# P0-7 Rulings

Ruling: Keep telemetry call sites but replace adapter with no-op — stable API avoids broad unrelated edits while guaranteeing no telemetry network client exists — cost if wrong: dead call sites remain until cleanup.

Ruling: Default custom app name is `ApproofWorkspace` and remains configurable — existing white-label behavior stays intact — cost if wrong: deployments expecting null default see new product name.

Ruling: Preserve `ANYTHINGLLM_*`, MIME/header IDs, DB/storage filenames, and exported compatibility symbols — renaming breaks deployments, integrations, or existing data without improving visible branding — cost if wrong: internal scans retain legacy tokens.

Ruling: Retain `@mintplex-labs/*` dependencies and original MIT notice — package coordinates are functional third-party identities and attribution is legally required — cost if wrong: dependency provenance remains visible to technical users.

Ruling: Ship plain AW placeholder assets — removes upstream marks now while allowing design replacement without code changes — cost if wrong: placeholder visual quality is below final brand standard.

Ruling: Flag unknown, GPL-option, and LGPL licenses for human review rather than infer legal compatibility — automated metadata cannot make distribution decisions — cost if wrong: release waits for avoidable review.
