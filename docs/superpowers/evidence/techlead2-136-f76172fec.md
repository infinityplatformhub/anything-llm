# Techlead-2 verdict — #136 `f76172fec`

**Skills invoked:** `security-review` (auth tier — suspension/deletion of a credential
owner, and a permission-gated route). `requesting-code-review`: the plugin name does not
resolve in this session (`Unknown skill` for both the bare and `superpowers:`-namespaced
form — reported previously and unchanged), so this verdict follows the reviewer template
read from disk at
`~/.claude/plugins/cache/superpowers-dev/superpowers/6.3.0/skills/requesting-code-review/`.
No `infi-lessons` line: nothing here is a new §7.17 failure class.

**Verdict: PASS.** All six seam checks I queued come back clean, the F5 fixture is present
and drives the real delete path, and the `createdBy = null` branch is untouched and pinned
by a control I re-derived myself. Two NITs, neither blocking.

Worktree `/tmp/tl2-136fix` (`git worktree add --detach`), node_modules hardlinked from
`/tmp/tl2-127`, `npx prisma generate`. Own database. Tree clean at the end; probe scripts
removed.

Baseline, the four suites the diff touches — **48 passed, 48 total**, three consecutive
runs identical. (First run showed 20 failures: my own harness pinned `SIG_KEY`/`JWT_SECRET`
to fixed short values. Re-run with generated keys is the real baseline; recorded because a
reader should not have to wonder why the number moved.)

---

## The six checks

### 1. Is `unreadable → refuse` reachable in production, or test-only?

**Test-only, and the code says so.** I walked every production caller:

| caller | passes `db`? |
|---|---|
| `requirePermission.js:61`, `validApiKey.js:47` | no |
| `endpoints/api/openai`, `api/system`, `api/workspace` ×3, `system.js:1839` | no |
| `retrievalFilter.js:54` → `resolveActorRef({ db })` | forwards its own `db` param |
| every `retrievalFilterFor` caller (10 files) | none passes `db` |

So `db` is `prisma` on every production path and `typeof db?.users?.findUnique` is always
a function. The branch exists because six test suites hand the resolver a narrow stub, and
the JSDoc states exactly that. This is the same shape as QA-2's V3 NIT and I reach the same
answer: a guard that is unreachable from production is not a defect when the alternative it
replaces was a `TypeError` thrown from inside the resolver with no handler.

Mutant **M3** (`return "unreadable"` → `return "active"`): **1 failed**. So the branch is
pinned even though production cannot reach it — which is what makes it safe to keep.

### 2. Does any production caller pass a partial `db`?

No. Same table as check 1 — the only forwarding path is `retrievalFilter`, and its `db`
parameter is undefined at all ten call sites, so `resolveActorRef` falls back to `prisma`.

### 3. Is `missing` refused distinctly from `suspended`?

Yes, and measured three ways rather than read off the code:

- **M4** (`if (!creator) return "missing"` → `"active"`): **2 failed**.
- **M6** (`creator.suspended ? "suspended" : "active"` → always `"active"`): **3 failed**.
- **M1** (`status !== "active"` → `status === "suspended"`, which collapses *missing* and
  *unreadable* into allow): **3 failed**.

Three distinct mutants, three distinct failure sets. The states are not collapsible.

### 4. `unreadable → refuse` must NOT cover the `createdBy = null` branch

**Correct, and pinned.** The lookup sits inside `if (creatorId !== null)`; the null branch
still goes `isConfirmedSingleUser(db)` → `SINGLE_USER_ACTOR`, unchanged.

I built the over-refusal myself rather than trusting the fixture name — **M5**, routing the
null branch through `creatorStatus` as well: **2 failed**. So a future hoist of the check
out of the `creatorId !== null` branch cannot land silently. This was the check most likely
to be satisfied by a fixture that never exercises the branch; it is not.

`QA2-5` is a real control: it empties `users`, asserts `isMultiUserMode() === false`, mints
with `ApiKey.create(null, …)`, and asserts `nexted === true` **and** `status === null`.

### 5. F5 fixture present, driving the real delete path

Present, and separate from `D3` by design (D3 drives the resolver with a stub; F5 deletes a
real user through `User.delete` and asserts the key is refused at `validApiKey`).

I measured the delete path directly on a scratch database, including the bulk clause the
`system.js` rollback uses:

```
single delete { id }  -> key row present: true   revokedAt set: true
bulk   delete {}      -> key row present: true   revokedAt set: true
```

Both halves of my earlier ruling hold: the row survives (the stamp is the record of *when*
the credential stopped) and the stamp lands before the owner row is gone. **M10** (delete
the `for (const { id } of doomed)` sweep): **1 failed**.

### 6. F1 rework

Every objection I raised is addressed, and each is independently pinned:

| my objection | how it is closed | mutant |
|---|---|---|
| no failure channel | cast returns `null`; `update` answers `{success:false, error}` | **M8** (fall back to `Number(Boolean(value))`): 1 failed |
| must not widen past `suspended` | `switch` case only; `default: String(value)` untouched; test asserts `castColumnValue("dailyMessageLimit", null)` still returns `null` | — |
| rejected value must not reach prisma as `undefined` | explicit `updates.suspended === null` guard before the write | **M9**, see NIT-1 |
| accept set must be exact | 8 accepted spellings, 11 rejected, asserted as a table | **M14** (add `2` to the accept set): 1 failed |

F1c asserts the **row and the key**, not the envelope — `row.suspended === 0`,
`key.revokedAt === null`, and `authenticate(...).nexted === true` for each of five bad
values. That is the correction the second SHA carries and it is the right one.

The frontend sends `suspended: suspended ? 0 : 1` (`UserRow/index.jsx:30`) — numbers, both
in the accept set. The v1 swagger example documents `suspended: 0`. No caller in the repo
sends a spelling this refuses.

---

## The rest of the ledger's claims, checked

| claim | mutant | result |
|---|---|---|
| level-triggered sweep | **M7** — restore `&& currentUser.suspended !== 1` | 1 failed |
| `revokedAt: null` filter preserves original timestamps | **M13** — drop the filter | 1 failed |
| F4 existence check | **M11** — remove the `groups.findUnique` 404 | 1 failed |
| F4 parse guard | **M12** — remove `Number.isInteger` | 1 failed |

14 mutants run in total across the three source files; **13 killed**.

The F4 pair is the part I want to record as correct rather than merely green: the two
guards fix *different* bugs (`999999` bumped a policy version under `org:1` and flushed
every cached decision; `"abc"` threw a 500 before any write), each test asserts
`policy_versions.count()` is unchanged across the call, so a 404 that still bumps stays red.
That is the assertion my #124 ruling asks for — it runs where the property it names is the
only thing that could satisfy it.

`QA2-3` is the strongest test in the file and worth naming: it asserts the level-triggered
sweep **on the stamp, not on authentication**, with a comment recording that reverting the
sweep alone left all 14 tests green until that assertion existed. That is §7.9 applied by
the dev to their own work.

---

## NIT-1 (non-blocking) — M9 survives, and I proved by execution why

**M9** disables the `updates.suspended === null` guard: **48/48 still green.** I did not
leave that as "survived"; I measured what the mutant actually does.

```
guard present:  {"success":false,"error":"suspended must be one of 1, \"1\", …"}   row.suspended = 0
guard removed:  {"success":false,"error":"Invalid `tx.users.update()` … Argument `suspended`
                 must not be null."}                                              row.suspended = 0
```

Both refuse, both leave the row and the key untouched, so there is **no security difference**
— the mutant is equivalent *for the property under test*. It survives because the assertion
is `expect(refused.error).toMatch(/suspended/)` and Prisma's own message contains the word.

Keep the guard: relying on Prisma to reject `null` couples a security answer to a schema
detail (`suspended Int @default(0)`, NOT NULL — make the column nullable and the mutant
stops refusing), and it leaks an internal query into an API response. But the test cannot
currently tell the two apart. If a stricter pin is wanted the assertion should be the exact
message, not `/suspended/`. Not blocking: the behaviour under review is correct either way.

## NIT-2 (non-blocking) — `_update` is covered at the reader, not at the writer

`User._update` (`:385`) still writes `suspended` with no cast and no sweep, and this SHA
does not change that — correctly, per my own ruling that the reader is the enforcement
point. `QA2-2` pins it: `_update(id, {suspended: 1})` leaves no authenticating key.

What `_update` does **not** get is the cast. Its three production callers write
`web_push_subscription_config` and `seen_recovery_codes` only, so nothing reaches it with a
string `suspended` today. Recorded so the next person adding a caller knows the two methods
have different guarantees on the same column.

## Residual

`api_keys.createdBy` still has no foreign key, so orphan rows accumulate — now stamped
rather than live. That is #135's cleanup and this SHA correctly does not attempt it.

## Reproduction

```
git worktree add --detach /tmp/tl2-136fix f76172fec
cp -al /tmp/tl2-127/server/node_modules /tmp/tl2-136fix/server/node_modules
cd /tmp/tl2-136fix/server && npx prisma generate
export PATH="/opt/homebrew/opt/node@22/bin:$PATH" STORAGE_DIR=$(mktemp -d) \
       SIG_KEY=$(openssl rand -hex 32) SIG_SALT=b API_KEY_PEPPER=$(openssl rand -hex 32) \
       JWT_SECRET=$(openssl rand -hex 32) \
       DATABASE_URL="postgresql://postgres:pw@127.0.0.1:55472/t98b"
npx jest __tests__/security/authorization/offboardUser.test.js \
         __tests__/security/authorization/apiKeyGrants.test.js \
         __tests__/security/authorization/keyKindRequired.test.js \
         __tests__/t4bResolvedWorkspaceGrant.test.js --runInBand
```

Each mutant was a single-occurrence string replacement (asserted unique before writing),
the suite re-run, then `git checkout -- .` before the next. The delete probe ran against a
scratch database (`CREATE DATABASE t136 TEMPLATE t98b`) so a bulk `User.delete({})` could
not touch the shared fixtures.
