# QA-3 — #104 pre-review: the three RF findings measured on `main` before a SHA exists

Worktree `/tmp/qa3-104` at `main` `91ecc705d`, own install, database `qa3_104` fresh
(`migrate deploy` + `seed`). Node 22. Nothing here reviews a fix — it establishes what the
defect actually does, so the fix can be measured against a number rather than a claim.

Method: `CredentialStore.set` is wrapped so it returns `{error}` for **one named key** and
behaves normally for every other. Everything else — routes, auth, `updateENV`,
`loadStoredCredentials` — is the real thing.

## RF-3: a failed persist does not stop the loop, and is not reported

Two `secret: true` keys in one body; the first one's persist fails.

```
result:                {"newValues":{"OpenAiKey":"**********","AnthropicApiKey":"**********"},"error":false}
process.env OPEN_AI_KEY:      "sk-first-key-fails"
process.env ANTHROPIC_API_KEY:"sk-ant-second-key"
stored row  OPEN_AI_KEY:      null
stored row  ANTHROPIC_API_KEY:"sk-ant-second-key"
caller told about the failure? NO   (error === false)
```

So the second key still writes — which is the behaviour TL-1 wants preserved — but
`newValues` reports **both** keys as changed and `error` is `false`. The caller is told two
credentials were set when one of them exists only in this process's memory.

Note the ordering trap for whoever writes the fix: `newValues[key] = nextValue` happens
**before** `persistCredential`, so accumulating the error is not enough on its own — the
key stays in `newValues` unless that is also addressed. RF-3 as written ("newValues reports
the key that succeeded") is satisfiable either by removing the failed key or by leaving
both and relying on `error`; those are different contracts and the issue should say which.

## The end-to-end that makes it concrete

```
updateENV said:   {"error":false,"newValues":{"OpenAiKey":"**********"}}
live value now:   "sk-rotated-but-not-persisted"
-- simulate restart: unset the live var, run loadStoredCredentials() --
after restart:    undefined     loaded: []
value survived a restart? NO
```

An operator rotates a provider key, sees a success, and the key is gone at the next
restart with no row to load. The console does carry
`[credential-store] … is live for this process but was not persisted; it will be lost on
restart`, so the information exists — it is just not on the path the caller reads.

## RF-1: `update-password` reports success when AUTH_TOKEN was not persisted

Fired through `POST /api/system/update-password` with a real single-user session token.

```
status=200 body={"success":true,"error":false}
live AUTH_TOKEN changed = true  -> "qa3-104-new-pass"
stored AUTH_TOKEN row   = null
caller told it failed?  NO
```

Worse than the provider-key case: the operator has been told their password changed. It
did change, for this process. After a restart `AUTH_TOKEN` reverts to whatever the
environment supplies — the new password stops working and the old one may resume. Both
outcomes are silent.

## RF-2: `enable-multi-user` completes with JWT_SECRET unpersisted, rollback never runs

```
pre:    stored JWT_SECRET row = null      (cleared first — see note)
status=200 body={"success":true,"error":null}
multi_user_mode = "true"      users = 1
stored JWT_SECRET row = null
rollback ran? NO
```

The route's `catch` block holds a careful rollback (`User.delete({})` plus resetting
`multi_user_mode`, with its own check on the reset per #59). It never runs, because the
`await updateENV({JWTSecret: …}, true)` at `system.js:878` discards the result and nothing
throws. The instance is left multi-user with an admin whose sessions are signed by a secret
that exists only in memory.

**A note on my own probe.** My first run reported `stored JWT_SECRET row =` a real uuid and
I nearly recorded that as "the write succeeded". It had not: RF-1 ran first in the same
file, rotated `JWT_SECRET` through `update-password`, and persisted it. The row I was
reading was RF-1's. Deleting the row before RF-2 gives the result above. Recording this
because the same trap is waiting in the fix's test suite — these two routes both write
`JWT_SECRET`, and a test that does not clear between them will read the neighbour's row.

## What I will fire once the SHA lands

1. RF-1/RF-2/RF-3 re-run unchanged — the numbers above become the before/after pair.
2. The end-to-end restart probe: rotate → clear live env → `loadStoredCredentials()` →
   the value must either be present or the caller must have been told it was not.
3. RF-2's rollback must be **observed running**, not inferred from a 500: `users` back to
   0 and `multi_user_mode` back to `false`, per your instruction.
4. All three `updateENV` callers driven for real (the two above plus `POST
   /system/update-env`), 200-vs-500 checked at each.
5. Mutation `accumulate → break`: must redden RF-3 specifically, and the surviving-write
   claim must be what fails, not just the status.
6. Mutation: discard the accumulated error at each caller in turn — each should redden a
   different test, the way #80's hotfix did.

Two things to settle before the SHA, both of which change what "correct" means:

- **Does `newValues` keep the failed key?** (contract question above)
- **Does `update-password` roll back?** It has no rollback today. If `AUTH_TOKEN` persists
  but `JWT_SECRET` does not, the process is left with a live password nobody can
  authenticate against after a restart. Reporting `success:false` is the minimum; whether
  it also restores the previous values is a design decision, not a detail.

Files touched by me: none in the repository. Probe files live under
`/tmp/qa3-104/server/__tests__/qa3probe/` and are deleted after the run.
