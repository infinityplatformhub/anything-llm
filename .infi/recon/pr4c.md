# PR-4c recon — stop minting wildcard keys

PR-4b removes `"*"` from the **routes**. PR-4c removes it from the **keys**. Both must land or the burn-down is cosmetic: a key carrying `["*"]` satisfies `scopes.includes("*")` in `validApiKey` no matter how precise the route table gets.

Baseline: `approof/main` @ `7dce4997`.

## The three holes

**1. DB default.** `server/prisma/schema.prisma:15`

```prisma
scopes String @default("[\"*\"]")
```

Any row inserted without an explicit `scopes` is a god key. Change the default to `"[]"` (deny by default) — an empty scope array satisfies neither the `"*"` check nor any named scope, so a misconfigured key fails closed.

**2. Model default.** `server/models/apiKeys.js:26`

```js
scopes: JSON.stringify(options.scopes || ["*"]),
```

Same hole one layer up, and this one wins even after the schema changes because the model always writes the column. Change to `options.scopes` required — throw when it is missing or empty rather than defaulting.

**3. Two callers pass nothing.**

- `server/endpoints/admin.js:526` — `POST /admin/generate-api-key` → `ApiKey.create(user.id, name)`
- `server/endpoints/system.js:1072` — `POST /system/generate-api-key` → `ApiKey.create(null, name)`

Both must send a real scope list. Two options, pick per product call:

- **(a)** accept `scopes` (and optionally `workspaceId`, `expiresAt`) in the request body, validate every entry against the known scope set from `scopes.js`, 400 on an unknown scope. Needs a matching frontend change in the API-keys admin page.
- **(b) smaller** — mint with a named preset (e.g. `ADMIN_DEFAULT_SCOPES`, the full known-scope list minus `system.env.read`), and defer per-key scope selection to a later PR. This closes the "silently `*`" hole today without a UI change; the key is still broad but it is *enumerated*, so a future tightening is a one-line list edit rather than an audit.

Recommend (b) for PR-4c and (a) as PR-4d, so PR-4c stays backend-only and unblocks the migration.

## Migration

Needs a slot per code-standards §1.2. Next free hour after `20260902031000_browser_key_digest` is **`20260902040000_api_key_scope_default`**. Claim it when the branch opens.

Contents:
1. `ALTER TABLE api_keys ALTER COLUMN scopes SET DEFAULT '[]';`
2. Backfill decision for existing rows — **do not silently rewrite live keys to `[]`**, that is an outage. Either leave existing `["*"]` rows alone and accept a grace window (recommend; note it in the PR body and open a follow-up to revoke them), or rewrite them to the same named preset chosen above. Whichever, state it explicitly; an unstated backfill is the failure mode here.

## DoD — 3 items

1. **No default anywhere.** `grep -rn '\["\*"\]\|\\"\*\\"' server/models/apiKeys.js server/prisma/schema.prisma` returns nothing. `ApiKey.create` throws when `options.scopes` is absent or empty; a test asserts the throw.
2. **Both mint sites pass real scopes.** `admin.js` and `system.js` generate-api-key handlers pass an explicit list; a test hits each endpoint and asserts the created row's `scopes` column is neither `["*"]` nor `[]`.
3. **No `*` row can exist.** A test that queries `api_keys` after exercising every creation path and asserts zero rows whose parsed scopes contain `"*"`. Run against real Postgres (§7.2), since the point is the DB default — a fake db will happily report whatever the model sent and prove nothing.

## Ordering vs PR-4b

PR-4c is independent of every 4b group in **files** (schema, model, admin.js, system.js — none in the 4b set) but coupled in **meaning**: shipping 4c before 4b makes every existing integration break at once, because keys stop carrying `*` while routes still demand it… which they do not, they demand `*`-or-named, so in fact 4c-then-4b would break nothing at the route layer but would break every *existing deployed key*.

Safe order: **4b groups first, 4c last.** By the time 4c lands, every route wants a named scope, so minting named scopes is the only thing that still works. Landing 4c first would leave a window where new keys have named scopes and routes still accept only `*`.

Keep `API_KEY_SCOPES.TEMPORARY_ALL` itself in `scopes.js` until 4c ships, then delete it in the same PR — its removal is the burn-down's finish line, and the sweep test can be deleted with it.
