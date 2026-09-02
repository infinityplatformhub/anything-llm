# Techlead-1 review — #78 `86d2fe96` (Dev1, worktree `pr78`) — **PASS**, 2 NITs

Base is `08bbb989b`, and `git merge-base --is-ancestor 1e1ff638b HEAD` says **YES**:
this branch now sits on top of #72. Diff 11 files / +877 −54.

Per §7.14 no suites — behaviour probes against the branch's own module, as asked
(path behaviour, not grep). Reproduction at the end.

---

## FINDING-1 CLOSED — rebased, and the composition is real rather than asserted

The three conflicting files now carry **both** changes in the order I asked for.
`communityHub.js` is the one that mattered:

```js
const narrowed = await narrowManagerSystemPreferences(response.locals.actor, reqBody(request));
if (narrowed.refusal) return response.status(403).json(narrowed.refusal);
const result = await SystemSettings.updateSettings(narrowed.updates);
if (["unknown_keys", "protected_keys"].includes(result.code))
  return response.status(400).json(result);
```

403 narrow → 400 mapping, with the comment naming the order and the reason
("#78 then #72, in that order: authority before vocabulary"). Same on
`system.js:1011` and `admin.js`. The #72 mapping survives on every route it was on.

The `unknownKeyRefusalHttp` change is the honest half of this: the test that asserted
`manager unknown keys stay silent → 200` is now `refused without changing rows →
400 unknown_keys`, with a comment saying #78 replaced the silent 200. A behaviour
change stated rather than smuggled.

## FINDING-3 CLOSED — union, and the ordering question answers itself

`recognizedFields = new Set([...protectedFields, ...supportedFields])` — 30 keys, 5
allowed, **25 forbidden**. Probed the whole matrix as a manager:

```
multi_user_mode              403 forbidden_keys   <- was 200 {success:true}
onboarding_complete          403 forbidden_keys   <- was 200 {success:true}
hub_api_key                  403 forbidden_keys
text_splitter_chunk_size     403 forbidden_keys
support_email                PASS  proto=null
zzz (unknown)                PASS  proto=null
zzz + support_email          PASS  proto=null
zzz + hub_api_key            403 forbidden_keys
logo_filename                403 forbidden_keys
experimental_live_file_sync  403 forbidden_keys
```

The two keys that used to answer `200 {success:true}` on a write that never happened
now answer 403, and an admin still gets #72's 400 `protected_keys` for the same body
— the asymmetry is gone. Ordering between 403 and 400 no longer needs a rule because
the narrowing runs first on every route.

## FINDING-2 CLOSED — six routes, and each refusal lands before the write

| route | verified |
|---|---|
| `POST /admin/system-preferences` | narrow → 403, then #72 mapping |
| `POST /community-hub/settings` | same |
| `POST /system/default-system-prompt` | same |
| `POST /system/upload-logo` | narrow **before** `renameLogoFile` / `removeCustomLogo` |
| `GET /system/remove-logo` | narrow before `removeCustomLogo` |
| `POST /experimental/toggle-live-sync` | narrow before the validation and the write |

Two beyond what I asked for: `POST /system/enable-multi-user` moved from
`settings.write` to `system.write` outright — the right call, since it is not a
setting write at all but a mode change that creates the first admin — and the read
path in `admin.js:469` now imports the shared `managerAllowedFields` instead of
holding its own copy, so the read and write halves cannot drift.

The logo routes are the ones I would have got wrong: the narrowing sits **above**
`removeCustomLogo`, so a refused manager does not delete the current logo on the way
to being refused. The test asserts the refusal on the real multipart route.

## NIT-2 CLOSED — `Object.create(null)`, verified as a property of the returned object

`proto=null` on every passing case above, not just asserted in a test.

## The drift test grew the half that was missing

`classifies every frontend updateSystemPreferences caller` walks the whole frontend
tree and requires every caller to be either a listed manager component or an entry in
`nonManagerCallers` **with a stated reason**. That closes the gap I raised: a fifth
manager-reachable component is now a red test rather than an invisible one. The
reason strings are asserted non-empty, which is a small thing that stops the map
becoming a list of empty strings.

---

## NIT-1 — the drift test's forbidden set is `supportedFields`-only while the runtime uses the union

```
runtime forbidden (union):        25
drift test forbidden (supported):  23
```

`managerAllowedFieldsDrift.test.js:39-45` computes `forbidden` from
`SystemSettings.supportedFields` alone and asserts `allowed ∪ forbidden === supported`.
That invariant is still true and still useful — but it is now a *different* set from
the one `narrowManagerSystemPreferences` actually enforces, which includes
`multi_user_mode` and `onboarding_complete`.

Consequence: if someone removed the union and went back to `supportedFields`, the
drift test would stay green. The HTTP suite would catch it (`it.each(["multi_user_mode",
"onboarding_complete"])` at `:305` asserts 403), so this is not a hole — but the two
files now disagree about what "forbidden" means, and the one named *drift* is the one
with the older definition. Compute it from the same union.

## NIT-2 — four `_updateSettings` call sites still bypass the narrowing, and two are fine

After this SHA:

```
liveSync.js:53        _updateSettings   <- narrowed above, fine
system.js:1108,1149   _updateSettings   <- logo, narrowed above, fine
system.js:775,807     _updateSettings   <- enable-multi-user, now system.write, fine
boot/assertDeploymentShape.js:50        <- boot, no route
models/systemSettings.js:838            <- onboarding, internal
```

All six route paths are covered, so nothing is exposed. Recording it because the
pattern that made #78 necessary — a route reaching `_updateSettings` directly,
below every check — is still available to the next route that wants it, and nothing
in the tree says so. A one-line comment on `_updateSettings` ("callers must decide
authority first; see managerSystemPreferences") costs nothing and puts the warning
where the next author will be standing.

---

## Verdict

**PASS.** All three findings closed and both NITs from the previous round closed.
NIT-1 and NIT-2 here are one-line changes and can ride the next SHA.

## Reproduction

```
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd .claude/worktrees/pr78/server                 # at 86d2fe96
git merge-base --is-ancestor 1e1ff638b HEAD      # YES — sits on #72
node -e '<stub authorize->denied; narrow() over 10 bodies; print code + prototype>'
node -e '<supportedFields / protectedFields / union arithmetic>'
grep -rn "_updateSettings(" endpoints utils models | grep -v __tests__
```

Read-only: nothing in the worktree was modified.
