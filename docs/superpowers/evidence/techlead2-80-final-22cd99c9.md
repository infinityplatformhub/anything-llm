# Techlead-2 review — #80 (S11a) final `22cd99c9`

**Verdict: PASS.** All three gaps from my review of `719b7eee` are closed and mutation-verified
against the state they were about. Nine mutations run, eight caught; the survivor is an
equivalent mutant under the current ruling, explained below.

Independent worktree `/tmp/tl2-80c` (`git worktree add --detach`), `node_modules`
hardlink-copied from `/tmp/qa1-80`, `prisma generate` run, Node v22.23.1, my own PostgreSQL 16
on `:55472`. Per §7.14 no full-directory run. Worktree clean; all five mutated files restored.

Baseline: **98 passed, 98 total** across six suites, no skips.

---

## GAP-1 — closed, and the test is written the only way that works

Removing `smtp_allow_untrusted_cert` from `SETTING_KEYS` now fails **1 test** (it failed none
on `719b7eee`).

What makes this fix better than the obvious one is stated in the test itself. The pre-existing
`"changing ANY connection field changes the hash"` test iterates `SETTING_KEYS` — so deleting
a key deletes its own case, and the suite stays green while a connection-determining field
silently stops invalidating the proof. The new test names the eight fields **explicitly** and
asserts `SETTING_KEYS` equals that list, then checks each one changes the digest.

The comment records the measurement rather than the intention: *"Measured — dropping
`smtp_allow_untrusted_cert` left 12/12 passing."* That is the same defect class as QA-1's M7 on
slice 2 and my `EXEMPT_IN_CI` note on #73 — an assertion driven by the data it is meant to
constrain can only agree with itself.

## GAP-2 — closed

Disabling the `/v1` guard now fails **1 test** (0 before). `GAP-2: /v1 refuses an address
rather than ignoring it` creates a real API key scoped `invite.create`, posts an `email`, and
asserts 400 with `invite: null`. The route is exercised end to end rather than asserted on its
source.

## GAP-3b — closed, and `mailed` became a field rather than a message

Flipping `mailed: false` to `true` on the send-failure path now fails **1 test** (0 before).

TL-1's NIT-2 improved my finding: the response carries a boolean `mailed`, so the UI branches
on a field instead of string-matching prose that will be translated and reworded. Three tests
cover the three states — `mailed: true` on success, `false` for a copy-link invite, and
`false` **with** an error when the send fails after a successful create.

## GAP-3a — survives, and it is equivalent under ruling D

Dropping the recipient from `notificationId` leaves 87/87 green.

The test exists and executes — I confirmed with `-t` that
`GAP-3: two invites to different addresses each send` runs and passes. It cannot catch this
mutation because the two invites have different `invite.id` values, so `invite:${id}` alone is
already distinct. The test proves two separate invitations each send, which is true whether or
not the address is in the key.

The case that would catch it is **one invite, two addresses** — which ruling D forbids
(`requestedAddress` throws on an array: *"Send one invitation at a time."*). So there is no
reachable input that distinguishes the two implementations today.

**Equivalent mutant, not a coverage gap.** The recipient in the key stops being decorative the
moment more than one recipient per notification becomes possible, so it is worth a residual
line — guarding a future ruling, not a present hole. Leaving it in costs nothing and removing
it would have to be undone.

## New work in this SHA, not previously reviewed

**Email masking (TL-1).** `invites.email` was always null before this issue, so the listings
returned whole rows harmlessly; populating the column turned `GET /admin/invites` into a roster
of every address invited, readable by anyone holding `invite.read`. The change masks to
`j***@example.com` unless the caller holds `user.manage`, and the model comment says plainly
that *"this change created the exposure, so it closes it."*

Masked rather than removed is the right call — an admin needs to tell rows apart. Four
mutations, all caught:

| mutation | result |
|---|---|
| `whereWithUsers` stops masking | **3 failed** |
| `unmaskEmail` defaults to true when absent | **2 failed** |
| mask keeps the whole local part | **3 failed** |
| admin listing skips the `user.manage` check | **2 failed** |

A test also asserts the mask does not reveal the original local part's length, which is the
detail that makes a one-character prefix meaningful rather than cosmetic.

**The save gate is wired into a real route** (`endpoints/mailer.js`), behind `system.write`
rather than `settings.write` with the reason given: these carry a relay credential and open an
outbound connection to a caller-named host. Three things it gets right:

- It refuses **before writing either table**, so a never-proven configuration is not saved and
  reported as fine.
- The credential is persisted **before** the settings, because a verified marker written
  against a credential the next boot cannot find would claim a working configuration while
  every send failed.
- The test-send error returns a class, never the transport's message — nodemailer quotes the
  failing command, and for an auth failure that command carries the credential.

**Rate limiting is metered only when it will actually send.** `whenMailing(inviteMailRateLimit)`
leaves copy-link invites unmetered; removing the wrapper fails **2 tests**. The ceiling tests
use the **shipped default** rather than setting the env, with the reason stated: a test that
configures its own ceiling proves the limiter reads config, not that the default protects
anything. That is the distinction QA-3's original finding was about.

## Mutation summary

| # | mutation | result |
|---|---|---|
| G1 | `SETTING_KEYS` drops `smtp_allow_untrusted_cert` | **1 failed** (was 0) |
| G2 | `/v1` silently drops the email again | **1 failed** (was 0) |
| G3a | `notificationId` drops the recipient | 0 — equivalent, see above |
| G3b | send failure reports `mailed: true` | **1 failed** (was 0) |
| MASK1 | `whereWithUsers` stops masking | **3 failed** |
| MASK2 | `unmaskEmail` defaults to true | **2 failed** |
| MASK3 | mask keeps the whole local part | **3 failed** |
| MASK4 | admin listing always unmasks | **2 failed** |
| RL1 | `whenMailing` wrapper removed | **2 failed** |

## Reproduction

```
git worktree add --detach /tmp/tl2-80c 22cd99c9
cp -al /tmp/qa1-80/server/node_modules /tmp/tl2-80c/server/node_modules
cd /tmp/tl2-80c/server && npx prisma generate
export PATH="/opt/homebrew/opt/node@22/bin:$PATH" STORAGE_DIR=$(mktemp -d) \
       SIG_KEY=$(openssl rand -hex 32) SIG_SALT=b API_KEY_PEPPER=$(openssl rand -hex 32) \
       DATABASE_URL="postgresql://postgres:pw@127.0.0.1:55472/t5"
npx jest __tests__/security/notifications/ __tests__/models/inviteCreate.test.js \
         __tests__/utils/helpers/credentialPersistence.test.js --runInBand
```

`SIG_KEY` must be ≥32 characters or `configHash` throws by design. Mutations were applied to
working copies of `utils/notifications/{mailerSettings,inviteMailer}.js`,
`endpoints/admin.js`, `endpoints/api/admin/index.js` and `models/invite.js`, each restored
immediately after its run.
