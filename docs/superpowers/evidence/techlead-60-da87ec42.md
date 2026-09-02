# Techlead review — #60 S3 LDAP, fixtures layer `da87ec42`

**Verdict: FAIL** — four findings, three of which must be fixed **before the LDAP client is
chosen**, because they are the difference between a mock that selects a client and a mock
that ratifies whichever one is picked.

The shape of the work is right: a deliberately unhelpful directory, its own test file
proving it bites (§7.9b), escaping as a separate module, all before a driver exists. The
comments carry reasoning rather than restating the code. What is wrong is narrower and worse
than a missing case: **the mock cannot be reached by a filter a real driver would build**, so
the injection trap — the whole point of the file — does not fire against the realistic naive
implementation.

Static review; I did not run the suite.

---

## FINDING-1 (blocker) — no entry carries `objectClass`, so a realistic filter matches nobody

`PEOPLE` entries carry `dn`, `uid`, `mail`, `cn`, `password`. No `objectClass`.

`matchesFilter` requires **every** clause to match for any filter not starting with `(|`.
So the shape essentially every real deployment configures —

```
(&(objectClass=inetOrgPerson)(uid=alice))
```

— evaluates `entry["objectClass"]` as `undefined`, returns false, and yields **zero
results**. A correctly written driver, given a correctly configured `userFilter`, gets
nothing from this directory.

Two bad outcomes follow, and the second is the dangerous one:

1. Every driver test fails for a reason that has nothing to do with the driver.
2. The author makes them pass by dropping the `objectClass` clause — shipping a filter
   looser than intended, tested against a mock that rewarded the looseness.

**And it breaks the injection fixture.** Real LDAP injection needs a base filter that already
contains `&` or `|`; the payload truncates the intended value and adds a clause:

```
(&(objectClass=inetOrgPerson)(uid=*)(uid=*))     ← input `*)(uid=*`
```

Against this mock that returns 0, not "everyone", because of the missing attribute.

The escape test's "concatenated filter matches more people" builds
`` `(|(uid=${attacker}))` `` — **the test supplies the leading `(|` itself**. No driver
produces that. What a naive driver actually produces is `(uid=alice)(uid=*)`, which does not
start with `(|`, so the mock takes the `every()` branch: alice matches `uid=alice` **and**
`uid=*`, result length 1, no widening. **A naively concatenating driver looks safe against
this fixture in the exact shape it would really be written.**

That is the `01888688` lesson in its LDAP form, and this time it is in the fixture the whole
issue is built on: the fixture proves the mock can widen when handed a filter nobody writes.

Fix, in order:
- give every `PEOPLE` entry `objectClass` (`["top", "inetOrgPerson"]` or equivalent), and
  make `matchesFilter` handle a multi-valued attribute;
- keep the base filter in the fixture in the realistic AND shape, and add an injection test
  whose payload is inserted into **that** filter rather than into an attacker-authored one;
- assert the widening from the driver's shape: `(&(objectClass=inetOrgPerson)(uid=*)(uid=*))`
  must return more than one person.

## FINDING-2 (blocker) — the DN case-variance fixture is described but does not exist

`directory.js:38-42`:

> `alice` and `Alice.Smith` differ only in DN case — the same person, and a driver that keys
> on the input rather than on the DN the search returned would make them two accounts.

**There is no `Alice.Smith` entry in `PEOPLE`.** The comment describes a fixture that was
never written, and no test covers DN case variance. The ruling's mandatory table lists it:
*"DN case variance — the DN from the SEARCH is used, never the user's input."*

A comment asserting a property the data does not have is worse than no comment: the next
reader takes it as covered. Add the entry (e.g. `uid=Alice,OU=People,DC=Example,DC=com`
resolving to the same person) and a test that a search by either spelling returns the
canonical DN.

## FINDING-3 (blocker) — `search()` works on an unbound connection

Ruling 1 is search-then-bind with a service account. `search()` never checks that a
successful service bind happened: a driver that skips the service bind entirely — or whose
service credentials are wrong and whose error it swallows — searches successfully here and
every test passes.

Real directories with anonymous read disabled refuse exactly that, which is the
configuration a deployment following this ruling would run. Track the last successful
authenticated bind and refuse `search` without one (with a flag to model an
anonymous-read-permitted server, since a driver must not *depend* on the refusal).

## FINDING-4 (medium) — the anonymous/unauthenticated distinction is conflated and mislabeled

`directory.js:135` cites **RFC 4513 §5.1.2** for what the file calls an *anonymous* bind.
§5.1.2 is the **unauthenticated** bind (a DN present, password empty). §5.1.1 is the
anonymous bind (**empty DN**, empty password). The ruling table lists the two separately, so
this is not pedantry — one row of the mandatory list is unimplemented under the other's name.

Three untested paths follow from the same branch:
- `bind("", "")` — the true anonymous case. Reachable in the mock, no test. A driver that
  passes a DN derived from a failed search can send `""` or `undefined` here.
- `bind(SERVICE_DN, "")` — a **misconfigured service account** binds "successfully" as
  anonymous, and the driver then searches on an unauthenticated connection. With FINDING-3
  unfixed, that whole path is invisible.
- `allowAnonymous: false` currently disables both cases with one flag; they are separate
  server settings.

---

## The four questions PMO asked

### (1) Is the mock unhelpful enough? Trap by trap

| trap | present | verdict |
|---|---|---|
| empty-password bind SUCCEEDS | yes | **correct and well built.** Returns `{authenticated:false, anonymous:true}` — resolves, with the discriminator right there and unignorable. Tested with `""`, `null`, `undefined`, plus the counterweight that a correct password is distinguishable (without it, a driver refusing everything would pass every negative test) |
| injection `*)(uid=*` widens | **partially** | fires only when the payload supplies the leading `(|` — FINDING-1 |
| duplicate uid across branches | yes | `uid=duplicate` in `ou=people` and `ou=contractors`, test asserts two results with different DNs. The comment naming it "the LDAP spelling of S2's XSW document-order bug" is exactly right: the code picks between two candidates and the attacker picks which |
| StartTLS failure does not fall back | yes | **the best fixture in the file.** It asserts the throw *and* that `tlsActive` stays false *and* that a subsequent bind is refused with `confidentialityRequired` — three-step, so a driver that swallows the StartTLS error still cannot bind. A one-line `rejects.toThrow` would have proved nothing about the downgrade |
| referral is an error | yes, search only | see NIT-1 |

`requireTls` defaulting true, with `tls:false` modelling a server that refuses plaintext, is
the right default: the deployment's directory is not ours to configure, and a driver must not
depend on the server being hardened. Both test comments say so.

### (2) Which mandatory fixtures are still missing

Against the ruling's table:

| fixture | status |
|---|---|
| empty password refused **before** the bind | mock supports it — `calls.binds` is recorded, so a driver test can assert the array is empty. Nothing asserts it yet; that is a driver-layer test and correctly absent here |
| unauthenticated bind | **missing as a distinct case** — FINDING-4 |
| injection escaped, authenticates nobody | **present but does not bite** — FINDING-1 |
| multiple search results refused | fixture present; the refusal is driver-layer |
| **zero results byte-identical to a wrong password** | correctly **not** a fixture property. The mock's obligation is only that "no such user" is an ordinary empty list and not a distinctive throw — which is exactly what `a search for nobody returns an empty list, not an error` asserts, with the right reason in the comment. Byte-identity is a route-layer assertion against the HTTP response, and belongs with `POST /sso/ldap/login` |
| referral not followed | fixture present, search only |
| **DN case variance** | **missing** — FINDING-2 |
| StartTLS downgrade | present, and strong |

Also worth adding while the file is open: a person whose `cn` or `mail` legitimately contains
`(` or `*`, so escaping can be shown to **preserve** a real value rather than only to
neutralise an attack. Escaping that mangles ordinary input is removed by whoever hits the
first false rejection.

### (3) `ldapEscape.js` — RFC 4515/4514

**Correct on the point that matters.** The five RFC 4515 characters are all handled, and the
backslash goes first. The comment explains why the ordering is load-bearing — escaping `(`
before `\` turns `\(` into `\` + `\28`, and the later backslash pass mangles the escape just
written — and `escapeFilterValue("\\(") === "\\5c\\28"` pins it. That is the single most
common way this helper is written wrong, and it is both correct and tested.

`null`/`undefined` → `""` rather than `"null"` is right, with the right reason: `"null"` is a
legal filter value that would match a user unlucky enough to be named that, instead of
matching nobody.

`escapeDn` also escapes backslash first, covers `,+"<>;=`, and handles leading/trailing space
and leading `#`. Two gaps, both NIT-level: **NUL is not escaped** (RFC 4514 requires `\00`;
the filter function handles it, so the omission is inconsistent rather than reasoned), and
a trailing-space test would not catch a value of exactly `" "` — the leading rule fires and
the trailing one then sees no trailing space.

The end-to-end section is the right idea — escaping proved against the real fixture rather
than by inspection — but its "concatenated filter matches more people" case is the one
FINDING-1 invalidates.

One thing the mock cannot currently verify: it never **unescapes**, so
`(uid=alice\29\28uid=\2a)` matches nobody by string comparison rather than because a real
server unescaped it to a literal that no uid holds. Same answer, different reason. It becomes
a real gap once a fixture person's value legitimately contains `*`.

### (4) Does `ldapDirectoryFixtures.test.js` prove the mock bites?

**Yes, and this file is the reason the three findings above are findings rather than
opinions** — testing the fixture is what makes its gaps visible at all. Most projects never
write it.

The four properties it gets right:
- the empty-password case asserts the call **resolves** and carries `anonymous: true`, so the
  trap is characterised rather than merely named;
- every dangerous assertion has a counterweight (correct password distinguishable; wrong
  password throws `invalidCredentials`) — without these, "refuses everything" would pass;
- `search results never carry the password attribute` and `the DN in a result is
  authoritative` pin the two things a driver is supposed to rely on;
- the StartTLS case asserts the downgrade cannot happen, not just that a call threw.

What it does not yet do is assert the mock bites **in the shape the driver will use it** —
FINDING-1. The file's own docblock states the standard it misses: *"a mock that refuses an
empty password is not a strict mock, it is a broken one"* — the same sentence applies to a
mock that only widens for a filter no driver writes.

---

## NIT-1 — referral only on `search`

Real servers can return a referral on **bind** too, and a driver that follows one there has
handed authentication to a host nobody chose — the more direct version of the attack the
search referral models. One flag, both operations.

## NIT-2 — `matchesFilter`'s attribute pattern is `[a-zA-Z]+`

Excludes digits and hyphens, so `msDS-*` and any numbered attribute silently fail to match —
they take the `undefined` path and read as "this person does not have it". Same failure shape
as FINDING-1, smaller blast radius. `[a-zA-Z0-9;-]+` covers real attribute names including
option tags.

## NIT-3 — `calls.binds` stores plaintext passwords

Correct for a helper that must let a test assert *whether* a bind happened, but a failing
test that dumps `calls` prints them. Record a boolean or a hash unless a test needs the
value; if the value is needed, name the field so nobody logs the array casually.

## NOTE — where this sits relative to the ruling

Nothing here contradicts rulings 1–5; the gaps are all "the fixture does not yet reach the
behaviour the ruling names". Ruling 1's search-then-bind is the one with the most fixture
surface still missing (FINDING-3 and FINDING-4's service-DN case both live inside it), which
is expected at this slice — but they should land **before** the client is chosen, since
"does this client let me tell an anonymous bind from an authenticated one" is precisely a
selection criterion.
