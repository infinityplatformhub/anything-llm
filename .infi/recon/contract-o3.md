# O3 — backup / restore: evidence contract

Skills: `infi-dev` (evidence contract), `brainstorming` (open items framed as
questions rather than resolved by assumption).

Docs only. No code in this SHA. Derived from `.infi/recon/recon-o3.md`
(`5f8c1a8e2`) plus measurements taken while writing this file — every number
below was run, not reasoned about.

**Risk tier: `auth`.** Not self-classified — stated here for the PMO to confirm
at contract time. It touches secrets (`SIG_KEY`, `credential_store`), schema
(restore writes every table), and authorization state (`policy_versions`,
`principal_role_grants`). Any one of those alone is the `auth` tier.

---

## 1. The O3 ruling — sequence-jump on restore

**Ruling: a restore must replay identity sequences, and a bundle that carries
rows without them is incomplete rather than merely inconvenient.**

Why it is a ruling and not a preference — measured, not argued:

```
$ createdb o3probe
$ CREATE TABLE t (id serial PRIMARY KEY, v text);
$ INSERT INTO t (v) VALUES ('a'),('b'),('c');
$ SELECT last_value FROM t_id_seq;          → 3

# restore the ROWS with explicit ids, the way a JSON/row-level bundle does:
$ INSERT INTO t (id, v) VALUES (1,'a'),(2,'b'),(3,'c');
$ SELECT last_value, is_called FROM t_id_seq;   → 1 | f

$ INSERT INTO t (v) VALUES ('d') RETURNING id;
ERROR:  duplicate key value violates unique constraint "t_pkey"
DETAIL:  Key (id)=(1) already exists.
```

The restored database **looks correct**: three rows, right ids, every query
answers the way it did before. It fails on the first *write*. That is the shape
worth naming — a restore that passes every read-only smoke test and breaks when
the first user creates something.

`pg_dump` does not have this problem; it emits
`SELECT pg_catalog.setval('public.t_id_seq', 3, true);`. So the ruling is really
a constraint on **bundle format**: if O3 dumps rows itself (to redact, to
re-encrypt, to filter by org) it has left `pg_dump`'s guarantees behind and owns
this explicitly.

**Scope, measured on `server/prisma/schema.prisma`:**

- 57 models
- **49** use `@default(autoincrement())` → 49 sequences at risk
- 8 do not: `identity_login_state`, `identity_providers`, `jobs`,
  `job_schedules`, `event_outbox`, `role_permissions`, `group_members`,
  `document_visibility`
- a live database (`approof_115`) reports **48** sequences in `pg_class`, one
  fewer than the schema's 49 — the gap is itself a finding: something is
  declared and not materialised, or was dropped by a migration. **RF-9 below
  pins this rather than leaving it as a footnote.**

Collision is not limited to primary keys. **37** `@unique` / `@@unique`
constraints exist, and four models key on strings rather than integers
(`schema.prisma:477` `@default(uuid())`, and three with caller-supplied
`String @id` at `:666`, `:691`, `:717`). Those do not jump — they collide only
if the bundle and the live database were both written to. Different failure,
same table.

---

## 2. OPEN — `SIG_KEY` handling (user decides; do not resolve by default)

The recon established there is no middle position. Both options are real; each
buys something and costs something. **This is left open deliberately** — it is a
key-management decision, not an engineering detail, and picking one silently
would be exactly the "structural ruling from a summary alone" the dispatch rules
forbid.

### Option A — out-of-band operator input
`SIG_KEY` never enters the bundle. The operator supplies it at restore.

- **Buys:** the bundle is not a credential store. It can be copied to a laptop,
  attached to a ticket, or handed to a vendor without becoming an incident.
- **Costs:** a restore is now a two-party operation. An operator who lost the
  key has an unrecoverable bundle — and since #48 made the `credential_store`
  row the only copy, "unrecoverable" means every provider credential is gone,
  not unset. Disaster recovery gets a human dependency at its worst moment.
- **Failure mode if the user picks this and we build it badly:** a restore that
  proceeds without the key and leaves the instance quietly unconfigured. RF-3
  exists to make that impossible.

### Option B — stored in the bundle, encrypted under a restore passphrase
The key travels, wrapped under a passphrase the operator types.

- **Buys:** one artifact, one input. Recovery works from the bundle alone.
- **Costs:** the bundle's security is now the passphrase's security. It moves
  the problem rather than removing it, and moves it toward the end of the range
  where humans pick weak values. It also makes every stored copy of the bundle a
  target with a known, uniform structure.
- **Requires, if chosen:** an actual KDF (argon2id or scrypt with measured
  parameters), not a hash; a passphrase strength floor; and a decision about
  what happens when the passphrase is wrong — which must be "refuse", never
  "restore what we can".

**Not a recommendation, a constraint on either choice:** whichever is picked,
the failure must be loud. The two options fail differently but both fail
silently if built carelessly, and a silent failure here is discovered weeks
later when someone tries to use a provider.

---

## 3. Evidence contract

Each RF is stated as: what is asserted, and **how it is proved RED first**. An RF
that cannot be made to fail is not evidence — it is decoration, and §7.17 has
this failure class recorded three times already.

### RF-9 — sequence replay (the ruling above)

```
Assert:  after restore, for every table with an identity column, the next
         INSERT succeeds and does not collide.
RED:     restore a bundle with sequences stripped; the first INSERT into any
         of the 49 tables errors with a duplicate-key violation.
Measure: enumerate the tables rather than sampling. The schema says 49; the
         live database says 48. The test must report which table accounts for
         the difference, and fail if the count is neither reconciled nor equal.
```

The positive control matters more than usual: a test that inserts into one
table and passes tells you nothing about the other 48. §7.17's recurring lesson
— a scan that finds nothing makes every negative assertion pass for free —
applies directly. The test must assert it examined 49 (or the reconciled
number), not merely that it found no failures.

### RF-10 — refuse a bundle newer than the code

```
Assert:  a bundle whose schema version is ahead of the running binary is
         REFUSED, before any write.
RED:     take a bundle at migration 20260902130000_directory_sync_checkpoint
         (31 directories today), run it against a binary built at an earlier
         migration; without the check it restores partially and leaves tables
         the code cannot read.
```

The direction is asymmetric and both directions need saying. **Older bundle,
newer code** is the normal case and is handled by `prisma migrate deploy`.
**Newer bundle, older code** cannot be handled at all — there is no down
migration — so the only correct behaviour is refusal with a message naming both
versions. A restore that "mostly worked" here is worse than one that stopped.

### RF-11 — partial-restore atomicity

```
Assert:  a restore that fails midway leaves the target in its PRE-RESTORE
         state, not a mixture.
RED:     inject a failure after N tables (a constraint violation on table N+1
         will do); without atomicity the database now holds restored rows for
         1..N and original rows for N+1.., and the FK graph spans both.
```

This is where the recon's consistency finding bites hardest. The join key is
concrete: `workspace_documents.docId` is `@unique` and frozen, and vectors carry
`orgId` / `workspaceId` / `docId` for the T-5 ACL filter. A half-restored
database can hold vector rows whose authorization context was never restored —
which is precisely the state T-5 exists to refuse. The test must assert on that
pairing, not merely on row counts.

Note what atomicity can and cannot cover: a single transaction covers
PostgreSQL. It does **not** cover `STORAGE_DIR` or a remote vector service, and
no amount of SQL will make it. The contract must state what happens when pg
rolls back and the filesystem does not — the honest answer is probably
"restore to a new location, swap on success", and if that is not the design then
the failure window needs to be written down rather than discovered.

### Inherited from the recon, restated for completeness

- **RF-1** round trip: same authorization *decisions*, asserted through the
  engine — equal row counts with a different `policy_version` is not success.
- **RF-2** no `SIG_KEY` or decrypted credential in the artifact (grep the
  produced bundle; must fail before the fix).
- **RF-3** restore without the key **refuses**, rather than booting
  unconfigured. Load-bearing under Option A.
- **RF-4** AAD: a row restored under a different `envKey`, or with a bumped
  `KEY_VERSION`, is refused by the auth tag
  (`credentialStore.js:119` binds both). Asserted as *refused*, distinctly from
  *decrypted wrongly* — the recon's point that a runbook checking exit codes
  cannot tell those apart.
- **RF-5** migration gap: an older dump restores only after
  `migrate deploy`, and the failure before it is legible.
- **RF-6** cross-store skew, **both directions**, vector-orphans refused rather
  than served.
- **RF-7** revoked-grant regression — *write this one first*. Revoke, restore a
  backup predating the revocation, assert the grant is not live.
- **RF-8** the same restore path exercised for LanceDB (file-backed, inside
  `STORAGE_DIR`) and one remote provider. They cannot share an assertion that
  holds for only one.

---

## 4. Contract command

Not runnable yet — there is no O3 code. Recorded now so it is fixed before
implementation rather than chosen afterwards to match what got built.

```
cmd:    cd server && npx jest __tests__/backup --runInBand
expect: Tests:  <N> passed, <N> total     with N >= 11
        and the sequence test reporting the table count it examined
```

The `N >= 11` floor and the count-reporting requirement are both there for the
same reason: `Tests: 0 total` and "all passed" render identically, and a
sequence test that silently examined one table passes just as green as one that
examined 49.

---

## 5. Open questions carried forward

Unchanged from the recon; none are answerable by reading, and none should be
guessed:

1. **Does the authorization cache invalidate when `policy_versions` moves
   backwards?** The difference between a stale restore and one serving a revoked
   grant. Highest value of the four.
2. Point-in-time consistency required, or is "quiesce before backup" an
   acceptable operational constraint?
3. Remote vector providers: backed up, or is the contract "re-embed after
   restore"?
4. Must `SIG_KEY` rotation be possible *during* restore? `KEY_VERSION` exists
   (`credentialStore.js:17`) and appears designed for exactly this, but nothing
   uses it yet — so this is a live design choice, not an existing capability.
