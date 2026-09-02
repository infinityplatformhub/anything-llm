# Techlead-1 — #138 scope: Lark is not in the provider registry

**Skills invoked:** `superpowers:requesting-code-review`; `security-review` checklist — secret
storage for a new provider, unconfigurable-feature surface. `infi-lessons` not invoked.

§7.14: no suite run. Source reads in the main checkout (read-only).

## Ruling: **(a) — ship the injected-driver seam, declare the residual, open the follow-up issue now**

Confirmed at source. `utils/identityProviders/index.js:14-18` registers `oidc`, `saml`, `ldap`
only; `identity_providers` (`schema.prisma:476-497`) has `entityId` / `ssoUrl` / `certificates`
plus the LDAP columns, and no `appId` / `appSecret`. So `resolveDriver("lark")` cannot succeed
and #138's schedule has nothing real to call.

Blocking on it would be blocking #138 on a defect **S4a shipped**, not one #138 introduces —
the driver merged without a way to configure it, and #138 is the issue that *found* that. Holding
the concurrency work hostage to a registration slice trades a merged, tested lease protocol for
a longer branch, and the seam is the honest interim: `runDirectorySync` takes an injected driver
and throws a **named** error otherwise. A named throw is a feature that says it is not wired;
silence would be the problem.

Three conditions on (a), all of which make the residual real rather than nominal:

1. **The named error must be reachable and asserted.** One test driving `runDirectorySync` with no injected driver and expecting that error by name. Without it the seam is a docblock, and the first person to wire a schedule discovers the gap in production.
2. **The residual is written where an operator reads it, not only in the ledger.** "Directory sync cannot be configured for Lark on this build" belongs in the issue's residual section and in the follow-up issue's title — not as a comment in a file nobody opens until they are already debugging.
3. **The follow-up is tier `auth`, and the secret path is already decided** — do not let the new issue re-litigate it. `endpoints/identity/ldap.js:54-57` sets the precedent verbatim: `CredentialStore.get("SSO_LDAP_BIND_PASSWORD")` first, env var as the bootstrap path, with the comment explaining that a bind password is a real secret unlike S2's public certificates. A Lark `appSecret` is the same category, so it is `CredentialStore.get("...") ?? process.env....`, and the follow-up copies that shape rather than inventing storage. Anything that puts `appSecret` in an `identity_providers` column in plaintext is a reject on sight.

One thing to name in the follow-up so it is not discovered late: the registry is a
**null-prototype** object on purpose (`index.js:12-13` — `provider` arrives from a URL, and a
plain object resolves `constructor` to a function). Registering Lark means adding a key there, not
building a second lookup beside it.
