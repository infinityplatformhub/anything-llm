# QA-1 pre-review — S11a / #80 invite expiry + mailer (main `d65973bc`)

Read-only. No SHA under test yet; this records what I measured on main so the RED cases are
pinned before Dev3 writes code, and so the probe plan is on the record rather than in a
message.

## O1 — the redemption oracle is already open today, and not where expiry will close it

`endpoints/invite.js` `POST /invite/:code` has three exits:

| condition | body |
|---|---|
| code unknown, or `status !== "pending"` | `{success:false, error:"Invite not found or is invalid."}` |
| `User.create` fails | `{success:false, error:<User.create's message>}` |
| success | `{success:true, error:null}` |

The first two are **not identical**. An attacker who posts a username that collides with an
existing account learns which branch ran: an unusable code stops at the lookup and returns
the fixed string, while a **valid, still-pending** code proceeds to `User.create` and comes
back with a different error. That confirms the code exists without redeeming it.

This predates S11a. It matters here because S11a adds a fourth state (expired) to the
*first* row. A test that only asserts "expired reads the same as unknown" passes while the
real oracle stays open.

**Ruling received:** fixed under #80 — uniform failure body, and username validation moves
ahead of the lookup.

**Probe:** all three states compared as **raw response text plus `content-length`**, not
parsed JSON — key order can differ while parsed objects compare equal, and a length
difference is readable without the body. Plus a separate assertion for the
`User.create`-failure path, so closing it is proven rather than assumed.

## O2 — `Invite.get` is the right single point; `deactivate` is the exception

`models/invite.js:79-87` is a bare `findFirst`. No code outside the model queries
`prisma.invites` directly, so expiry enforced in `get` covers both redemption routes with no
new branch — as the recon proposes.

The one caller that does **not** go through `get` is `deactivate` (`models/invite.js:28-33`),
which uses its own `findUnique`. **Ruling received:** deactivate passes for expired invites
(an admin tidying an expired row is a legitimate action).

## O3 — migration must not backfill existing rows

`invites` today has neither `email` nor `expiresAt` (`schema.prisma:48-57`).

The risk in slot 093000 is a column-level `DEFAULT`: existing invites would silently acquire
an expiry dated from the migration, and every legacy link would stop working seven days
after deploy — an outage invisible at merge time, because the suite runs against a fresh
database where no legacy row exists.

**Ruling received:** no column `DEFAULT`; the 7-day value is set by the creating code path.

**Probe:** seed an invite on the pre-migration schema, run `migrate deploy`, then assert the
legacy row still has `expiresAt IS NULL` **and still redeems**.

## O4 — "mailed implies expiring" belongs in the model

Two routes create invites (`endpoints/admin.js:277`, `endpoints/api/admin/index.js:365`) and
both call `Invite.create`, which today accepts only `createdByUserId` and `workspaceIds`.
Enforcing the rule at the routes would be two copies — the same shape that left the two
redemption status checks byte-identical by coincidence rather than construction.

**Ruling received:** enforce in the model.

**Probe:** mutation — remove the model-side validation and confirm something goes red. If
only a route test fails, `/v1` can still mint a non-expiring mailed invite.

## O5 — listing keeps showing expired invites

`whereWithUsers` is deliberately unfiltered so an admin can see that an invite expired
unredeemed. **Ruling received:** intended, including on `/v1/admin/invites`; recorded in the
note. Worth stating explicitly because the published API surface therefore reveals how many
expired invites exist, while the redemption path reveals nothing — the asymmetry is
deliberate, not an oversight.

## Probe set for the SHA

1. Three states byte-identical on `POST /invite/:code` — unknown / expired / claimed —
   comparing raw text and `content-length`.
2. The `User.create`-failure path no longer distinguishes a valid code (O1's actual fix).
3. `GET /invite/:code` for an expired code reads as not-found.
4. Legacy rows survive the migration: `expiresAt IS NULL`, still redeemable.
5. A mailed invite without `expiresAt` cannot be created through either route.
6. Copy-link invites still create with no expiry and still redeem.
7. Malformed email refused at the route with no row written.
8. Mutations: drop the expiry check in `Invite.get`; remove the model-side mailed-invite
   validation; make the failure bodies differ again. Each must turn a distinct test red.
