# QA-3 — #121 pre-review: the oracle Dev1's `capability` prop has to agree with

Read on `main` `b557cbbf3`. This is the table I will hold the SHA against: for every
`SettingsSidebar` menu entry, the route its `href` reaches, the guard that route carries,
and the server action behind the page's own calls — derived from `endpoints/**` and the
seeded `role_permissions` rows, not from the menu's role strings.

## The menu today

26 entries carry `roles:`; **two carry none** (`telegram`, `scheduled-jobs`). A prop named
`capability` has to say something for those two as well, and "nothing" is not available.

```
menu label                        route                                     menu roles      route guard
settings.llm                      /settings/llm-preference                  admin           AdminRoute
settings.mailer                   /settings/mailer                          admin           AdminRoute
settings.vector-database          /settings/vector-database                 admin           AdminRoute
settings.embedder                 /settings/embedding-preference            admin           AdminRoute
settings.text-splitting           /settings/embedding-preference            admin           AdminRoute
settings.image-generation         /settings/image-generation-preference     admin           AdminRoute
settings.voice-speech             /settings/audio-preference                admin           AdminRoute
settings.transcription            /settings/transcription-preference        admin           AdminRoute
settings.model-router             /settings/model-routers                   admin           AdminRoute
settings.users                    /settings/users                           admin,manager   ManagerRoute
settings.workspaces               /settings/workspaces                      admin,manager   ManagerRoute
settings.workspace-chats          /settings/workspace-chats                 admin,manager   ManagerRoute
settings.invites                  /settings/invites                         admin,manager   ManagerRoute
Default System Prompt             /settings/default-system-prompt           admin           AdminRoute
settings.interface                /settings/interface                       admin,manager   ManagerRoute
settings.branding                 /settings/branding                        admin,manager   ManagerRoute
settings.chat                     /settings/chat                            admin,manager   ManagerRoute
settings.embeds                   /settings/embed-chat-widgets              admin           AdminRoute
settings.event-logs               /settings/event-logs                      admin           AdminRoute
settings.api-keys                 /settings/api-keys                        admin           AdminRoute
settings.system-prompt-variables  /settings/system-prompt-variables         admin           AdminRoute
settings.browser-extension        /settings/browser-extension               admin,manager   ManagerRoute
settings.mobile-app               /settings/mobile-connections              admin           ManagerRoute   <-- mismatch
settings.telegram                 /settings/external-connections/telegram   (none)          AdminRoute     <-- no roles
settings.scheduled-jobs           /settings/scheduled-jobs                  (none)          SingleUserRoute<-- no roles
```

## Three things the mapping has to answer, found while building the table

**1. `settings.mobile-app` — the menu and the guard already disagree.** The entry is
`roles: ["admin"]`, the route is wrapped in `ManagerRoute`, and the page's only call is
`GET /mobile/devices`, gated `requirePermission("system.read", orgResource)`. Of the seeded
org roles only `super_admin` holds `system.read`. So a manager can reach the page by URL
(the guard lets them), sees the menu entry hidden (the roles list does not), and the
request the page makes returns 403. Whatever `capability` this entry gets will change one
of those three, and the issue should say which is intended rather than picking whichever
makes the test pass.

**2. The two entries with no `roles:` are not "public".** `telegram` reaches an
`AdminRoute`, `scheduled-jobs` reaches a `SingleUserRoute`, and both pages call routes
that are `validatedRequest`-only on the server (`/telegram/*`, `/scheduled-jobs/*` — 64
routes carry session auth with no `requirePermission` at all). There is no action to name
for them today. Deriving `capability` from the server gate gives nothing; deriving it from
the guard gives a role, not a capability. This needs a ruling, not a default.

**3. `roles: ["admin","manager"]` maps to more than one action.** `settings.users` reaches
a page calling `Admin.users()` → `GET /admin/users` → `user.read`, while `settings.invites`
→ `GET /admin/invites` → `invite.read`, and only `super_admin` holds either. `setup_admin`
(the manager-shaped role) holds `settings.write` and `user.manage` but **not** `user.read`
or `invite.read`. So "manager sees Users" is true in the menu and false at the API for the
seeded roles — the same collapse #40 task 4 is removing elsewhere, one component over.

## The oracle, by action

Actions the sidebar's destinations actually depend on, with the seeded holders:

```
system.read      super_admin only            <- mobile-app
system.write     super_admin only            <- mailer, prompt-variables, event-log delete
settings.write   super_admin, setup_admin    <- default-system-prompt, admin preferences
user.read        super_admin only            <- users
user.manage      super_admin, setup_admin    <- users (mutations)
invite.read      super_admin only            <- invites
chat.read_others super_admin, content_moderator <- workspace-chats
```

`setup_admin` holding `user.manage` but not `user.read` is worth Dev1 knowing before the
mapping is written: the Users page needs both, and a single `capability` prop per caller
can only name one of them.

## Probes I will fire on the SHA

1. For each menu entry, with a principal holding the mapped capability and one without:
   the entry renders / does not render, and the destination route answers ≠403 / 403 over
   real HTTP. Menu visibility and server answer must agree per principal — that is the
   whole claim.
2. The three above, specifically: mobile-app for a manager, the two role-less entries, and
   Users for `setup_admin`.
3. Mutation: change one entry's `capability` to a neighbouring action → that entry's test
   must go red and no other. A mapping table where a wrong value fails nothing is the
   failure mode this issue exists to prevent.
4. `SupportEmail` untouched — it is not a menu entry with an href and must not acquire a
   capability.
5. The delegated-admin sites still on role strings until #123 merges: confirm they are the
   ones named and no others slipped through.

Files touched by me: none. Read-only against `/tmp/qa3-104` at `b557cbbf3`.
