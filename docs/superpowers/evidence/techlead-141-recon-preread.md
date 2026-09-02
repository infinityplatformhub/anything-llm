# Techlead-1 — pre-read of `recon-141.md` (`c8cf89780`): two rulings did not land

**Skills invoked:** `superpowers:requesting-code-review`; `security-review` checklist — schema
constraint correctness, secret storage, registry integrity. `infi-lessons` not invoked.

§7.14: no suite run. Source reads in a detached worktree (`/tmp/tl-141` at `c8cf89780`).

---

## Six of eight rulings are folded in, and two are better stated than I made them

Registry key on the null-prototype map with the "not a second lookup, not a branch" reasoning;
`SSO_LARK_APP_SECRET` in `CredentialStore` with env bootstrap and a plaintext column named as a
**reject**; resolution **through the registry** with the observation that every existing Lark test
requires the class directly and so proves nothing; `baseUrl` vs `tenantId` raised as the open
question with the right instinct (*"a column the driver does not read is a value nothing
consumes"*); the accept-then-silent fixture rather than a dead port; the memoisation hazard;
`auth` tier; sequencing after #138's queue merge.

**RF-4 and RF-6 are additions I did not ask for and both earn their place.** RF-4 asserts no
column holds the secret — so a *future* `appSecret TEXT` column fails a test rather than passing
review. RF-6 pins `isKnownProvider("constructor")` false, which is the exact thing a "simplify the
map" edit would break, and it exists because §1's one-line change is where that edit would happen.

---

## FINDING 1 (blocking the migration section) — the recon does not know about `identity_providers_one_shape`

`grep one_shape recon-141.md` returns **zero**. The constraint is live at this SHA
(`20260902092000_identity_providers_one_shape`, and `schema.prisma:464` documents it because
Prisma cannot express it). It is a **two-branch CHECK**, and a Lark row satisfies neither:

- SAML branch needs `entityId <> '' AND ssoUrl <> '' AND ldapUrl IS NULL AND baseDn IS NULL AND bindDn IS NULL`
- LDAP branch needs `ldapUrl IS NOT NULL AND baseDn IS NOT NULL AND bindDn IS NOT NULL AND entityId = '' AND ssoUrl = ''`

So **RF-3 ("a lark row saves") fails on the CHECK, not on NOT NULL** — and it keeps failing after
the recon's proposed migration, because dropping NOT NULL does not add a branch. The recon
diagnoses the wrong blocker, and the fix it proposes does not unblock its own RF.

The constraint's own comment anticipates this: *"the next provider kind edits this constraint. That
is deliberate: it is a visible edit in a migration, not a silent gap."* **#141 is that next
provider kind, and the third branch is the first thing to write, not the last** — nothing else in
the issue can be tested until a row can exist.

Two carried conditions the branch must meet, both from `092000`'s own reasoning:
- **It must not name `provider`.** That column is the free-text UNIQUE registry key, and the schema tests write `saml-<hex>` / `ldap-<hex>` into it. A `provider = 'lark'` clause lets a row select its own validation rule by its own name.
- **Empty string stays load-bearing.** The Lark branch asserts `entityId = '' AND ssoUrl = ''` and the LDAP columns NULL, the way the LDAP branch does — otherwise a half-Lark-half-SAML row becomes representable again.

## FINDING 2 (reverses the recon's proposal) — **do not drop NOT NULL; my ruling `a44800a9c` says keep it, and the recon has the opposite**

The recon calls dropping NOT NULL *"the honest completion"* of S3's choice and flags it for a
Techlead. I already ruled it, and the ruling is **keep NOT NULL and write empty strings** — the
recon predates or missed that fold.

The reason is that the empty string **is the existing encoding**, not a workaround.
`schema.prisma:469-472` states it: *"`entityId` and `ssoUrl` are NOT NULL, and an empty string is
how a row says 'not a SAML provider'. The constraint reads it as absence. Making either optional
here inverts every clause of that constraint, and Prisma will let you do it silently."* Both
columns carry a `COMMENT ON COLUMN` saying the same thing. **An LDAP row today already writes empty
strings there** — so a Lark row doing it follows precedent rather than "inventing SAML values".

Dropping NOT NULL would require rewriting all three branches (`= ''` becomes `IS NULL OR = ''`
everywhere), leaves pre-migration rows on the old encoding, and loosens a guarantee every SAML row
holds today — to accommodate one new provider, when the third branch makes the row legal with the
encoding unchanged.

**So the recon's §2 migration block should be:** add `appId` (and `baseUrl` if the driver needs
it) nullable; add the third CHECK branch; add `COMMENT ON COLUMN` for each new column in the
`092000` style. **No `DROP NOT NULL`.**

## Two smaller notes

**§6 Q1 is already answered by measurement**: the constructor takes `baseUrl` (`index.js:86,93,114`,
defaulted and right-trimmed) and has no `tenant` parameter. Name the column **`baseUrl`** or omit
it — a column the driver does not read is the defect the recon itself names.

**§6 Q3 is already ruled**: the test writes the row directly; **no configuration endpoint in
#141**. That is a new authenticated surface with its own permission question, and folding it in
turns a registration into a feature. Record the residual plainly — there is no way to configure a
Lark provider through the product — the same disposition as #138's declared seam.

## Disposition

Sound recon with two additions of its own that improve on my rulings. **Fix §2 before Dev3 starts**:
the blocker is the CHECK constraint, not NOT NULL, and the proposed `DROP NOT NULL` is the
opposite of the ruling. Everything else is ready.
