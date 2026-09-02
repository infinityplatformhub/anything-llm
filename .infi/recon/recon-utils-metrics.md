# recon — `GET /utils/metrics` (TL-2's observation)

Base: `49c4afd54` (approof/main). Docs only. Every claim below was produced by
running the route or by enumerating callers in the tree, not by reading the
handler and reasoning about it.

## What it returns, measured

`server/endpoints/utils.js:17-34`, mounted by `utilEndpoints`, **no middleware
array at all** — not `validatedRequest`, not `requirePermission`.

Mounted the real handler and called it unauthenticated. Two shapes, because the
version fields branch on the runtime:

**Source checkout (`ANYTHING_LLM_RUNTIME` unset):**
```json
{"online": true,
 "version": "49c4afd54ba05575b97ca38c97345fb36d0603ad",
 "mode": "single-user", "vectorDB": "lancedb",
 "storage": {"current": 868, "capacity": 1995},
 "appVersion": null}
```

**Docker (`ANYTHING_LLM_RUNTIME=docker`, `DEPLOYMENT_VERSION=1.9.2`):**
```json
{"online": true, "version": "--",
 "mode": "single-user", "vectorDB": "lancedb",
 "storage": {"current": 868, "capacity": 1995},
 "appVersion": "1.9.2"}
```

Both **200, unauthenticated**.

Worth stating precisely, because "version" understates it: on a source checkout
`version` is `git rev-parse HEAD` — the **full 40-character commit SHA of the
running tree** (`getGitVersion`, utils.js). Not a release number. In Docker it is
`"--"` and `appVersion` carries the release string instead.

## Who calls it

**Exactly one caller in the repository.** Enumerated across the whole tree
(excluding `node_modules`/`.git`); every other hit for "utils/metrics" is either
the unrelated `server/utils/metrics` Prometheus module or prose in
docs/ledgers.

`frontend/src/models/system.js:919` — `System.fetchAppVersion()`:

- sends **no auth header** (`fetch(..., {method:"GET", cache:"no-cache"})`);
- reads **`res?.appVersion` and nothing else** — the other five fields are
  fetched and discarded;
- caches the result in `localStorage` for **1 hour** and returns early on a hit,
  so it is not a per-render call;
- swallows every failure (`.catch(() => null)`).

Its only consumer is `useAppVersion()` (`frontend/src/hooks/useAppVersion.js`),
whose only consumer is `SettingsSidebar/index.jsx:536` — the settings sidebar
footer, which renders **only for a logged-in user**.

**No operational caller.** Every health probe in the repo uses `/api/ping`, not
this route:

- `docker/docker-healthcheck.sh:5` → `/api/ping`, and it is what
  `docker/Dockerfile:178` and `cloud-deployments/openshift/Dockerfile:219` run as
  `HEALTHCHECK`;
- AWS CloudFormation, DigitalOcean Terraform and GCP deployment scripts all
  `curl .../api/ping`.

Nothing in `.github/`, `docker/`, `cloud-deployments/` or any script references
`/utils/metrics`.

## The exposure, and its real bound

`/utils/metrics` is mounted under `/api`, which carries `ipAllowlist`
(`server/index.js:103`). That middleware is **opt-in and off by default**:
`parsedAllowlist()` reads `process.env.IP_ALLOWLIST || ""`, and
`ipAllowlist` returns `next()` when the parsed list is empty
(`requestControls.js:312`). So on a default deployment — no `IP_ALLOWLIST` set —
this route is reachable by anyone who can reach the port.

An operator who HAS set `IP_ALLOWLIST` is already protected, and for them this is
not an internet-facing leak. That distinction matters for how urgent this is, and
it is why the tier below is what it is.

### Blast radius

| field | what it gives an unauthenticated caller |
|---|---|
| `version` (source checkouts) | **the exact commit the instance is running.** Turns "is this instance vulnerable to X" from guesswork into a lookup against a public repo — the single highest-value field here |
| `appVersion` (Docker) | release string; same idea, coarser |
| `mode` | `single-user` vs `multi-user`. Tells an attacker whether there is an auth system at all before they probe one |
| `vectorDB` | which vector store is deployed, i.e. which secondary service may be listening |
| `storage.current` / `.capacity` | host disk free/total in GB |

The disk numbers are the least sensitive of these on their own, and the most
useful **repeatedly**: polled over time they are a free capacity oracle, and a
monotonic drop is a usable signal for when to attempt a fill-the-disk denial of
service. As a one-shot read they are near-harmless; the leak is the time series.

`online: true` is the only field with no disclosure value — it is what `/ping`
already answers.

## Proposal

**Tier: `auth`.** Not because the route mutates anything — it does not — but by
the §7.11a rule as written: it is exposed unauthenticated and the change moves
an authorization boundary. The change is small; the classification is about what
a wrong answer costs, and getting "which fields stay public" wrong here is a
disclosure bug that nothing in the suite would catch.

**Recommendation: put the whole route behind `validatedRequest`, and do NOT
carve out a public subset.**

The reasoning, in the order it actually decided:

1. **Nothing breaks.** The single caller runs only for a logged-in user in the
   settings sidebar, so it already has a session; adding `validatedRequest`
   costs it nothing. This is measured, not assumed — the caller chain is
   sidebar → `useAppVersion` → `fetchAppVersion`, and the sidebar is
   post-login.
2. **No health check depends on it.** `/ping` is the liveness endpoint, it is
   already public, and it already answers `{online: true}` — the only field here
   with no disclosure value. A "health-check subset" of `/utils/metrics` would
   duplicate a route that exists and is in use.
3. **A subset would have to keep the worst field.** The only plausible reason to
   keep any of this public is version discovery, and `version`/`appVersion` are
   precisely the fields worth withholding. A subset that dropped disk and kept
   version would keep the highest-value item and remove the lowest.

So: `[validatedRequest]` on the route, no new action, no `requirePermission`.
Session, not permission — every logged-in user's own sidebar reads it, and
gating on a capability would hide the footer version from ordinary users for no
benefit.

If a Prometheus-style scrape target is wanted later, it exists already:
`GET /system/metrics` (`system.js:315`) renders `utils/metrics` and is
deliberately unauthenticated behind `ipAllowlist`, per its own comment. That is
the right home for machine-readable telemetry, and it is a separate decision from
this route.

### Evidence contract

```
cmd:    cd server && npx jest --runInBand __tests__/security/authorization/ __tests__/endpoints/
expect: Test Suites: 0 failed
```

New tests, each a decision rather than a shape check:

- unauthenticated `GET /utils/metrics` is **401**, and the body carries no
  `version`, `appVersion`, `storage`, `mode` or `vectorDB` key — asserted on the
  key list, because an empty-valued key still discloses the field exists;
- an authenticated caller gets 200 and the same body as today, so the fix does
  not quietly change the sidebar's contract;
- `GET /ping` is still 200 and still unauthenticated — the health path must not
  be collateral damage, and this is the assertion that catches someone "fixing"
  the whole file;
- non-vacuity: the authenticated case asserts `version` IS present, so the 401
  test cannot pass because the route was deleted.

**Mutations that must go red:** remove `validatedRequest` → the 401 test;
add `validatedRequest` to `/ping` as well → the ping test; return `{}` from the
handler → the authenticated non-vacuity assertion.

## Open question for the ruling

Whether `storage` should survive at all, even authenticated. Every logged-in user
of a multi-user instance would still get host disk free/total, which is
infrastructure detail that a workspace member arguably has no reason to see.
Options: keep it (status quo, one caller ignores it anyway), or gate that one
field on `system.read` and leave the version fields at session level. I have not
picked one — it is a question about what an ordinary member may know about the
host, not a technical constraint.
