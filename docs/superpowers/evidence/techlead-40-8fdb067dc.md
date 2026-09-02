# Techlead-1 — #40 rebased `8fdb067dc` (delta from my PASS at `a2bbb0de`)

Scope of this read: the sweep's own delta only — `routeGateSweep.test.js` (+24/-9),
`index.js` (+6). The other 290 files in the range are #60/#80/#30/#90 lanes already reviewed
or owned by TL-2's inventory diff.

**Verdict: PASS.** The LDAP allowlist entry is the right call. Two NITs, neither blocking.

Method: source reads plus in-process `node -e` counting over the committed trees. Per §7.14
I did not run the suite.

## 309 → 316 — the re-pin is arithmetic, not a rubber stamp

Counted `app.<verb>(` mounts across every `server/endpoints/**` file in both trees:

| | `a2bbb0de` | `8fdb067dc` | Δ |
|---|---|---|---|
| endpoint-file mounts | 304 | 311 | **+7** |

Snapshot moved 309 → 316, also **+7**. The seven are accounted for individually:

- `identity/ldap.js` — `GET /sso/ldap/enabled`, `POST /sso/ldap/login` (new file, #60)
- `mailer.js` — `GET /mailer/settings`, `POST /mailer/test`, `POST /mailer/settings` (#80)
- `system.js` — `GET /metrics` (#90)
- `workspaces.js` — `GET /workspace/:slug/chats/search` (#30)

Of those, **three are mutating**: the two `POST /mailer/*` carry
`requirePermission("system.write", orgResource)` and pass the gate on their own, and
`POST /sso/ldap/login` is the one new allowlist entry. So a single line was added to
`INTENTIONAL_NON_PERMISSION_MUTATIONS` for a delta of seven routes, which is the ratio you
want to see — the number moved because routes were added, not to make a red test green.

`index.js` delta is three requires and three registrations, with the ordering comment
naming the `cd4fda5e` defect (a concrete `/sso/` route must precede S1's wildcard). Nothing
in `ENDPOINT_REGISTRATIONS` was removed.

## The LDAP allowlist entry — I agree, with the reason amended

```js
["POST /sso/ldap/login", "unauthenticated LDAP login ingress"],
```

Correct, and the same class as `POST /request-token` and `POST /sso/saml/acs` already in the
map: the request arrives with no principal, so `requirePermission` has no actor to decide
on, and forcing a gate there would only mean gating on `SINGLE_USER_ACTOR` or similar — the
widest actor in the system — which is worse than no gate.

Checked what actually bounds it, rather than accepting the reason as written:

- `[inviteRateLimit, loginAccountRateLimit]` — per-IP plus per-(ip, username), matching
  local login. The account-keyed bucket is the one that matters; without it an attacker
  inside the IP budget spends all of it on one account.
- Plaintext `ldap://` without StartTLS is refused with 503 unless explicitly allowed, and
  the refusal message to the caller carries no detail.
- Unknown user and wrong password return one flat refusal; only `IdentityConflictError`
  differs, which is the one case the caller can act on.
- `linkPrincipal` refuses `emailVerified !== true` independently of the driver, refuses
  auto-linking on email match (R1), and refuses a derived-handle collision when the target
  is a local account.

**NIT-1 — the reason understates what the route does.** "Unauthenticated login ingress"
reads as *this route only checks a credential*. It does more: on success `linkPrincipal`
**creates a user row, calls `syncLegacyRoleGrant`, and creates an `identity_links` row**.
JIT provisioning is the intended design and the directory bind is what bounds it, but the
allowlist reason is the thing a future reader consults when deciding whether a new
side-effect belongs on this route. A reason that says "login ingress" invites someone to add
a write here on the grounds that the route was already exempt. Suggest:

```js
["POST /sso/ldap/login",
 "unauthenticated LDAP login ingress; provisions a user + default grant on first bind, bounded by the directory not by us"],
```

The comment block above the entry already says "Plaintext-bind and rate-limit protections
live in the LDAP driver (#60), not at this gate" — this is the same sentence applied to
provisioning, which is currently unstated.

**NIT-2 — the comment says "login/discovery", the map holds only login.**
`GET /sso/ldap/enabled` is not in the map and does not need to be: the sweep filters out
`get`/`head` before building signatures, so it was never a candidate. The comment naming
both routes implies discovery was considered and exempted here, when in fact it is outside
this test's subject entirely. One word (`login`) fixes it. Purely a reading hazard.

## The two NITs from `a2bbb0de` are closed

**Allowlist signature collision** — the assertion now filters and requires
`toHaveLength(1)`, and iterates `Object.keys(layer.route.methods)` rather than taking
`[0]`, so a layer mounted for two verbs cannot hide one of them. Under the old
`.some(... methods[0] ...)` form a second layer with the same signature would have inherited
the first's reason silently; it now fails. This is the change I asked for and it is
subtractive-safe: an entry whose route disappears matches zero layers and goes red, an entry
matching two goes red as well.

**The AST error message** now tells the author what to do with a non-module string literal
("move it out of index.js or declare an exception") rather than only what is unsupported.

## Residual, unchanged from `a2bbb0de`

`routesAtAssertion` is a synchronous snapshot; a route mounted asynchronously after the
assertion runs is outside the contract. The comment says so. Still the honest limit of this
test, and still not something this issue can close.
