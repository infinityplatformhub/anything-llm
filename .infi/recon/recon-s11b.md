# S11b recon — mailer settings UI (mockup B, guided setup)

Read-only. Base `182970699` on `approof/49-embed-session`; S11b will branch from `approof/main`.

Backend is S11a (#80), merged. Mockup B approved by the user at
`docs/superpowers/mockups/s11-smtp-b-guided-setup.html` @ `5ac9facf2` — SHA verified to exist,
to contain that file, and to be an ancestor of HEAD.

---

## What the backend actually offers

Three routes, all in `server/endpoints/mailer.js`, all gated
`[validatedRequest, requirePermission("system.write", orgResource)]`:

| route | returns |
|---|---|
| `GET /mailer/settings` | `{settings: {...,hasPassword}, verified}` |
| `POST /mailer/test` | `{ok}` or 400 `{ok:false,error}` — rate limited by `mailerTestRateLimit` |
| `POST /mailer/settings` | `{saved:true}` / 409 / 500 |

**The password is already never returned.** `GET` sends `hasPassword: Boolean(password)` and
nothing else (`mailer.js:62-72`), with the reasoning in place: a password rendered into a form
is a password in the page source, the browser cache, and any screenshot. So the "mask on read
back" requirement is not a backend fix — it is a **frontend obligation not to reintroduce it**,
and that is what S11b must be tested against.

## The stepper is the API's contract, not styling

`POST /mailer/settings` refuses with **409** unless a test with these EXACT settings has already
passed: it recomputes `configHash(settings, password)` and compares it to the stored
`VERIFIED_HASH_KEY` (`mailer.js:180-189`). Change one character of the host — or the password —
and the hash stops matching, so the proof expires by construction.

That means mockup B's shape is the only shape this API permits. A reviewer reading the stepper
as a visual choice might "simplify" it into a single form with a Save button, which would
produce a page that 409s on every save with no way for the admin to get out of it. Recorded
here so that reading is not available.

Save order, which the UI's error copy has to match: credential first, settings second, and a
distinct 500 for the split state where the credential persisted but the settings did not
(`mailer.js:206-222`). Nothing spans `credential_store` and `system_settings` transactionally —
recorded upstream as a residual, not something the UI can fix, but the UI must not claim
"saved" when it gets that 500.

## PMO ruling — mockup B step 3 ships as a summary, not a log

The approved mockup ends on a live delivery table (When / Recipient / Template / Status,
`queued` semantics). **There is no backend for it**: no notifications or delivery-log model in
`schema.prisma`, no endpoint serving one, and S11a shipped settings + test only.

Ruling: step 3 ships as **configuration summary + the most recent test result** (time,
recipient, status from the last `POST /mailer/test`). No table. A real log needs a schema, an
endpoint, and a retention policy — that is a slice, not UI work, and the user approved a FLOW,
not a schema. If wrong, the cost is small and recoverable: open S11c and add it.

**This must be stated plainly to the user in the contract comment** — which part of the mockup
they approved is not arriving in S11b, and where it went. A mockup approved and then silently
trimmed is the failure mode step 1.5 exists to prevent.

## Role check — and a real mismatch to resolve

The neighbouring page (`/settings/security`, `GeneralSettings/Security`) is mounted as
`<ManagerRoute Component={GeneralSecurity} />` (`frontend/src/main.jsx:190-196`), and route
guards live in `frontend/src/components/PrivateRoute/index.jsx:79` (`AdminRoute`) and `:108`
(`ManagerRoute`).

`can()` from #40 task 3 does NOT exist in the tree — #40 is still open — so S11b uses the
existing role-string guard and migrates later.

**But copying the neighbour would be wrong here.** Measured against the seeded data:

```
SELECT r.name FROM role_permissions rp
  JOIN roles r ON r.id=rp.role_id
  JOIN permissions p ON p.id=rp.permission_id
 WHERE p.action='system.write';
→ super_admin
```

and `legacyRoleGrants.js:23` maps `admin -> super_admin`, `manager -> member`,
`default -> member`. `member` does not hold `system.write`.

So a manager passes `ManagerRoute`, sees the mailer page, and gets **403 from every one of the
three calls** — a page that renders and cannot work. `AdminRoute` is the guard that matches the
backend gate, and S11b uses it. This is not a preference: it is the frontend agreeing with the
permission the server actually enforces.

Recorded for the #40 migration: when `can()` lands, this site becomes
`can("system.write")` and the role string goes away. Note added to #66 (which already tracks
workspace-scoped sites) that S11b is another such site.

## What S11b builds

- `frontend/src/pages/GeneralSettings/Mailer/` — the guided page, three steps.
- Route in `main.jsx` under `AdminRoute`, and a sidebar entry alongside the other admin items
  (`SettingsSidebar/index.jsx`, the `roles: ["admin"]` group).
- `frontend/src/models/` client for the three endpoints.

## Tests

- The password is never rendered into the DOM, never in a value attribute, and a reload after
  save does not repopulate it — asserted on the DOM, not on the model layer, because that is
  where a regression would actually appear.
- Save is unreachable until a test has passed (the 409 made visible as a flow, not a toast).
- Editing any field after a successful test invalidates the proof — because `configHash` says
  it does, and a UI that let the admin edit-then-save would produce a 409 they cannot explain.
- The plaintext (`none`) encryption choice requires the acceptance checkbox, and switching away
  and back clears it — consent is to a specific configuration.
- A manager is redirected rather than shown a page that 403s.
- The split-state 500 is reported as "not configured", never as saved.

## Open, for the contract comment

Step 3's log is deferred to S11c. The user sees that in writing before code starts.
