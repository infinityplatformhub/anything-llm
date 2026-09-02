# recon — sidebar audit rerun, as it will look after #121 + #137-MR land

Docs only. Dev4's four harnesses (`.infi/recon/sidebar-audit-*.cjs` on main) rerun
against the `mr121` scratch tree — `5c9ea893d` (#121 as frozen) plus the Model
Router re-gate prepared for #137's second commit. That tree is the closest
available stand-in for post-merge main; it is NOT main, and every number here
moves if either change is amended before merge.

Harnesses were re-pointed at `mr121` and at this run's own router output; no
logic was changed. All four exited 0.

## Totals

| measure | value |
|---|---|
| mounted routes | 318 |
| sidebar entries parsed | 37 |
| entries carrying a gate | 35 |
| legacy `roles=` entries remaining | **0** |
| `ORG_CAPABILITIES` | 12 |
| distinct capabilities used by entries | 9 |
| capabilities used but NOT in `ORG_CAPABILITIES` | **0** |
| wrapped (route-walk-invisible) gates | 1 — `system.js:439`, `system.write` |

Two results worth stating plainly, because they are what #121 and the Model
Router change were for:

- **No entry gates on a capability the endpoint does not answer.** That was the
  #121 defect (four capabilities missing from `ORG_CAPABILITIES`, entries
  invisible to everyone including super_admin) and it is closed.
- **No entry still names a legacy role string.** 29 did before #121.

Three capabilities are in `ORG_CAPABILITIES` and gate no entry:
`access.diagnose`, `document.bulk_export`, `workspace.create`. That is expected —
the map is the vocabulary a client may ask about, not a list of menu items — and
is recorded so it is not read as a leak.

## The mismatch table

"Route actions" is the set of `requirePermission` actions on the routes the page
actually calls, measured from the mounted router, not from grep. "Verdict" is
mechanical: `MISMATCH` means the entry's capability is not among the actions its
own page's routes check.

| entry | guard | capability | route actions | in ORG_CAPS? | verdict |
|---|---|---|---|---|---|
| `Default System Prompt` | AdminRoute | `system.read` | `settings.write`, `system.read`, `system.write` | yes | OK |
| `settings.ai-providers` | AdminRoute | `system.write` | `model-router.read`, `system.read`, `system.write` | yes | OK |
| `settings.ai-providers` | AdminRoute | `system.write` | `model-router.read`, `system.read`, `system.write` | yes | OK |
| `settings.ai-providers` | AdminRoute | `system.write` | `model-router.read`, `system.read`, `system.write` | yes | OK |
| `settings.ai-providers` | AdminRoute | `system.write` | `model-router.read`, `system.read`, `system.write` | yes | OK |
| `settings.ai-providers` | AdminRoute | `system.write` | `model-router.read`, `system.read`, `system.write` | yes | OK |
| `settings.ai-providers` | AdminRoute | `system.write` | `model-router.read`, `system.read`, `system.write` | yes | OK |
| `settings.ai-providers` | AdminRoute | `system.write` | `model-router.read`, `system.read`, `system.write` | yes | OK |
| `settings.ai-providers` | AdminRoute | `system.write` | `model-router.read`, `system.read`, `system.write` | yes | OK |
| `settings.ai-providers` | AdminRoute | `system.write` | `model-router.read`, `system.read`, `system.write` | yes | OK |
| `settings.api-keys` | AdminRoute | `key.manage` | `key.manage` | yes | OK |
| `settings.available-channels.telegram` | AdminRoute | `—` | — | — | ungated |
| `settings.branding` | ManagerRoute | `settings.write` | `settings.write` | yes | OK |
| `settings.browser-extension` | ManagerRoute | `key.manage` | `browser-extension.read`, `browser-extension.write` | yes | MISMATCH |
| `settings.chat` | ManagerRoute | `settings.write` | — | yes | no gated route |
| `settings.community-hub.import-item` | AdminRoute | `settings.write` | `system.read` | yes | MISMATCH |
| `settings.community-hub.trending` | AdminRoute | `settings.write` | `system.read` | yes | MISMATCH |
| `settings.community-hub.your-account` | AdminRoute | `settings.write` | `settings.write`, `system.read` | yes | OK |
| `settings.embedder` | AdminRoute | `system.write` | `system.read`, `system.write` | yes | OK |
| `settings.embeds` | AdminRoute | `settings.write` | `chat.read_others`, `chat.write`, `embed.delete`, `embed.read`, `embed.write`, `org.member` | yes | MISMATCH |
| `settings.event-logs` | AdminRoute | `system.read` | `system.read`, `system.write` | yes | OK |
| `settings.image-generation` | AdminRoute | `system.write` | `system.read`, `system.write` | yes | OK |
| `settings.interface` | ManagerRoute | `settings.write` | — | yes | no gated route |
| `settings.invites` | ManagerRoute | `invite.read` | `invite.create`, `invite.delete`, `invite.read`, `org.member` | yes | OK |
| `settings.llm` | AdminRoute | `system.write` | `model-router.read`, `system.read`, `system.write` | yes | OK |
| `settings.mailer` | AdminRoute | `settings.write` | `system.write` | yes | MISMATCH |
| `settings.mobile-app` | AdminRoute | `system.read` | `system.read`, `system.write` | yes | OK |
| `settings.model-router` | AdminRoute | `model-router.read` | `model-router.read`, `model-router.write`, `system.read`, `system.write` | yes | OK |
| `settings.scheduled-jobs` | SingleUserRoute | `—` | — | — | ungated |
| `settings.system-prompt-variables` | AdminRoute | `settings.write` | — | yes | no gated route |
| `settings.text-splitting` | AdminRoute | `system.write` | `settings.write` | yes | MISMATCH |
| `settings.transcription` | AdminRoute | `system.write` | `system.write` | yes | OK |
| `settings.users` | ManagerRoute | `user.read` | `user.manage`, `user.read` | yes | OK |
| `settings.vector-database` | AdminRoute | `system.write` | `system.write` | yes | OK |
| `settings.voice-speech` | AdminRoute | `system.write` | `system.read`, `system.write` | yes | OK |
| `settings.workspace-chats` | ManagerRoute | `chat.read_others` | `chat.read_others`, `chat.write` | yes | OK |
| `settings.workspaces` | ManagerRoute | `user.manage` | `user.manage`, `user.read`, `workspace.create`, `workspace.delete` | yes | OK |
## The eleven flagged rows, with what each one is

**Four genuine capability/route mismatches** — the entry shows for a capability
its page's routes do not check, so a holder sees the entry and is 403'd, or a
holder of the right action does not see it:

| entry | gates on | routes actually check |
|---|---|---|
| `settings.mailer` | `settings.write` | `system.write` (`/mailer/settings` GET+POST, `/mailer/test`) |
| `settings.text-splitting` | `system.write` | `settings.write` (`/admin/system-preferences`) |
| `settings.community-hub.trending` | `settings.write` | `system.read` (`/community-hub/explore`) |
| `settings.community-hub.import-item` | `settings.write` | `system.read` (`/community-hub/item`) |

`settings.mailer` and `settings.text-splitting` are a SWAP — each gates on the
action the other's routes check.

**Two entries whose routes use a different vocabulary entirely:**

| entry | gates on | routes actually check |
|---|---|---|
| `settings.embeds` | `settings.write` | `embed.read`, `embed.write`, `embed.delete`, `chat.read_others`, `chat.write`, `org.member` |
| `settings.browser-extension` | `key.manage` | `browser-extension.read`, `browser-extension.write` |

Both are the Model Router case exactly: a `*.read`/`*.write` action pair exists
for the feature and the entry gates on something else. Neither action is in
`ORG_CAPABILITIES`, so fixing these is the same two-part change the Model Router
took — add the read action to the map, gate the entry on it.

**Three entries gate on `settings.write` but call no gated route at all:**
`settings.interface`, `settings.chat`, `settings.system-prompt-variables`. Their
only calls are `/system/support-email`, `/system/footer-data`, `/utils/metrics`
and `/system/my-capabilities`, none of which carry a `requirePermission`. The
capability is therefore unfalsifiable from the route side — it may still be the
right editorial choice, but nothing measures it. Note two of the three carry
`ManagerRoute`, which is a legacy role guard.

**Two ungated entries:** `settings.available-channels.telegram` (`AdminRoute`)
and `settings.scheduled-jobs` (`SingleUserRoute`). Both were left deliberately
ungated in #121 — their routes carry session auth and no `requirePermission`, so
there is no action to name and inventing one would be a guess. They are listed
here so the guard ruling can decide whether the client guard alone is enough.

## For TL-2's guard ruling

The `guard` column is the client-side route guard, and it is still legacy role
strings throughout: `AdminRoute`, `ManagerRoute`, `SingleUserRoute`. #121 moved
the SIDEBAR off role strings; it did not touch the route guards, so today an
entry can be capability-gated while the page behind it is role-guarded. The rows
where those two disagree are the ones the ruling has to land on — in particular
the `ManagerRoute` pages (`settings.interface`, `settings.chat`,
`settings.browser-extension`), where a delegated admin holding the capability is
still refused by the guard.

## Caveats

- Not main. `mr121` is `5c9ea893d` plus an uncommitted Model Router change.
- Route resolution is per PAGE: the harness takes fetch literals from the model
  methods a page names, so a call made through an unusual indirection is not
  counted. `unresolved` was empty for every row in this run.
- One wrapped gate (`system.js:439`) is invisible to a router walk by
  construction; it is `GET /system/preflight`, gated on `system.write` and
  deliberately bypassed pre-user. Counted separately, not missed.
