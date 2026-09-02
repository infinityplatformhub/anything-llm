# Recon — O5: diagnostic bundle + Prometheus endpoint

Backlog row: `O5 | Diagnostic bundle + Prometheus endpoint | P0-6 | 2 cw | bundle export ไม่มี secret ปน, /metrics ต่อ Grafana ได้`
Read-only recon. No issue opened, nothing implemented.

## 0. The headline

Two deliverables that look like one row but have opposite risk shapes, and the plan should not
treat them alike.

**`/metrics`** is a small, well-trodden feature whose whole difficulty is *who may read it*. It is
conventionally unauthenticated so a scraper can reach it, and this instance already has the two
pieces that make that safe — `ipAllowlist` and the permission engine.

**The diagnostic bundle** is bulk egress of the highest-value data on the instance, assembled by
us and handed to whoever asked. The DoD says "no secrets in the bundle". That is not a filter to
write; it is an *allowlist to derive*, and the tree already contains two hard-won precedents for
exactly this problem (`maskSecretValues` and `utils/events/redaction.js`) whose reasoning must be
reused rather than re-invented.

If the two are built together, the bundle's risk review will hold up a `/metrics` endpoint that
was ready in a day. **Recommend splitting O5 into O5a (metrics) and O5b (bundle)** before any
issue is opened.

## 1. What exists

- **`GET /api/ping`** (`endpoints/system.js:116`) — unauthenticated, returns `{online:true}`. The
  only operational endpoint today, and the model for how an unauthenticated route is mounted here.
- **`ipAllowlist`** (`utils/middleware/requestControls.js:222`) — CIDR-aware, applied to the whole
  `/api` tree at `index.js:102`. Empty allowlist means "allow everything"; an *unparseable* one
  denies everything, which is the right failure direction and matters for the metrics ruling below.
- **`maskSecretValues` / `maskOneValue`** (`utils/helpers/updateENV.js:1685-1705`) — masks by
  consulting `KEY_MAPPING[key].secret`, and **treats an undeclared key as a secret**. `"url"`-typed
  values get their userinfo stripped rather than a full mask, so an operator can still recognise
  their endpoint.
- **`utils/events/redaction.js`** — the audit sink's PDPA redaction. Its header states the
  principle this whole issue turns on: *"A denylist protects against the payloads someone thought
  of; an allowlist protects against the ones they did not."* It also does a pattern scan over every
  string at any depth, because an allowlisted key still carries free text.
- **`event_logs`** (`schema.prisma:290`) — `event`, `metadata`, `userId`, `occurredAt`. Already
  redacted on write.
- **Permission vocabulary** (`prisma/seeds/permissions.js`) — `system.read`, `system.write`,
  `system.env.read`, `audit.read`. Note the two comments there: `system.env.read` was split out
  because "a key that may read system status must not thereby read the provider credentials", and
  `audit.read` is super_admin-only because "export is bulk egress of the highest-value data on the
  instance". Both sentences apply directly to the bundle.
- **`prom-client` is not a dependency.** Neither is any metrics library.

## 2. `/metrics` — the real question is the mount, not the metrics

The metric values are the easy half: process metrics from `prom-client`'s default registry, plus a
handful of app counters (chats, embeddings, documents, failed logins) that mostly already flow
through `emitAuditEvent`.

The hard half is placement, and there are three distinct answers with different consequences:

1. **Inside `/api`, unauthenticated like `/ping`.** Inherits `ipAllowlist` for free. Simplest, and
   the allowlist is exactly the control an operator running Prometheus already understands.
2. **Inside `/api`, behind `requirePermission("system.read", orgResource)`.** Prometheus supports
   bearer tokens, so this is workable — but it means minting an API key for the scraper, and
   `system.read` is currently held by keys that report status, which is a reasonable fit.
3. **A separate port.** What most Go services do. Wrong here: it doubles the surface the operator
   must firewall and does not compose with `ipAllowlist`.

**Recommend (1) with a documented caveat, and a ruling asked for rather than assumed.** The caveat
is real and should be written into the endpoint's own comment: *a default install has an empty
allowlist, which means allow-everything*, so on a box exposed to the internet `/metrics` would be
public. Metrics are not secrets, but they are an inventory — user counts, workspace counts, model
names, error rates — and that is reconnaissance.

**What must never appear in a metric label:** workspace names, usernames, document filenames,
model API endpoints. Prometheus labels are unbounded cardinality *and* plain text in every scrape.
A `chats_total{workspace="acme-legal-due-diligence"}` label leaks a customer's deal name to anyone
who can read the scrape. Counters go by *type*, never by *instance*.

## 3. The diagnostic bundle — "no secrets" is an allowlist, not a filter

What an operator actually needs when they file a bug: versions, configuration *shape* (which
provider, not which key), migration state, recent errors, the doctor's checklist (#74), and
resource limits.

The temptation is to dump `process.env` through `maskSecretValues` and call it done. That is wrong
here for a reason the tree already learned twice:

- `maskSecretValues` masks by consulting `KEY_MAPPING`. A key **not** in that table is treated as a
  secret and fully masked — safe. But the bundle's job is to be *useful*, so the pressure will be
  to unmask the "obviously safe" ones, and that pressure is exactly how a denylist forms.
- `utils/events/redaction.js` already rejected the denylist approach for the audit sink after a
  live regression: `models/user.js` had a hardcoded `sensitiveFields=["password"]` at **one** call
  site, so a second call site passing a password would have stored it verbatim.

**So: the bundle carries an explicit allowlist of env keys**, each present because someone decided
it is diagnostic, plus a pattern scan over every string value at any depth — the same two
independent guards `redaction.js` uses, for the same stated reason.

Three things that will be missed if not named now:

- **`DATABASE_URL` is not a safe key even masked.** Its host and database name are useful, its
  password is not, and `stripUrlCredentials` (`updateENV.js:1713`) already does exactly this
  transformation. Reuse it; do not write a second one.
- **Recent errors are free text.** Whatever gets included from logs or `event_logs.metadata` must
  go through the same pattern scan, because a stack trace can contain a query string with a token
  in it.
- **The bundle is a download, and downloads get shared.** It will be attached to a GitHub issue or
  a support email. That is the threat model, not "someone breaches the server".

**Who may generate one:** `audit.read` is super_admin-only precisely because "export is bulk egress
of the highest-value data". A diagnostic bundle is a smaller version of the same act.
`system.read` is too weak — it is held by status-reporting keys. Recommend a ruling for either
`system.env.read` or a new `diagnostics.export`, and note that inventing a new action means a
migration and a seed change, which is Dev5's slot-100000 territory and must be announced.

## 4. Open questions for the ruling

1. **Split O5 into O5a (`/metrics`) and O5b (bundle)?** Recommend yes — the bundle's review is a
   security review, the metrics endpoint's is not, and coupling them delays the cheap half.
2. **`/metrics` mount:** unauthenticated inside `/api` behind `ipAllowlist` (recommended), or
   `requirePermission("system.read")`?
3. **Bundle permission:** `system.env.read`, or a new `diagnostics.export` action? The latter is
   cleaner and costs a migration.
4. **Bundle format and delivery:** a JSON download from the UI, a `doctor --bundle` subcommand on
   the entrypoint (#74 already established that dispatch), or both? The CLI form is the one that
   works when the server will not boot — which is when bundles are most wanted.
5. **`prom-client` dependency:** acceptable to add, or hand-roll the exposition format? It is ~4
   files of text formatting; the library is the boring choice and is the de-facto standard.

## 5. Scope sketch (subject to the rulings above)

**O5a:** `prom-client` default registry + app counters by type; `GET /api/metrics`; a test that no
label value is derived from user-supplied text; docs for the Prometheus scrape config.

**O5b:** env-key allowlist + pattern scan reusing `redaction.js`'s two-guard shape;
`stripUrlCredentials` for URL-shaped values; the doctor's checklist from #74; migration state;
`event_logs` summary counts (not rows); permission gate per the ruling; both a UI download and a
CLI subcommand; and a test that seeds a known secret into every reachable source and asserts it
does not appear anywhere in the bundle — the same test shape `envDumpGuardHttp.test.js` uses.

**Out of both:** log shipping, tracing, alerting rules, and anything that sends data off the box —
Q5 of O2 already ruled that setup makes no network calls, and the same reasoning applies to a
diagnostics feature that must work on an air-gapped install.
