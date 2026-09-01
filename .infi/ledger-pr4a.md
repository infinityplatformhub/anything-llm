# PR-4a ledger

Ruling: One frozen `PR4A_ROUTE_SCOPES` object maps all 16 method/path pairs to verbatim seeded actions and route registration calls `scopeFor()` — reviewer and tests inspect same data rather than duplicate expectations — if wrong, dynamic routes need typed route metadata instead.
Ruling: Org-global admin routes carry no workspace binding because their resources are deployment users, invites, settings, or cross-workspace chat audit — binding them to one workspace would deny legitimate org administration — if wrong, later authorization engine resource classification must split them.
Ruling: Three workspace member routes enforce API-key workspace binding before handlers: direct `workspaceId` comparison for two routes and database slug resolution for one — prevents workspace-A keys acting on B — if wrong, slug aliases require canonical workspace IDs upstream.
Ruling: PR-4a replaces exactly 16 wildcards and lowers exact burn-down from 68 to 52 — remaining groups are owned by PR-4b/c — if wrong, sweep fails on any unnoticed route change.
Ruling: RED proof covered missing shared table, unchanged wildcard count, and absent workspace binding helper before implementation — these are independent security failure modes — if wrong, HTTP matrix remains final behavioral evidence.
Ruling: Fix T-1 integration URL in PR-4a by stripping Prisma-only query parameters before invoking psql — base suite blocker is real and psql rejects `schema`, while Prisma accepts it — if wrong, future libpq-compatible query parameters must be allowlisted explicitly.
