# Techlead-1 review — #78 `3a10defc` (Dev1, worktree `pr78`) — **NOT MERGEABLE**

`3a10defc` is ledger-only; the runtime change is `2a6b45a87` plus the overlap test
in `31076530e`. Diff is 7 files / +565 −38.

Per §7.14 I ran no suites — only in-process probes of `narrowManagerSystemPreferences`
and one trial merge in a detached worktree (`/tmp/tl1-78`, aborted). Reproduction at
the end.

**Blocked on a merge conflict that silently reverts #72, and on two forbidden keys the
narrowing does not cover.** The narrowing itself is right, and the four rulings are
implemented as ruled.

---

## FINDING-1 (blocker) — the branch predates #72 and its resolution deletes #72's status mapping

`merge-base approof/main HEAD` is `64408d00`, and `git merge-base --is-ancestor
1e1ff638b HEAD` says **NO**: this branch never saw the #72 merge. Trial merge onto
`approof/main` @ `7e39062d1`:

```
CONFLICT (content): server/endpoints/admin.js
CONFLICT (content): server/endpoints/communityHub.js
CONFLICT (content): server/endpoints/system.js
```

All three conflicts have the same shape — main's side carries #72's typed mapping,
#78's side carries the narrowing and **no mapping at all**:

```
<<<<<<< HEAD                                    (main, #72)
        const result = await SystemSettings.updateSettings(data);
        if (["unknown_keys", "protected_keys"].includes(result.code))
          return response.status(400).json(result);
=======                                          (#78)
        const narrowed = await narrowManagerSystemPreferences(...);
        if (narrowed.refusal) return response.status(403).json(narrowed.refusal);
        const result = await SystemSettings.updateSettings(narrowed.updates);
        if (result.error) throw new Error(result.error);
>>>>>>> 3a10defc
```

Taking "theirs" — the natural resolution, since #78's side is the newer intent —
drops the 400 mapping on all three routes. `communityHub.js` is the worst: `if
(result.error) throw` sends an `unknown_keys` refusal into the catch block and out as
a **500**, which is the exact defect #72's own test
(`"community hub rejects unknown keys outside its 500 catch path"`) was written to
pin. That test lives on main and would go red — so the gate catches it, but only
after a resolution someone has to redo.

**Ask: rebase onto current `approof/main` and re-run, rather than resolving by hand
at merge time.** The two changes compose cleanly when both are present — narrow →
403, then `updateSettings` → 400 on `unknown_keys`/`protected_keys` — but that
composition has never existed in one tree and is not what any test on this branch
exercises.

## FINDING-2 (blocker) — three more `settings.write` routes write forbidden keys, and the narrowing never sees them

The ruling was "three routes share one narrowing", and those three do. But
`managerAllowedFields` is a filter over `supportedFields`, and **five** other routes
reach `system_settings` for keys in the forbidden 23 by calling `_updateSettings`
directly — below `updateSettings`, so below the narrowing too:

| route | gate | key written | in the forbidden 23? |
|---|---|---|---|
| `POST /system/upload-logo` (`system.js:1080`) | `settings.write` | `logo_filename` | **yes** |
| `GET /system/remove-logo` (`system.js:1128`) | `settings.write` | `logo_filename` | **yes** |
| `POST /experimental/toggle-live-sync` (`liveSync.js:23`) | `settings.write` | `experimental_live_file_sync` | **yes** |
| `POST /system/enable-multi-user` (`system.js:739`) | `settings.write` | `multi_user_mode` | no (not supported) |
| `assertDeploymentShape.js:50` | boot, no route | `multi_user_mode` | n/a |

`setup_admin` holds `settings.write` and not `system.write`, so a manager can still
write two of the 23 keys #78 exists to deny them — by using the route that writes
that key rather than the generic one. `logo_filename` is the clearer case: QA-3's
table records it as "no page writes it through this route", which was read as *not
reachable* when it actually means *reachable somewhere else*.

Not a defect in the narrowing — it is the same class the narrowing was created to
fix, one layer down. Ruling needed: either bring these routes behind the same
narrowing (they each write one fixed key, so it is a one-line authority check per
route), or state explicitly that a manager may set the logo and toggle live sync and
remove those two keys from the forbidden list. What must not stand is the list
claiming 23 while 2 of them are writable.

## FINDING-3 — a manager and an admin get opposite answers for the same protected key

Measured on the branch's own model, with `authorize` stubbed to deny `system.write`:

```
multi_user_mode      -> PASS updates={}  -> updateSettings({}) -> 200 {success:true}
onboarding_complete  -> PASS updates={}  -> updateSettings({}) -> 200 {success:true}
hub_api_key          -> 403 forbidden_keys
```

`multi_user_mode` and `onboarding_complete` are `protected` but not `supported`, so
they fall outside `forbiddenKeys` by construction and are then dropped by the
allowed-only filter. An **admin** sending the same body gets #72's `400
protected_keys`; a **manager** gets `200 {success:true}` on a write that never
happened. That is the silent-drop defect #78 was opened to end, surviving for exactly
the keys the system calls protected.

The cheapest fix consistent with both issues: classify against `protectedFields ∪
supportedFields` rather than `supportedFields` alone, so a manager sending a
protected key gets 403 and an admin still gets 400. `hub_api_key` already answers
403 and should keep doing so — it is the intersection, and 403-before-400 is the
order my #78 pre-read recommended.

---

## What is right

**The narrowing is one function, and all three routes call it.** `grep` confirms a
single import per route and no second copy of the field list;
`managerAllowedFields` is `Object.freeze`d in `utils/managerSystemPreferences.js`,
so the three-copies-of-a-literal problem that made this issue possible cannot recur
by mutation either.

**Ruling 1 (reflect only caller keys) holds, and is tested for the right property.**
`forbiddenKeys` is built from `Object.keys(updates)`, and the test at `:226` asserts
the serialized body contains *no other* forbidden or allowed key — so a refusal
cannot become a capability listing. That is the assertion I asked for.

**Ruling 2 (manager check before `updateSettings`) is what the code does**, with the
reason in the comment: `// Decide authority before updateSettings validates the
setting vocabulary`. Probed the ordering directly — `{not_a_real_key, memory_enabled}`
returns `403 forbidden_keys`, not `400 unknown_keys`, so authority is decided before
vocabulary and a manager cannot use an unknown key to change which refusal they get.

**Ruling 3 (`hub_api_key` 403 for manager) is proven end to end**, on the real route,
with the row asserted absent afterwards — not through a mock.

**Ruling 4 (premise guard) is the strongest part of the suite.** `beforeAll` asserts
the manager's *grants* directly — `settings.write` allowed, `system.write` denied —
before any test runs, so a seeding change that silently gave the manager
`system.write` fails as a premise rather than turning 15 assertions green for the
wrong reason. The `memory_*` drift case is covered: both keys are in the forbidden 23
(confirmed), and the `it.each(forbiddenFields)` table means all 23 are exercised
rather than a chosen sample.

**The set relation is asserted, not the count.** `new Set([...allowed, ...forbidden])
=== supported` in `managerAllowedFieldsDrift.test.js:45` — so the SMTP keys #80 will
add cannot break it, which is what I asked for in the #80 pre-read.

## NIT-1 — the drift test's regex reads four components by name, and stops at the first `}`

`writtenFields` matches `Admin.updateSystemPreferences\(\{([\s\S]*?)\}\)` — non-greedy,
so a nested object ends the capture early. Probed:

```
"updateSystemPreferences({ custom_app_name: {a:1}, meta_page_title: 'x' })"
  -> ["custom_app_name"]        (meta_page_title invisible)
```

No current component writes a nested value, so it is green for the right reason
today. But the failure is *under*-reporting, and the assertion is
`allowed === frontendFields` — a component that starts writing a nested value makes
the test demand a *smaller* allowlist, i.e. it fails loudly rather than passing
wrongly. Acceptable; worth a comment saying the shape is depended on.

The bigger half: `managerComponents` is a hardcoded list of four. A fifth
manager-reachable component calling `updateSystemPreferences` is invisible to the
test. I checked the other ManagerRoute settings pages — `/settings/interface`
(`LanguagePreference`, `ThemePreference`) and `/settings/chat` (`AutoSubmit`,
`AutoSpeak`, `SpellCheck`, `ShowScrollbar`, `AutoScroll`, `ChatRenderHTML`) — and
**none of them calls `updateSystemPreferences`**, so the list is complete today.
Deriving it from the page imports instead of hardcoding would keep it complete;
`CustomLogo` is the warning, since it sits on the same manager page and writes
`logo_filename` through a different route (FINDING-2).

## NIT-2 — `narrowManagerSystemPreferences` builds a normal object

`Object.fromEntries(...)` returns an `Object.prototype`-backed object, where #72
deliberately switched to `Object.create(null)`. Probed `{"__proto__":{...},
support_email}`: nothing polluted (the filter drops the key before the spread, and
`fromEntries` on a literal `__proto__` entry is safe), so this is not a live defect.
Matching #72's null-prototype choice would make the safety structural rather than
incidental.

---

## Verdict

**NOT MERGEABLE.** FINDING-1 needs a rebase, not a merge-time resolution — the
composition of #78 and #72 has never existed in one tree. FINDING-2 needs a ruling
before this lands, or the forbidden list ships overstating what it denies.
FINDING-3 is a small change in the same function. NIT-1 and NIT-2 can ride along.

Everything the four rulings asked for is present and tested at the right layer.

## Reproduction

```
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
git worktree add --detach /tmp/tl1-78 approof/main
git -C /tmp/tl1-78 merge --no-commit --no-ff 3a10defc   # 3 conflicts, then --abort
cd .claude/worktrees/pr78/server
node -e '<stub authorize->denied; narrow() over 7 bodies>'      # table in FINDING-3
node -e '<supportedFields x managerAllowedFields set arithmetic>'  # 28 / 5 / 23
grep -rn "_updateSettings(" endpoints/ utils/ | grep -v __tests__   # FINDING-2 table
```

Read-only: nothing in `pr78` was modified; `/tmp/tl1-78` was aborted and left clean.
