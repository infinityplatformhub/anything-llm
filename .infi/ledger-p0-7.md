# P0-7 Rulings

Ruling: Keep telemetry call sites but replace adapter with no-op — stable API avoids broad unrelated edits while guaranteeing no telemetry network client exists — cost if wrong: dead call sites remain until cleanup.

Ruling: Default custom app name is `ApproofWorkspace` and remains configurable — existing white-label behavior stays intact — cost if wrong: deployments expecting null default see new product name.

Ruling: Preserve `ANYTHINGLLM_*`, MIME/header IDs, DB/storage filenames, and exported compatibility symbols — renaming breaks deployments, integrations, or existing data without improving visible branding — cost if wrong: internal scans retain legacy tokens.

Ruling: Retain `@mintplex-labs/*` dependencies and original MIT notice — package coordinates are functional third-party identities and attribution is legally required — cost if wrong: dependency provenance remains visible to technical users.

Ruling: Ship plain AW placeholder assets — removes upstream marks now while allowing design replacement without code changes — cost if wrong: placeholder visual quality is below final brand standard.

Ruling: Flag unknown, GPL-option, and LGPL licenses for human review rather than infer legal compatibility — automated metadata cannot make distribution decisions — cost if wrong: release waits for avoidable review.

## Verification

- `node -e "require('./models/telemetry')"` in `server/`: passed.
- `grep -ri posthog server/package.json frontend/package.json | wc -l`: `0`.
- `npx yarn@1.22.22 build` in `frontend/`: passed (Vite 6,165 modules; warnings only for existing chunk size and browser-externalized Node modules).
- Server package has no `test` script; full server test command unavailable.
- License inventories: server 890, frontend 366, collector 515 production package records.
- Network telemetry smoke: adapter exposes no client (`connect().client === null`); PostHog package and lock entry absent.

Ruling: Replace upstream repository and fallback support destinations with `https://github.com/infinityplatformhub/anything-llm` and its issue tracker — these are current internal equivalents supplied by QA — cost if wrong: links fail until repository visibility or routes are corrected.

Ruling: Remove survey, beta email, hosting, and remote social-preview CTAs without known ApproofWorkspace equivalents — a missing optional CTA is safer than sending users or air-gapped browsers to upstream services — cost if wrong: fewer feedback, hosting, and link-preview entry points.

Ruling: Replace telemetry controls with static Thai disclosure text — telemetry adapter cannot send or enable events, so controls would lie about runtime behavior — cost if wrong: locale-specific copy appears unchanged in non-Thai UI until translation keys are added.
