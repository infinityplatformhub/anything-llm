# Ledger — #94 (O5b: `doctor --bundle`)

## Rulings from PMO, applied

Ruling: CLI only, no migration — `diagnostics.export` and the slot-100000 reservation move to
O5b-ui. A permission nothing in the same issue checks is an inert guard (the #80 family): the row
exists, every path reaches the feature without consulting it, and it reads as protection in review
while protecting nothing. No slot reserved. — ถ้าผิด: O5b-ui ต้องเปิด migration เองซึ่งเป็นงานห้านาที

Ruling: `--bundle` emits JSON on stdout ONLY; the checklist and any bundling complaint go to
stderr. The test parses the WHOLE of stdout, not a substring — a stray log line from any module the
doctor loads would pass a "contains JSON" test and still produce a file that does not parse. —
ถ้าผิด: `doctor --bundle > bundle.json` คืนไฟล์ที่ parse ไม่ได้ และคนเจอตอนแนบไปแล้ว

## Rulings taken inside the plan's scope

Ruling: the environment goes through an ALLOWLIST, not `maskSecretValues` over all 214 keys.
Masking everything is safe but useless, and the pressure to unmask "obviously safe" keys one at a
time is how a denylist forms. — ถ้าผิด: bundle ที่มีแต่ `**********` ไม่ตอบคำถามอะไร คนก็เลิกใช้แล้วขอ
ให้ operator paste env มาเองซึ่งแย่กว่าเดิม

Ruling: `event_logs` contributes COUNTS, never rows. Its metadata is redacted on write already, but
the rows are still the record of what every actor did, and `audit.read` is super_admin-only because
export is bulk egress of the highest-value data on the instance. — ถ้าผิด: bundle กลายเป็นทางออก
ของ audit trail ที่เลี่ยง permission ทั้งหมด

Ruling: recent error text and stack traces are OUT. The most tempting item and the least safe — a
trace carries query strings with tokens, filenames with customer names, prompt fragments. If a
later ruling wants them they go through `scrubValue` like everything else; the honest default is
out. — ถ้าผิด: เสียข้อมูล debug หนึ่งชั้น ซึ่งขอเพิ่มทีหลังได้ ต่างจากการถอนของที่หลุดไปแล้ว

Ruling: each database query is individually tolerant — a missing table degrades ONE row into an
error string rather than abandoning the file. A bundle from a broken install is exactly when this
runs, and "this table is not there" is often the answer. — ถ้าผิด: install ที่พังที่สุดคือ install
ที่สร้าง bundle ไม่ได้เลย

Ruling: the exit code reports the CHECKS, not whether bundling succeeded. A bundle assembled from a
broken install is a successful bundling of a failing install. — ถ้าผิด: `$?` บอกว่าโอเคทั้งที่
blocking check แดง แล้ว automation ที่เชื่อ exit code เดินต่อ

Ruling: `emitBundle` opens its OWN connection rather than borrowing `runChecks`'s. `runChecks` owns
and closes its client, and a doctor whose checks depended on the bundle's connection would describe
a different database state than the one it just reported. — ถ้าผิด: checklist กับ bundle พูดถึง
คนละ connection แล้วไม่มีใครรู้

Ruling: the entrypoint's `doctor)` arm does `shift` + `"$@"`. Without it `doctor --bundle` runs the
plain checklist and ignores the flag — the same failure the dispatch itself exists to fix, one
argument further along. Tested behaviourally with a stub `node` that records argv, not by grepping
the file. — ถ้าผิด: operator รัน `--bundle` แล้วได้ checklist โดยไม่มี error

## TL-1 pre-read findings, applied

Ruling (F1): export `stripUrlCredentials` from `updateENV` and `scrubValue` from `redaction`. Both
were used before they were exported, and `collectEnv` threw at the first call. NOT
`maskSecretValues` (keys by KEY_MAPPING SETTING name, so every env key is undeclared to it and
masks whole) and NOT `redactEventData` (its ALLOWED_KEYS filters the bundle's own section names,
leaving `{_droppedKeyCount: 4}`). Both alternatives are now held by tests. — ถ้าผิด: bundle
ที่ redact สมบูรณ์แบบและไม่มีข้อมูลอะไรเลย

Ruling (F2): the allowlist splits into `DERIVED_ENV_KEYS` (resolved in KEY_MAPPING, asserted
`secret === false` — strict, because `secret: "url"` is neither true nor false and `!== true` would
wave it through) and `UNDECLARED_ENV_KEYS` (key → reason; the reason must be non-empty and the key
must be genuinely absent from KEY_MAPPING, so a key that later gains a declaration must move rather
than keep an exemption). `DATABASE_URL` is in NEITHER: it is transformed, not allowed, and has its
own named case. — ถ้าผิด: ลิสต์เดียวที่เช็คด้วยเงื่อนไขเดียวปล่อย key ที่ไม่ได้ประกาศผ่าน

Ruling (F2, self-correction): my original test filtered the allowlist by `secret === true` and
asserted empty. Self-satisfying (§7.9f) — an UNDECLARED key is not `secret === true`, so it passed,
and `secret: "url"` passed too. Replaced by the two above rather than patched. — ถ้าผิด: เทสเขียว
บน allowlist ที่มี secret อยู่จริง

Ruling (F3a): resource figures and counts stay NUMBERS through assembly; no `String()` before
scrubbing. `String(os.totalmem())` is 11-13 digits, so a stringifying bundle would report
`[redacted:thai_national_id]` for its own memory. Held by a test, because "normalise everything to
strings before scrubbing" is a plausible and quiet future change. — ถ้าผิด: bundle รายงานหน่วยความจำ
ตัวเองเป็นเลขบัตรประชาชนที่ถูกลบ

Ruling (F3b): `stripUrlCredentials` runs BEFORE `scrubValue`. Reversed, `user:pass@host` would
match the EMAIL pattern and the bundle would say `[redacted:email]@db.internal` — password gone,
username and shape preserved, reading as redaction while still naming the account. — ถ้าผิด: ดู
เหมือน redact แล้วแต่ยังบอกชื่อ account

Ruling (F4): `runChecks()` output goes through `scrubValue` like every other section, and the recon
sentence "already redacted by construction" was WRONG and is corrected in place with an `updated`
note. A check's `detail` quotes what it found — a connection string, a path, a locale name — so it
is built from exactly the environment everything else is redacted for. — ถ้าผิด: section ที่คน
เชื่อว่าปลอดภัยโดยธรรมชาติคือ section ที่ไม่มีใครตรวจ

Ruling (F4): `collectDatabase` builds its own connection line from `stripUrlCredentials` rather
than reusing the doctor's `maskUrl`, which keeps the USERNAME. Right for a checklist on the
operator's own terminal, wrong for a file headed to a public issue: a database username and an
internal hostname match no pattern, so nothing downstream would catch them. Cost: the username,
which a reader can look up in their own environment. — ถ้าผิด: DB username + internal host
ไปอยู่ใน public issue

## TL-1 FINDING-1 and NIT-1, applied

Ruling (FINDING-1): one helper, `scrubText(s, hits)` = strip every embedded `scheme://user:pass@`
run, THEN `scrubValue`. Applied to `safeQuery` error text, `checks[].detail` and `.remedy`,
`migration_name`, `serverVersion`, event names, and the connection line.

My earlier version relied on `scrubValue` alone and my test passed only by ACCIDENT: the EMAIL
pattern matches `user:pass@db.internal` because that host contains a dot. Measured on the hosts this
project actually ships —

    db.internal:5432   →  appuser:[redacted:email]:5432        (accident)
    postgres:5432      →  appuser:sup3rsecret@postgres:5432    LEAKED IN FULL
    localhost:5432     →  appuser:sup3rsecret@localhost:5432   LEAKED IN FULL

`postgres` is docker-compose's host and `localhost` is CI's, so both shipped configurations were
leaking. Even where the pattern did fire it removed only the tail: `Xq7!kR2#mN9$vL4` left
`Xq7!kR2#mN9$`. The live path is `safeQuery` returning `error.message` verbatim while the pg driver
quotes the connection string on a connection failure — the exact moment someone runs `--bundle`. —
ถ้าผิด: password ของ DB ไปอยู่ใน public issue พร้อมกับ host ที่ใช้จริง

Ruling: the test table carries all THREE hosts including the dotted one, so changing the fixture
back to `db.internal` cannot make these pass on their own. Under the mutation that removes the
strip, the dotted host's detail test stays GREEN while the other two go red — the accident is now
visible in the suite rather than hidden by it. — ถ้าผิด: กลับไปมี fixture ที่ปิดบั๊กแทนที่จะเปิด

Ruling: `hits` is threaded through `scrubText` rather than kept local, and the strip adds
`url_credentials` to the reported classes. Found by a test going red: the first version swallowed
its hits in a local Set, so the bundle would have claimed nothing was redacted while redacting. A
scrub that reports nothing lets an operator believe the file is untouched. — ถ้าผิด: bundle บอกว่า
ไม่ได้ลบอะไรทั้งที่ลบ แล้วคนแชร์ต่อโดยไม่ตรวจ

Ruling (NIT-1): a guard asserting `UNDECLARED_ENV_KEYS` intersects neither `REQUIRED_SECRETS` nor
any envKey KEY_MAPPING declares `secret: true` or `"url"`. The UNDECLARED list is the one place a
key can be added without the tree contradicting you. — ถ้าผิด: ใครสักคนเติม key ที่เป็นความลับ
ลงลิสต์ที่ไม่มีอะไรค้าน

### Mutations (§7.9f)

Removing the strip from `scrubText`: **10 red**, and the dotted-host detail test stayed green —
which is the finding itself, reproduced.
Adding `API_KEY_PEPPER` to `UNDECLARED_ENV_KEYS`: **1 red**, the NIT-1 guard.

## Finding split out — #95

The seeded-secret scan found a live PDPA leak in `utils/events/redaction.js`: the three numeric
patterns are anchored with `\b`, and `_` is a word character, so `note_1234567890123` keeps its
value in the audit log. Split into hotfix #95 (`59cb80068`) on PMO ruling: outside this issue's
file lane, leaking on main today, and not something this reviewer should have to adjudicate.

**Resolved:** #95 merged (main `c7a4711c4`); this branch was rebased onto it and the assertion went
green without being touched. The seeding is kept as written so it goes red again if the fix is ever
reverted, and the test's comment now says that rather than "red until #95".

## Evidence

Measured on `820ede6c4`, rebased onto main `c7a4711c4`:

    Test Suites: 4 passed, 4 total
    Tests:       241 passed, 241 total

Per suite: `bundle.test.js` 38, `doctorBundleCli.test.js` 9, `doctor.test.js` 46,
`auditRedaction.test.js` 148 (144 + the 4 that arrived with #95).

25 → 38 in `bundle.test.js`: the FINDING-1 table (3 hosts × 3 assertions), the two strip-behaviour
tests, the `url_credentials` reporting test, and the NIT-1 guard.
`doctor.test.js` unchanged and green; header note added saying the suite needs PostgreSQL 16+, that
pgvector is NOT required, and that missing it skips rather than fails (TL-2 lost ten minutes).
