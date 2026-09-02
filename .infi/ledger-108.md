# ledger — #108 S11b mailer settings UI

Branch `approof/108-mailer-ui`, base `5041a0a55`, SHA `5992b34b9`.
Recon: `.infi/recon/recon-s11b.md`. Mockup B approved at
`docs/superpowers/mockups/s11-smtp-b-guided-setup.html` @ `5ac9facf2`.
Contract: `cd frontend && yarn test` → `Tests  24 passed (24)`; server guard 6/6 (#111).

---

## Rulings

Ruling: the page is mounted under **`AdminRoute`, not `ManagerRoute`** like the
`/settings/security` page beside it. Measured, not assumed — only `super_admin` holds
`system.write`:

```
SELECT r.name FROM role_permissions rp
  JOIN roles r ON r.id = rp.role_id
  JOIN permissions p ON p.id = rp.permission_id
 WHERE p.action = 'system.write';   →  super_admin
```

and `legacyRoleGrants.js:23` maps `admin -> super_admin`, `manager -> member`. All three mailer
routes are gated on that action, so under `ManagerRoute` a manager would see the page and get
403 from every call — renders fine, cannot work. The asymmetry with the neighbouring page is
deliberate and will read as an inconsistency to a reviewer, so it is recorded on #66 as well.
If wrong: a manager who should have access is redirected, which is visible and one line to fix.

Ruling: **mockup B step 3 ships as a summary**, not the delivery-log table the user approved.
No notifications model in `schema.prisma`, no endpoint serving one; a log needs a table, an
endpoint and a retention policy, which is a slice rather than UI work. Deferred to **#107**, and
— the part that matters — stated plainly to the user in #108's own body rather than trimmed
silently. A mockup approved and then quietly reduced defeats the purpose of the approval step.

Ruling (F-3): the password lives in React state **for the life of the wizard**, and "never in
the DOM" is defined precisely rather than left to sound stronger than it is.
`configHash(settings, password)` binds the password, so a save that omits it hashes a different
input and is refused — the page cannot avoid holding it. What is asserted: never rendered from
a server response, never in `localStorage` or `sessionStorage`, never in an input value after
submit, and gone on reload. What is NOT asserted: that it never exists in memory. That claim is
false, and a test named for it would pass by not looking.

Ruling: the test recipient is sent as **`to`**, not `sendTo`. Caught by reading
`endpoints/mailer.js:95` rather than by trusting the mockup's field id. Any other key arrives as
an empty recipient and is refused with 400 — which reads as "your mail server rejected it",
sending the admin to debug their SMTP provider instead of the client. The suite drives the REAL
model client with `fetch` mocked at the boundary; mocking `@/models/mailer` would have asserted
the bug as correct.

Ruling: `smtp_allow_untrusted_cert` gets its **own checkbox, rendered unconditionally**. Mockup
B shows one acceptance box; the backend has two independent consents (TL-1 OBS-1 on #80), both
in the hash. Shipping the mockup literally would leave that field permanently `"false"` with no
way to reach it — a shipped capability with no UI. One box for both would be worse: an admin
accepting plaintext would silently also stop certificate verification, two exposures behind one
tick. Unconditional rather than shown only under TLS, because hiding it would couple the two
consents through the UI while the payload keeps them apart, and a box that disappears when the
encryption choice changes — while its value still ships — is its own bug. The label names the
consequence; a consent whose text does not say what stops happening is not informed.

## Corrections — what was wrong, and what caught it

Correction 1 (the class TL-2 warned about, third occurrence this cycle): the **N8 fixture passed
for the wrong reason**. The route guard renders a loader until its async session check resolves,
so every assertion ran against the loader and "the page is not shown" was true for EVERY role —
admin included. It only became a test once it waited for the loader to clear. Same shape as
#94's dotted host and #49's twin stamps: green because nothing had happened yet.

Correction 2: `useIsAuthenticated` is defined INSIDE `PrivateRoute/index.jsx`, not imported, so
it cannot be mocked. Its three dependencies are mocked instead — which is better anyway, since
the guard then runs the same code path production does rather than a stub that can drift.

Correction 3 (a real defect, surfaced by a test rather than by review): `getByLabelText(/^Password$/)`
found nothing because the hint text sat inside the `<label>`, making the accessible name
*"Password Encrypted at rest; never shown again."* A screen reader would have announced the
warning as the field's name. Labels now link by `htmlFor`/`id` with hints as siblings. The test
failure was the symptom; the accessibility defect was real and would have shipped.

## Mutation — five mutants, five DIFFERENT tests

No two land on the same test, so removing any one guard fails something specific rather than
something incidental.

| mutant | caught by |
|---|---|
| render the password into the summary | N7 password-not-in-DOM |
| one checkbox drives both consents | consent independence (mirror direction) |
| report 409 as a generic error | N9 "test again" |
| show Save after any completed test | N6 failed-test-does-not-unlock |
| widen `AdminRoute` to `ManagerRoute`'s check | N8 manager-is-refused |

Consent independence is asserted in BOTH directions. One direction alone would pass for a UI
that wired both boxes to the same state and happened to be read in that order.

## Note

Lint is 71 problems — identical to main's baseline, verified by stashing the work and
re-running rather than assumed. The four my files introduced were fixed.

## Residuals

- **Mockup B's delivery log is not built** (#107). Step 3 shows configuration plus the most
  recent test result.
- **#115** (`loadStoredCredentials` runs inside `listen()`) affects this page: during that
  window `GET /mailer/settings` reports `hasPassword: false` on a configured deployment, and an
  admin who retypes and saves in response overwrites a working credential. Not fixable here —
  it predates the UI and affects 97 `secret: true` keys.
- **`can()` migration**: this site uses a role-string guard until #40 task 3 lands; noted on #66.
