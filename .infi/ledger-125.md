# Ledger — #125 (memoise the credential-store key derivation)

All timings: darwin arm64, node v22.23.1, on this machine.

## The finding that reframed the issue

Ruling: this is not only a latency fix — **it closes a timing side channel**, and that was verified
before being claimed. `get()` derives the key only AFTER `if (!row) return null`
(`credentialStore.js:100-103`), so measured on main:

    present: 29.5 ms | absent: 0.9 ms | delta: 28.6 ms

28 ms is measurable over a network, and it answers "is this provider configured on this instance"
to anyone who can reach a path that reads a credential. After memoisation both branches cost the
same. TL-2 raised the possibility; I measured it rather than writing a test around an assumption. —
ถ้าผิด: เขียนเทส timing รอบสิ่งที่ไม่มีอยู่ แล้ว threshold จะถูกจูนจนผ่านโดยไม่มีใครรู้ว่าวัดอะไร

## Rulings

Ruling: the cache is keyed by the MATERIAL (`{ material, key }`), module-scope `let`, not a
property on `CredentialStore`. Keyed by nothing, a rotated `SIG_KEY` would keep decrypting under
the old key. — ถ้าผิด: credential store ที่เพิกเฉยต่อการ re-key ของตัวเอง

Ruling: plain `===`, NOT `timingSafeEqual`, with the reason at the line. It compares the configured
material against the copy we derived from; both sides are the same local value and neither is
attacker-supplied. A constant-time primitive there would tell the next reader that one side can be
chosen by someone else, which is false. — ถ้าผิด: คนอ่านเข้าใจ threat model ผิดจากโค้ดที่ตั้งใจสื่อ

Ruling: `__resetKeyCache` is exported from the module and NOT hung off `CredentialStore`, so
enumerating the store still exposes nothing.

## What I got wrong, and how each was caught

Ruling (caught by mutation M3): my comment claimed the guard's position ABOVE the cache is what
makes deletion of `SIG_KEY` fail closed. Moving it below changes no outcome — **25/25 still green**
— because the cache only returns when `material` matches, and only validated material is ever
cached. The comment now states the real reason and says what the argument depends on (the
comparison staying exact) instead of asserting a property nothing holds. Same class as #118's
ordering comment. — ถ้าผิด: คอมเมนต์ที่พิสูจน์ผิดไม่ได้ ซึ่งคนอ่านต่อจะไปปกป้อง

Ruling (test correctness, twice): the cross-process test proved nothing in two different ways
before it worked. First it called `get()` on an absent row — `get()` returns before deriving when
there is no row, so the child reported zero derivations and PASSED for the wrong reason. Second it
counted a `scryptSync` call the test itself made and never touched `CredentialStore` at all. It now
drives the real path twice and asserts exactly 1. Both failures are named in the test's comment so
the next reader does not re-introduce either. — ถ้าผิด: เทส cross-process ที่เขียวโดยไม่ได้ข้าม
process จริง

Ruling: the child's count is parsed from a `DERIVATIONS=` MARKER, not from the whole of stdout —
Prisma logs its pool size on startup, so `Number(stdout)` was NaN. The count was right and the
reading of it was not.

Ruling: the reachability test asserts on VALUES, not property NAMES. My first version matched
`/key|material|cache|secret/i` against names and flagged `keys()`, a legitimate method that reports
which credentials exist without decrypting them — while still missing a Buffer stored under an
innocuous name. — ถ้าผิด: เทสที่จับชื่อ ไม่ได้จับของ

## Evidence

`credentialStore.test.js` **25 passed** (19 before + 6).

RED before implementation: 6 failed — including `reading 97 credentials costs about one derivation`
at **2514 ms**, matching QA-2's 2518 ms baseline independently.

### Mutations — each named at the test it takes red (§7.9f)

| mutation | test that goes red |
|---|---|
| remove the cache read | `N reads derive the key ONCE, not N times`, `a cold cache derives exactly once`, `a fresh process starts with a cold cache`, `present and absent reads cost the same once the cache is warm`, `reading 97 credentials costs about one derivation, not 97` (4982 ms) |
| cache keyed by nothing (`if (keyCache) return keyCache.key`) | `rotating SIG_KEY mid-process re-derives instead of reusing the old key`, `a value stored under a different SIG_KEY does not decrypt` |
| move the guard below the cache read | **NONE — 25/25 green.** Equivalent, not a survivor; the comment was corrected rather than a test contrived to fail |

## Two conditions on the above, recorded because nothing enforces them (TL-2)

**The guard/cache equivalence holds ONLY while the cache key is exactly the material.** It is a
single entry compared with `===`, so unvalidated material can never hit it. Add `KEY_VERSION` to the
key, make it multi-entry, or relax the comparison in any way, and a lookup could succeed on input
the guard has not seen — at which point guard-before-cache becomes load-bearing for real. **No test
holds that boundary**: the mutation that moves the guard is green today and would stay green through
the change that makes it matter. Whoever touches the cache key must re-run that mutation and expect
a different answer.

**The oracle is closed only AFTER the first derivation.** The first `get()` on a cold cache still
costs ~28 ms more when a row exists than when it does not, so a process that has not yet derived is
still measurable. In practice #115 hydrates credentials before `listen()`, which means the cache is
warm before anything is reachable — but **that is a dependency between two issues with no test
holding it**. If hydration is ever moved after `listen()`, or made lazy, the side channel reopens
for the first request and nothing here would fail.
