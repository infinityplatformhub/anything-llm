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

## Still to do in this issue

The auth half: `GET /system/preflight` with the pre-user-or-`system.write` rule, `scrubText` over
the whole response, and the React step. Waiting on TL-1's RF list.
