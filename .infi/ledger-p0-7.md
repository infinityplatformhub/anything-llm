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

Ruling: Point embed documentation CTA at current Infinity Platform Hub repository — no dedicated embed repository exists at supplied namespace, and current repository is known-valid destination — cost if wrong: CTA lands on project root rather than embed-specific instructions.

Ruling: Centralize server brand destinations in `server/utils/branding/constants.js` with `BRAND_HOMEPAGE_URL`, `BRAND_DOCS_URL`, and `BRAND_CDN_URL` overrides — task gate forbids scattered product URLs and deployments need working destinations before branded domains exist — cost if wrong: defaults route documentation/home links to repository and CDN fallback retains upstream host until operator configures replacement.

Ruling: Restore vendored minified chat widget byte-for-byte and keep its legacy filename/global compatibility identity — source-less edits create unreviewable vendor drift and trigger URL gate on bundled library internals — cost if wrong: embedded API retains legacy technical identity until widget is rebuilt from maintained source.

Ruling: Remove frontend social URL metadata and unsupported cloud-provider documentation CTAs — no real product website or documentation endpoint exists — cost if wrong: social shares omit canonical URL and users lose two contextual help links.

Ruling: Centralize frontend repository/release destinations in `frontend/src/utils/branding.js` with `VITE_BRAND_REPOSITORY_URL` override — URL gate and deployments require one configurable source — cost if wrong: other legacy docs routes remain separate until replacement documentation exists.

Ruling: Retain upstream ARM Chromium archive URL in Dockerfile — it is a required build-time binary dependency, not product branding, and invented replacement domain breaks ARM images — cost if wrong: upstream can remove archive and ARM builds fail.

Ruling: Restore `anythingllm-router` provider value — it is a persisted configuration and routing compatibility ID, not user-facing branding — cost if wrong: internal legacy token remains visible to technical scans.

Ruling: Ignore only generated login SVG files for URL gate — `xmlns` is an XML namespace identifier, not a fetched resource — cost if wrong: future real URLs added to those two tiny assets bypass generic URL gate and require review.
