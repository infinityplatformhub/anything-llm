# Ledger — #112 (O2b: the preflight step in onboarding) — partial: plain half

## What the recon got wrong, corrected by reading the tree

Ruling: the onboarding backfill ALREADY EXISTS — `utils/boot/markOnboarded.js`, called from
`utils/boot/index.js:59` (bootSSL) and `:114` (bootHTTP), with the guard row the O2 3b ruling asked
for. My recon described it as work to be built, taken from that ruling without checking whether it
had been done. Corrected in the recon with an `updated` note rather than a silent rewrite, because
the issue was scoped off the wrong claim. — ถ้าผิด: สร้างของซ้ำแล้วมีสองนิยามของ "ติดตั้งแล้ว"
ในโค้ดเบสเดียวกัน

Ruling: `markOnboarded`'s legacy heuristic is NOT changed. It decides "already installed" from
`LLM_PROVIDER` / `VECTOR_DB` / `AUTH_TOKEN || JWT_SECRET` / multi-user mode — broader than the
`User.count() > 0` my recon proposed by analogy with `/request-token`'s ruling-C branch. A second
definition beside the existing one would be worse than the one that is there. — ถ้าผิด: instance ที่
ตั้งค่าแล้วแบบ single-user โดนถามให้ onboard ใหม่

## The onboarding exposure — read, then deliberately not followed

The tree's actual convention, measured:

| route | middleware |
|---|---|
| `GET /onboarding` (`system.js:178`) | none |
| `POST /onboarding` (`:193`) | `validatedRequest` + `requirePermission("settings.write")` |
| `GET /setup-complete` (`:205`) | none, returns all of `currentSettings()` |

Ruling: "reads open, writes gated" is the convention and this route does NOT follow it, on PMO's
ceiling: answer only when the instance has no users yet, or when the caller holds `system.write`.
A preflight that answers unauthenticated during onboarding and keeps answering afterwards is a
system-status leak for the life of the instance. — ถ้าผิด: `detail` ที่บอกว่า DB host ไหนต่อไม่ติด
เปิดให้ใครก็อ่านได้ตลอดไป

Ruling: `GET /setup-complete`'s missing middleware is pre-existing and NOT touched here. Raised as
its own issue (#114) with what it actually exposes measured: 92 fields, credentials correctly
booleanised, but 33 raw `process.env` passthroughs including twelve internal hostnames and
filesystem paths. — ถ้าผิด: แก้ของที่มีคนใช้อยู่โดยไม่รู้ว่าใครเรียก

## Tests for the existing backfill (the code predates this issue; the coverage does not)

Ruling: assert on the WRITE, not on the row. Measured: `lastUpdatedAt` does not move when the row
is rewritten with the same value, so a row comparison cannot witness "did not write" — and it
didn't: deleting the `isOnboardingComplete()` early return left all seven tests GREEN. Replaced
with a spy on `markOnboardingComplete`. This is the self-satisfying-assertion shape the project has
already paid for twice (#94 F2, #94's dotted-host fixture), caught here only because the mutation
was run. — ถ้าผิด: เทสเจ็ดข้อที่เขียวบนโค้ดที่ guard ถูกถอดออกแล้ว

Ruling: every arm of `isLegacyOnboarded` gets its own case (`VECTOR_DB`, `AUTH_TOKEN`,
`JWT_SECRET`, and `LLM_PROVIDER` in the main path). Testing one arm lets three quarters of the
heuristic rot unnoticed. — ถ้าผิด: signal หายไปหนึ่งตัวโดยไม่มีเทสไหนขยับ

Ruling: a fresh instance with NO legacy signal must be left alone, tested explicitly. It is the half
that matters more — a backfill that fired here would skip setup for every new install.

## TL-2 NITs from #102, folded in (file lane does not clash)

Ruling: behavioural reject tests, not source reads. The increment sits after `await original`, so a
rejection must skip it; wired the other way round, `chats_total` would report every attempt as a
completion and an instance whose provider refused everything would look busy. — ถ้าผิด: dashboard
บอกว่าคึกคักตอนที่ทุก request ถูกปฏิเสธ

Ruling: the source assertion counts with `matchAll` + `toHaveLength(2)`. `toMatch` passes on ONE
`await original`, so a wrapper that lost the embedding half would still look right.

Ruling: a test that the four VALID paths say nothing. The once-per-process memory would make a
noisy wrapper look like a single stray line rather than one that complains about every good call.

Ruling: recon §4's "the throw still fires in tests, where it is a hard failure" was WRONG.
`safeObserve` swallows everywhere; what keeps a bad label hard-failing is that the suites call
`observe()` directly for that assertion. Two functions, not one behaving differently by
environment. Corrected in place with an `updated` note.

## Evidence

`markOnboarded.test.js` 7 · `wiring.test.js` 16 · `providerLabel.test.js` 61 · `endpoints/metrics`
18 = **102 passed**.

### Mutations — each named at the test it takes red (§7.9f)

| mutation | test that goes red |
|---|---|
| delete the `isOnboardingComplete()` guard return | `an instance that already has the row is NOT written again`, `running twice writes exactly once` |
| drop `VECTOR_DB` from `isLegacyOnboarded` | `treats VECTOR_DB as a legacy signal too` |
| move the increment before `await original` | `does not increment chats_total when the connector rejects`, `does not increment embeddings_total when embedChunks rejects` |

## The auth half — `GET /system/preflight`

Ruling: the gate is `isConfirmedSingleUser()`, NOT `User.count()`. TL-1's pre-read had this
inverted, and I stopped rather than implement it. Measured: `models/user.js:305` catches and returns
**0**, so `User.count() === 0` is TRUE while the database is down — opening the route at exactly the
moment its details are most revealing, since they name the host that cannot be reached.
`actorResolver.js:317` catches and returns **false** — fails closed on both of its reads, and its
own comment records that the swallowed-error version of this was already found and fixed once. PMO
confirmed the correction. — ถ้าผิด: DB ล่ม = route เปิดให้ทุกคน ตอนที่ detail มีค่าที่สุด

Ruling: the gate is evaluated PER REQUEST, never cached at module scope. The transition happens
inside one process — the first `User.create` during onboarding closes the window with no restart —
so a cached boolean leaves the route open for that process's life, and a restarted app would show
nothing wrong. — ถ้าผิด: หน้าต่างเปิดค้างทั้งอายุโปรเซส

Ruling: the chain is three middlewares — pre-user check, then `validatedRequest`, then
`requirePermission("system.write")` — with the last two skipped when pre-user. `validatedRequest`
populates `response.locals.user`, which is where `actorResolver` reads the principal from; without
it a real admin resolves to no actor and the gate refuses them (measured: 403). It cannot run first,
because on a pre-user instance there is no session and it would refuse the case the route exists to
serve. — ถ้าผิด: admin จริงโดนปฏิเสธ หรือ pre-user โดนปฏิเสธ แล้วแต่ลำดับ

Ruling: `system.write`, not `system.read`. `permissions.js:59` draws the line already, and F3's
`config.metrics_exposure` in a `detail` is on the far side of it.

Ruling (RESIDUAL, deliberate, recorded at the route and here): if the database is unreachable during
a FRESH install, the gate fails closed and an anonymous operator gets 403 — so the preflight that
would have named the unreachable database is the one they cannot reach. The answer is the CLI, which
needs neither session nor database: `docker compose run --rm --no-deps anything-llm doctor`. Opening
the gate to cover this would mean an unreadable users table grants access, which is the failure the
rule exists to prevent. A documented second route, not a weaker first one.

Ruling: `scrubText` (from `utils/diagnostics`, #94) is applied to `detail` AND `remedy` at this
route. #94 scrubs on bundle ASSEMBLY, not at the check's source, so a string reaching HTTP has never
been through it — and the pg driver quotes the connection string on a connection failure, which is
the check an operator opens this for.

Ruling: the RF-3 test table uses `postgres:5432` and `localhost:5432` and NOT `db.internal`. The
dotted host is what made #94's first version pass by accident (the EMAIL pattern catches a password
beside a dot). Same failure class, deliberately not repeated.

Ruling: `mkSystemReader` builds a principal holding `system.read` and not `system.write`, because no
stock role is shaped that way — measured: only `super_admin` carries either, and it carries both.
Without building it, RF-2 would assert that a user with NO permissions is refused, which proves
nothing about the gate's CHOICE of write over read. — ถ้าผิด: เทสที่ดูเหมือนพิสูจน์ RF-2 แต่ไม่ได้พิสูจน์

Ruling (my own test was wrong, caught by mutation): the DB-down test induces the failure at the
PRISMA layer (`prisma.users.count`), not by spying on `isConfirmedSingleUser`. The first version
spied on the helper — so a gate rewired to `User.count()` never calls it, and the assertion passed
on the exact mutation it exists to catch. Measured: mutation A stayed green. This is the
test-the-mock shape, a cousin of the three the standing rule names. — ถ้าผิด: เทสที่เขียวบน mutation
ที่มันมีไว้จับ

## The React step

Ruling: `level` is not re-derived in the component. `blockersOf` reads the server's field, the same
one `exitCodeFor` reads for the CLI's exit code — a second classification would let the UI and the
boot gate disagree about the same instance.

Ruling: `System.preflight()` returns `null`, never `[]`, when the request fails or is refused. An
empty array renders as "every check passed", which is the one answer a preflight must never give
wrongly. The forward button is disabled while loading for the same reason.

Ruling: the step is registered BEFORE `llm-preference` and both neighbours navigate through it. A
preflight shown after the LLM is configured is a post-mortem — #74's entrypoint ordering exists to
avoid exactly that.

Ruling: the frontend has NO test runner (`frontend/package.json` has no test script; neither jest
nor vitest is installed), so the component's RENDERING is not covered and this is stated rather than
implied. The two decisions the step's correctness rests on — `blockersOf` and `dotFor` — are
exported and tested from the server suite, reading the component file itself rather than a copy. —
ถ้าผิด: อ้างว่าคลุม UI ทั้งที่ไม่ได้รัน component เลย

Ruling: `routeGateSweep`'s pinned route count 317 → 318, with a comment saying why. That pin is
designed to make a new route a deliberate edit, and it worked: it caught this route on the first
`--findRelatedTests` run. `GET /system/preflight` is a READ, so the mutating-route sweep does not
cover it and it needs no exemption there; its own gate is held by `preflightHttp.test.js`.

## Evidence — auth half

`preflightHttp.test.js` 9 · `preflightStepLogic.test.js` 9 · plus the plain half = **121 passed**
across six suites.

### Mutations — each named at the test it takes red (§7.9f)

| mutation | test that goes red |
|---|---|
| gate → `User.count() === 0` | `still REFUSES an anonymous caller when users exist and the users table cannot be read` |
| cache the pre-user boolean at module scope | `closes to anonymous callers the moment a user exists, in the SAME process` + 3 others |
| remove `scrubText` from the response | `removes a password quoted in a check detail on host postgres:5432`, `… on host localhost:5432` |
| gate → `system.read` | `refuses a caller holding system.read but NOT system.write, with no checks in the body` |
| filter out checks that could not run | `reports every check id, with the downstream ones failed rather than absent` |
| `blockersOf` ignores `level` | `does NOT treat a failed WARNING as a blocker`, `takes level from the SERVER, not from the id or the ok flag` |

`--findRelatedTests endpoints/system.js`: 518 passed. `keyCeilingHttp` and `wildcardKeyDeniedHttp`
failed only inside that 38-suite parallel run and pass 12/12 together — the #57 load flake.
