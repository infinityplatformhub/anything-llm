# Recon — #106 / #57: the suites that fail only in company

Recon only. No code touched.

The brief listed three hypotheses. Two were tested and **one of them is wrong**; the answer is not
one cause but **two different regimes**, and they need different fixes. Everything below is measured
on this machine, with the commands that produced it.

> **UPDATE — the regime-1 reproduction below does NOT hold up, and the correction matters more than
> the original claim.**
>
> Re-measured after PMO terminated 49 idle backends, with `pg_stat_activity` counted during the run
> rather than client objects counted before it (TL-2 RF-1 asks for exactly this, and it is what
> caught me):
>
> | total connections during run | 3 authz suites together | result |
> |---|---|---|
> | 48 | ×5 runs | **17/17 every run** |
> | 63 | ×3 runs | **17/17 every run** |
> | **93 of 100** | ×3 runs | **17/17 every run** |
>
> The original "40 held → 401" run was **40 held PLUS the 49 idle backends already there**, i.e.
> ~89 total — and at a comparable 93 today the same three suites pass five times over. So the 401
> is real (§1 quotes it from the log) but I cannot reproduce it, and "40 connections" was never the
> variable: I reported the number my probe *opened*, not the number the server *held*.
>
> What survives: §1's saturation measurement (all 17 fail, `too many clients`, deterministic) and
> §3's counts of unisolated and non-disconnecting suites. What does not: the claim that regime 1 is
> reproducible at a stated connection count. Regime 1 is real — the varying failure sets on main
> are not imaginary — but this recon does not establish its trigger, and the fix should not be
> justified by a measurement I cannot repeat.

## 0. Starting measurement

```
max_connections                              100
pg_stat_activity, datname=approofworkspace    55   (all state=idle)
prisma default pool (num_cpus*2+1)            37
```

55 idle connections were already held on the shared database before any test ran. One Prisma client
asks for 37. Two of those and the cap is gone.

## 1. Hypothesis 2 — pool exhaustion — is only HALF right, and the half that matters is the other one

Method: `hold-probe.js` opens N connections and holds them, then the same suites run against a
freshly bootstrapped database (`approof_d118`).

**At 40 held connections (≈40% of the cap):**

| what ran | result |
|---|---|
| `viewAsUser.test.js` ALONE | **4/4 pass** |
| `explainAccess` + `viewAsUser` + `grantManagement` TOGETHER | **2 failed**, 15 passed |

And the failure is **not** a connection error:

```
● D-3: view-as-user › an admin can mint a session for another user…
    expect(received).toBe(expected)
    Expected: 200
    Received: 401
```

**A 401 is not `PrismaClientInitializationError`.** The brief's hypothesis 2 says pool exhaustion is
reported by jest as an assertion failure — at this level of pressure that is not what is happening.
The request reached the server, ran, and was *refused on its merits*. That is a data collision:
these suites create users and grants in the same database and tread on each other.

Removing the load and re-running the same three: **17/17 pass.** So load is a *trigger* — it slows
things enough for the overlap to matter — but the *defect* is shared state.

**At full saturation (3×40 held, `psql` itself refused with `sorry, too many clients already`):**

| run | result | error text |
|---|---|---|
| 1 | 17 failed | `too many clients` |
| 2 | 17 failed | `too many clients` |
| 3 | 17 failed | `too many clients` |

Here hypothesis 2 IS the story, and it is unmistakable: *every* test fails and the message names the
cause. Deterministic, not flaky.

## 2. So there are two regimes, and conflating them is why this looks non-deterministic

| regime | signature | what it is |
|---|---|---|
| **partial pressure** | a FEW tests fail, message is an ordinary assertion (401, wrong count), set of failures VARIES between runs | shared-database data collision between concurrently running suites |
| **saturation** | ALL tests fail, message says `too many clients` | genuine connection exhaustion |

The observations in the brief are the first regime: 1–5 suites, never the same ones, all green
alone. My own `security/authorization/` run was the same — 13 failures on one run, 21 on another, 50
on unmodified main, all 55 suites green individually.

**The varying count is the evidence for collision, not for exhaustion.** Exhaustion is not selective.

## 3. What is actually shared

```
suites under __tests__/ that give themselves a schema      35
suites under security/authorization/ that do NOT           52 of 55
suites under security/authorization/ that $disconnect      27 of 55
```

The pattern already exists in this tree — `envDumpGuardHttp.test.js` and the suites I wrote for #94
and #112 set `searchParams.set("schema", …)` and get their own namespace. Fifty-two authorization
suites do not, and share whatever `DATABASE_URL` names. Under jest's default parallelism they run
concurrently against one set of `users`, `roles` and `principal_role_grants` rows.

Half of them never `$disconnect`, so each leaves a 37-connection pool held until the worker exits —
which is what turns several worktrees running gates at once into regime 2.

## 4. Proposals, in the order they should be considered

**(a) Per-suite schema — fixes regime 1, the actual defect.** Extend the existing
`searchParams.set("schema", …)` pattern to the 52 suites that lack it. This is the fix, because it
removes the shared state rather than making collisions less likely. Cost: it is 52 files, and each
needs `migrate deploy` into its schema, which is why the suites that do this are slower to start.
Worth measuring on one suite before committing to all 52.

**(b) `$disconnect` in `afterAll` — necessary, not sufficient.** The 28 suites that never disconnect
hold a pool per worker. This does not fix collisions at all; it stops one worktree's finished suites
from starving another's. Cheap and independent of (a).

**(c) A per-worktree database, enforced.** `scripts/wt-bootstrap.sh` already takes a database name,
and every worktree I have used has had its own. The 55 idle connections on `approofworkspace` say
something is still pointed at the shared one. Worth finding what before mandating anything — a rule
that is already followed does not need enforcing, and the leak is elsewhere.

**(d) Lower the Prisma pool via `connection_limit`.** 37 per client is generous for a test process.
Setting `connection_limit=5` in the test `DATABASE_URL` would let ~20 concurrent workers fit under
the cap instead of 2. Smallest change of the four, mitigates regime 2 immediately, and does not
touch regime 1.

**Recommended order: (d), then (b), then measure whether regime 1 still bites; (a) only for the
suites that still collide.** Rewriting 52 files should follow evidence that they need it, not
precede it.

The update at the head of this file strengthens that order rather than weakening it: with regime 1's
trigger unreproduced, (a) is the one proposal with no measurement behind it at all.

## 5. What has NOT been measured, stated rather than assumed

- **Hypothesis 3 (the Prisma singleton, §7.10) is untested here.** `utils/prisma` exports one
  client per process; whether a suite that re-requires it gets a second pool is a separate
  measurement and I did not run it.
- **Which process holds the 55 idle connections** on `approofworkspace`. That matters for (c) and I
  did not chase it — it may be a running dev server rather than any test.
- **Whether (d) alone is enough.** It should be tried before (a) is scoped.
- The measurements are from this machine at one moment. CI's cap and parallelism differ.

## 6. Reproduction, so this is checkable rather than believed

```bash
# hold 40 connections against a fresh database
node hold-probe.js 40 "postgresql://.../approof_d118" &

# passes alone
npx jest __tests__/security/authorization/viewAsUser.test.js          # 4/4

# fails in company — 401, not a connection error
npx jest __tests__/security/authorization/{explainAccess,viewAsUser,grantManagement}.test.js
# → 2 failed, 15 passed

# same three, load removed
# → 17 passed

# saturate: 3 × 40 holders, psql itself refused
# → 17 failed, every message "too many clients"
```

`hold-probe.js` was written into `server/` for the measurement and deleted afterwards; it is the
seven-line `pg` client loop above and is not part of the tree.
