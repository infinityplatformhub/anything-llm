# Techlead-1 — #121 `6e205d79b` (auth): rulings (ก)(ข), then **PASS**

Code SHA `7960ceac1`; verdict target `6e205d79b` adds the mockup re-pin. §7.14: no suite run.
Probes are in-process `node -e` replaying `MenuOption`'s decision logic, plus source reads in a
detached worktree (`git worktree add --detach /tmp/tl-121 6e205d79b`).

---

# Part 1 — the two rulings

## (ก) `setup_admin` loses 15 entries: **intended for #121; the seed is the bug, and it is a separate issue**

Read `prisma/seeds/permissions.js:128-138` and `migration.sql:299-303`. `setup_admin` holds
`settings.write, user.manage, key.manage, workspace.read, access.diagnose, role.grant,
role.revoke, org.member` — none of the four.

**The mapping is not wrong.** Traced one of the fifteen end to end:
`settings.llm` → `LLMPreference/index.jsx:470` calls `System.updateSystem` →
`models/system.js:291` posts `/system/update-env` → `endpoints/system.js:1077`
`requirePermission("system.write")`. So `setup_admin` can open the LLM page today and gets a
403 on save. The menu disappearing takes nothing from them; it stops advertising a page the
server refuses. That is what this issue exists to do.

**Option (2) — remap those sites to capabilities `setup_admin` already holds — is wrong**, and
would be a regression disguised as a fix: it picks a capability by *who holds it* rather than by
*what the route checks*, which is the drift #121 was opened to delete.

**Option (1) — grant the capabilities in the seed — is probably right and is not this issue.**
`SYSTEM_ROLES` names the role for finishing installation, and an installation cannot be finished
without setting the LLM, embedder, and vector database, all of which sit behind `system.write`.
That is a contradiction between the role's stated purpose and its permission set: a **seed bug**,
not a sidebar bug.

Fixing it inside #121 would change who may rewrite an instance's environment variables, under an
issue that advertises itself as a frontend mapping change — the same shape I refused for
`ManagerRoute → AdminRoute` on mobile-app. It needs its own issue at auth tier with a migration,
asking the right question: *should `setup_admin` be able to finish an installation?*

One thing for that issue: `user.manage` does **not** contain `user.read`. They are separate
permission ids, so holding the broader-sounding one grants nothing about the narrower. That is a
second seed defect in the same role and should be decided there, not assumed.

## (ข) `content_moderator` gains `workspace-chats`: **confirmed, and it is a fix rather than a widening**

`permissions.js:141-146` grants `chat.read_others` to the role directly, and the Workspace Chats
route gates on that same action. The menu now matches what the server already permits. The role
exists to read other people's chats; the UI never showing it was the defect. Record it as the
one visible widening and as intended.

## `manager → member` losing all eight legacy-manager entries: intended

`member`/org retains exactly `chat.send` after `20260902044000` deletes nine of the ten actions
seeded at `20260902020000:312-317` (measured during #128). The server already 403s all eight.
Worth stating in the issue so it is not read later as a regression.

---

# Part 2 — verdict on `6e205d79b`

## F-A closed, and closed with the test shape it needed

`ORG_CAPABILITIES` is 7 → 11 (`system.js:119-133`) with the reason written as a mechanism: an
absent key answers absent, `can(action)` is then false for **every** caller including
super_admin, and the entry vanishes while the route stays reachable.

Two server tests, and they constrain opposite directions — which is the point I raised:

- **sidebar-derived** (`workspaceScopedCapabilities.test.js:237-268`) greps
  `capability[=:]\s*"([^"]+)"` out of the sidebar source and asserts every one is answered by
  the endpoint. Expectation comes from a different file than the thing inspected, so adding a
  gated entry without adding the capability turns it red. Carries its own non-vacuity guard
  (`gatedOn.length > 5`, and `toContain("system.read")`).
- **literal 11-entry** (`:270-296`) writes the list out and pins the count, catching a
  **deletion** the sidebar never mentioned — which the three existing key-shape assertions
  cannot, since both their sides come from the same constant.

Neither derives from the other, and the comments state §7.9f as the reason. This is the pair
that closes the gap; one alone would not.

## F-B closed by a decision, stated

`isEntryVisible:40` returns false on `hidden` first, and the docblock now says explicitly that a
parent carrying `hidden` never reaches `hasVisibleChildren`, that a visible child therefore
cannot pull it back on screen, that this is the intent, and that no entry pairs the two today.

Probed the real decision logic — and the behaviour is **not** what that comment describes:

```
parent hidden=true, has VISIBLE children -> RENDERS
parent hidden=true, no children          -> null
child  hidden=true                       -> null
```

`MenuOption:109-116`: for `!isChild && hasChildren`, the only test is `!hasVisibleChildren` —
`visible` is computed and never consulted. So a hidden parent with a visible child **does**
render, the opposite of the comment.

**This is not a defect today** and I am not blocking on it: no entry pairs `hidden` with
`childOptions` (I enumerated every `<Option>` in `SettingsSidebar/index.jsx` on the previous SHA
— the only `hidden=` is Security at `:474`, which has no children). But the comment is now the
kind that lies, which is worse than the silence it replaced: the next person adding `hidden` to
a parent will read it, believe the parent disappears, and ship the opposite.

**Fix is one line** — `if (hasChildren && (!visible || !hasVisibleChildren)) return null;` — and
it makes the comment true. If Dev1 prefers to keep the current behaviour, the comment must be
inverted instead. Either way the file must stop asserting something the code does not do. I would
take the one-line fix, since the comment describes the behaviour everyone expects.

## F-C closed by removal, with the better reasoning

The `capabilities` array is gone. The docblock (`:21-24`) says an OR with no caller in this
branch is an untested branch that reads as a tested one, and that it goes in with the caller that
needs it. That is a stronger argument than my "it is unused" and the right disposition.

## Mockup re-pin is catalog-only

Confirmed against the diff: `ORG_CAPS` goes 7 → 11 with a comment naming which entries each
capability restores; `GATES` (the map of what the mockup actually draws) is untouched, so no new
visible control appears. The behavioural change worth the user's attention is not the count — it
is `users` moving from `user.manage` to `user.read`, which is the one place someone who could not
see the menu will start seeing it. I understand that is going into the approval request verbatim.

## Client fixtures

RF-1's five single-capability cases each assert their own entry visible **and** named others
hidden in the same render — the shape that catches a swap rather than a widening. RF-3 has all
four parent/child combinations including the two new hidden-child cases. RF-6 asserts the
loading→resolved transition rather than the loading state alone.

## Verdict

**PASS**, with F-B's comment to correct — one line either way, and it does not change behaviour
today. Everything F-A required landed, and the two server tests are independent in the way that
makes the pair meaningful.
