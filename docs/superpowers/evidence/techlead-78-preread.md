# Techlead-1 — #78 pre-read (before Dev1's SHA)

Read against `main` `7d8da8f8` plus the merged-pending #72 tree (`.claude/worktrees/pr72`
@ `e207e124`), since #78 lands on top of #72 and its answer depends on #72's filter order.
Companion: `qa3-78-prereview.md` (the 23-key visibility table).

**The three things asked, answered. Two of them change the ruling.**

## 1. Does the oracle argument hold? — **Yes, and it is stronger than stated.**

The argument for allowing 403 + key names is: "does this build know this key" is disclosed by
open-source source anyway, unlike per-instance state. That holds, and there is a second reason nobody
has written down: `managerAllowedFields` is a **literal array in `admin.js:590-596`**, not a
per-instance setting. So a 403 naming forbidden keys leaks nothing an attacker cannot read in the
repository — the boundary itself is public, not just the vocabulary.

The distinction #72's silence protects is different in kind: `unknown_keys` at 400 tells you what a
*deployment* accepts, and a fork or a private build may have keys this one does not. Refusing to
disclose per-build vocabulary while disclosing a source-literal ACL is coherent.

**One caveat that matters for the reply body**: the refusal must name only the keys the caller
*sent*, never the full `managerAllowedFields` list. Echoing back the allowed set turns a refusal into
a capability listing. The ruling says "+ รายชื่อ" — worth pinning which list.

## 2. Filter order against #72 — **there is a real conflict, and the ruling as written is unreachable for one key**

I executed the merged #72 model. Its order is **protected → unknown → write**:

| body (as admin) | #72 answers |
|---|---|
| `{not_a_real_key}` | `unknown_keys` (400) |
| `{text_splitter_chunk_size}` | write proceeds |
| `{not_a_real_key, text_splitter_chunk_size}` | `unknown_keys` (400) |
| `{hub_api_key}` | **`protected_keys` (400)** |

Two consequences for #78:

**(a) A key that is both unknown and forbidden cannot be both.** "Forbidden" means *in*
`supportedFields`; "unknown" means *not in* it. The sets are disjoint by construction, so the mixed
body question has a clean answer: the unknown key wins, because `updateSettings` refuses the whole
request on `unknown_keys` before any manager filter result could matter. But that is only true if the
manager filter runs **before** `updateSettings`. If #78 filters after, a manager sending
`{not_a_real_key, text_splitter_chunk_size}` gets `forbidden_keys` while an admin sending the same
body gets `unknown_keys` — two different refusals for the same request, decided by the caller's role.
Recommend: **manager check first, then `updateSettings`**, so unknown-vs-forbidden is answered the
same way for everyone and the 403 is about authority rather than vocabulary.

**(b) `hub_api_key` is in the 23 "forbidden" keys and is also `protected` under #72.** Set arithmetic
on the real model: `supportedFields` 28, `managerAllowed` 5, forbidden 23, and
`protectedFields ∩ forbidden = {hub_api_key}`. So a manager sending `hub_api_key` should get 403
`forbidden_keys` under #78's rule, and an admin sending it gets 400 `protected_keys` under #72. Both
are defensible, but the ordering decides which, and nothing in the ruling says. **Recommend 403
first** — an authority refusal is the more specific answer, and a manager learning "you may not write
this" is better than learning "nobody may".

## 3. Drift test — **the test the ruling implies is not the test that would catch the drift**

QA-3's table shows all 23 forbidden keys sit behind `AdminRoute` or an equivalent role check, so
today no manager UI writes one. A test asserting *that* — "no manager-reachable page writes a
forbidden key" — is the drift guard, and it is a **frontend** assertion, not a server one. The server
test can only assert the refusal fires.

The two the table flags as *not* route-guarded are the ones a drift test should name:
`memory_enabled` and `memory_auto_extraction` are gated in `MemoriesContext.jsx:25`
(`canToggle = !user || user?.role === "admin"`) — **client-side only, no server counterpart**. Under
#78 they become server-refused for a manager, which is a genuine improvement and the only place where
#78 closes something real on this route. Worth naming in the evidence as the case that justifies the
issue, since QA-3 correctly found the issue's own worked example (`text_splitter_chunk_size`) does
not.

## The premise correction QA-3 found is right, and #78 is still worth doing

I verified the guard reading: `AdminRoute` (`PrivateRoute/index.jsx:79-89`) is
`user?.role === "admin" || !multiUserMode`; `ManagerRoute` (:108-117) is `user?.role !== "default"`.
So a manager passes ManagerRoute and fails AdminRoute, and every page writing one of the 23 is behind
AdminRoute. The issue's premise ("already visible to a manager") is wrong.

That does not make #78 a no-op, and I would not present it as one: **the silent drop is a real
defect regardless of UI reachability.** A manager posting directly — curl, a stale client, a script —
gets `200 {success:true}` today while nothing is written. #72 fixed exactly that shape for unknown
keys and the argument is identical here. The change to make is in the *justification*, not the code:
#78 is "a refused write must not answer success", not "a manager can see these settings".

## One thing I could not check
Which role actually reaches this branch. Seeded roles holding `settings.write` but **not**
`system.write` = `setup_admin` only (`super_admin` holds both; `content_moderator`, `member` and the
three workspace roles hold neither). So "manager" here is `setup_admin`, or a legacy `manager` user
whose grant maps to it. If Dev1's tests build the actor from a legacy role string rather than from
`setup_admin`'s grant, the test may not exercise the branch at all — worth asserting the actor's
decision (`system.write` denied, `settings.write` allowed) as a premise guard, the way #61's
`chat.read_others` test does.

## What I did not do
Did not run the suite (§7.14). The tables come from executing the merged #72 `SystemSettings` model
and the seeded role list under node 22, plus reading `admin.js:583-604` and the frontend guards. No
worktree was modified.
