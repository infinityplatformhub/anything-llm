# QA-3 evidence — #80 `e1bf4adb` (= code of `22cd99c9`) — PASS

Author: QA-3 (anything-llm-ea). Worktree `/tmp/qa3-80r`, own `yarn install` +
`prisma generate`, own database `qa3_80`. Supersedes the FAIL on `719b7eee`.

## The blocker is closed, and closed precisely

`inviteMailRateLimit` is now mounted at `endpoints/admin.js:301` as
`whenMailing(inviteMailRateLimit)`, and `mailerTestRateLimit` at
`endpoints/mailer.js:82`. Driven through the real route with the channel
verified:

```
G1 statuses=200,200,200,200,200,200,200,200,200,200,429,429,429,429,429
G1 accepted=10 refused=5 invitesCreated=10 rcptSent=10
```

Refused on the **eleventh**, against a ceiling of 10. The three numbers that
matter are on the second line: ten accepted, ten invite rows, ten `RCPT TO` on
the fixture — a 429 creates no invite and sends no mail, so the refusal is not
merely a status code in front of work that already happened.

On `719b7eee` the same fifteen requests were all served.

| id | check | result |
|---|---|---|
| G2 | a second admin's first request, after the first exhausted their bucket | **200** — buckets are per-actor, not global |
| G3 | six copy-link invites from the exhausted actor | all **200** — `whenMailing` skips the limiter when no address is present |

G3 is the part a blunt mount would have got wrong: an admin who has spent their
mail budget can still mint links to hand over themselves, because that costs the
relay nothing.

## Mailer settings routes

| id | check | result |
|---|---|---|
| H1 | save before any successful test | **409**, and `smtp_host` is **not** in `system_settings` — refused before either table is written |
| H2 | test → save | 200 → 200; then save with `smtp_port` changed → **409** |
| H4 | eight tests against a ceiling of six | `200,200,200,200,429,429,429,429` |
| H3 | the password, everywhere | see below |

H1 is ruling B enforced where it counts: the gate is the endpoint's, not the
wizard's, and nothing is persisted on the refusal path.

### The password

`GET /mailer/settings` returns the settings object with `hasPassword: true` and
no password field. A failing test (wrong credential) returns
`{ok: false, error: "The mail server could not be reached with these settings."}`
— the class of failure, not the transport's message, which for an auth failure
quotes the command carrying the credential.

Captured `console.log`/`console.error` across a GET, a save, and a failed test,
then searched for the real password, the wrong one, and the base64 `AUTH PLAIN`
blob: **none present in any form**.

## The listing leak this branch created

```
H5 with user.manage: ["person@example.com"]
H5 without:          ["p***@example.com"]
```

Same route, same invite, two callers. The masked form keeps one leading
character so an admin can still tell two rows apart, and the unmasking is
decided by a `user.manage` check on the actor rather than by the caller's role
string.

## Mutation

| mutant | result |
|---|---|
| unmount `inviteMailRateLimit` (reproduce the `719b7eee` bug) | **2 failed** |
| `whenMailing` applies unconditionally (copy-link spends the mail budget) | **1 failed** |
| save gate accepts an unverified configuration | **4 failed** |
| listing never masks | **3 failed** |
| **unmount `mailerTestRateLimit`** | **survives, 93/93** |

The survivor is the same shape as the blocker I reported last round, one route
over. `mailerSettingsRoutes.test.js:112` exercises `POST /api/mailer/test` but
never drives it past the ceiling, so removing the limiter from the route changes
no test outcome. The limiter is mounted and works — H4 proves that by hitting it
— but nothing in the suite would notice if it were removed again.

Not a blocker: the code is correct as shipped. Worth one test, the same shape as
G1: post eight tests and assert a 429. The connection test opens a socket to a
caller-supplied host and port, so an unmetered one is a port scanner — which is
why the limiter exists and why it should be pinned.

## Suites

`__tests__/security/notifications` + `__tests__/requestControlsHttp`: **93/93**.
