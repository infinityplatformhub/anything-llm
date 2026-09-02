# Techlead-1 — early read: #113 S4a slice 2 `5227c176e` (branch `approof/113-s4a`)

Scope: 4 commits, 1149 insertions, 7 files. §7.14 — I ran no suite. Everything below is a
small in-process probe against the slice's own files in a detached worktree
(`git worktree add --detach /tmp/tl-113s2 5227c176e`, `node_modules` symlinked, Node 22).

Three questions asked, answered first, then two findings the questions did not cover.

---

## Q1 — does the temp-dir harness actually close F1/F2? **Yes, by construction.**

`groupsExternalIdUnique.test.js:67-88`: `fs.mkdtempSync` under `os.tmpdir()`, `cpSync` the
real `prisma/migrations` in, `rmSync` the one migration out of the **copy**, `copyFileSync`
the schema beside it, then `migrate deploy --schema <staged>`. The working tree is never
written. That is the right shape and it is stronger than a `finally`: there is no restore
step to skip, so SIGKILL/OOM leaves nothing to repair, and two jest workers in the same
folder no longer race. F1 and F2 both close.

Copying the schema beside the staged migrations rather than pointing `--schema` across trees
is correct — Prisma resolves `migrations/` as the schema file's sibling, so the obvious
version (real schema + staged migrations dir) would have silently used the real directory
and the boundary would not have been drawn at all. Worth the comment it got.

**NIT-1 (not blocking): `fs.rmSync(stageDir)` at `:88` is not in a `finally`.** If the
seeder insert throws — the interesting failure, since that is the statement the mutation
makes fail — the temp directory survives the run. It is under `os.tmpdir()` and named
`s4a-mig-*`, so nothing breaks and the OS reclaims it; but the commit's own argument is
"cleanup you can skip is cleanup that does not happen", and this is the one line still
relying on it. One `try/finally` or a `process.on("exit")` unlink.

## Q2 — is the L2 survivor really equivalent? **Yes as written — but the ledger's conclusion is too broad.**

L2 set `cursor` inside the retry loop, after `url` had already been built from it at
`:150-152`. Nothing downstream re-reads `cursor`, so the mutant changes no observable
behaviour. Equivalent, and recording it rather than dropping it is right.

But "5 of 6 killed, the 6th unreachable" reads as *the cursor path is covered*, and it is
not — see FINDING-2. An equivalent mutant proves the mutant was bad, never that the region
is tested.

## Q3 — is "No partial result is returned" in the right place? **Yes.**

It is on the `_page` throw at `:202-206`, i.e. on the only exit that can be reached with
pages already collected in `_enumerate`. `_enumerate` itself has no catch — it lets the
throw pass, so `collected` is dropped rather than returned. The invariant the file's header
promises ("every catch either retries or rethrows; none of them return") holds: the three
catches are `_tenantAccessToken`'s rethrow at `:120`, the transport catch at `:162` (retries),
and nothing else. Verified by reading every `catch` in the file.

---

## FINDING-1 — the `has_more` guard is load-bearing and no test covers it; the fixture is green either way

`_page:196` chooses the next cursor deliberately:

```js
nextToken: data.has_more ? (data.page_token ?? null) : null,
```

with a comment saying why: *"a final page that still carries a token would otherwise loop
forever."* That is a real Lark behaviour to defend against, and it is the kind of defence
that must be pinned or it gets "simplified" in six months.

**Measured — the mutation survives the whole suite's shape.** I ran the driver with that line
replaced by `nextToken: data.page_token ?? null` against the slice's own fixture:

```
MUTANT has_more-ignored: 250 principals, pages 1,2,3,4,5   (identical to the real driver)
```

Green because the **fixture is green for an unrelated reason**: `server.js:124` emits
`page_token: hasMore ? String(page+1) : undefined`, so on the last page the token is absent
and `?? null` reaches the same answer. The fixture can never distinguish the two branches
because it never serves the shape the guard exists for.

Confirmed the real driver does handle it — a hand-written server that always emits a
`page_token` and flips `has_more` on the last page stops correctly at 3 requests. So the code
is right and only the evidence is missing.

```
RF-6 : fixture option `alwaysToken: true` — emit page_token on EVERY page,
       has_more false on the last. Assert the enumeration terminates and
       userPages === [1..N] with no repeat.
mut  : nextToken: data.page_token ?? null
why  : every existing test is green under this mutation (measured above), because
       the fixture withholds the token on the last page. The test must serve the
       token, not assert on the count — a count assertion on a terminating run
       cannot see a guard that only prevents non-termination.
```

## FINDING-2 — `listPrincipals({cursor})` returns a **partial directory labelled as a complete snapshot**

This is the one I would not merge without an answer, because it is the exact failure the
file's header is written against.

`_enumerate:228` seeds `let next = cursor` from the caller's input, and `listPrincipals`
returns unconditionally:

```js
nextCursor: null,
hasMore: false,
```

with the comment *"A completed full snapshot, which is the only thing S4b may act on absence
from."* Measured against the slice's fixture, 250 users over 5 pages:

```
listPrincipals({})            -> 250 principals, pages 1,2,3,4,5
listPrincipals({cursor:"4"})  -> 100 principals, pages 4,5,
                                 first subject u-00150, hasMore false, nextCursor null
```

So a caller passing a cursor gets **150 people missing**, flagged as a complete snapshot. S4b,
which decides departure by absence, would deactivate 150 active employees. That is precisely
the harm the "a failed enumeration THROWS" rule exists to prevent, arriving through the
success path instead of the failure path.

The docblock at `:216-219` says the seam's `cursor`/`delta` inputs "are accepted and
deliberately ignored **for `delta`**" — `delta` throws `IdentityCapabilityError` at `:222`,
correctly. `cursor` is not ignored: it is honoured, and then the result lies about being
complete. Two readings of one sentence, and the code does the dangerous one.

No core caller passes a cursor today (measured: the only other `listPrincipals` are the LDAP,
SAML and OIDC stubs at `:369` / `:385` / `:333`; nothing in `utils`, `endpoints`, `jobs` or
`models` calls it). So this is not live — it is a loaded gun handed to S4b, whose author will
read `nextCursor`/`hasMore` and reasonably conclude the seam supports resumption.

**Recommendation — same shape as `delta`:** a non-null `cursor` throws
`IdentityCapabilityError` ("Lark enumeration cannot be resumed; a partial snapshot is not a
snapshot"). Ignoring it silently is the other defensible option and I would refuse it: a
caller that asked to resume and got a full re-enumeration is merely wasteful, but a caller
that asked to resume and got a *prefix marked complete* is the outage.

```
RF-7 : listPrincipals({cursor:"4"}) against a 250-user / 5-page fixture
       -> throws IdentityCapabilityError (or returns all 250 if PMO rules "ignore")
mut  : `let next = cursor` -> honoured with the current return shape
why  : NO existing test passes a cursor at all (grep: 0 matches for "cursor" in
       larkDirectorySync.test.js), so every current test is green with the seam in
       either state. The count assertion is what discriminates — asserting only
       that it "returns principals" is green on the 100-row prefix too.
```

## NIT-2 — a row with no `user_id` normalises to `subject: ""` rather than being rejected

```
toDirectoryPrincipal({name:"x"}) -> {"subject":"", ...}
```

`String(row.user_id ?? "")` makes a malformed row into a principal with an empty subject. The
driver's stated job is "report what the directory said", so not inventing a subject is right —
but an empty string is a *value* that `identity_links` can key on, and two malformed rows
would collide on it. Given the file's own prohibition on `open_id` welding, an empty subject
deserves the same treatment: skip the row and count it, or throw. Dev3's call; worth one line
in the ledger either way.

---

## Verdict on the read

Slice 2 is good work — the fixture failing in the *middle* is the right design, the named-id
assertions are what make the 429 test mean something, and finding the `includes`-path false
pass in their own test is the kind of self-audit that is usually skipped. FINDING-1 is
evidence-only. **FINDING-2 is a contract hole** and should be answered before slice 2 merges,
because S4b is the caller that will find it.
