# Techlead-1 — pre-read #121 (plain; this is the only gate) on recon `d0ac7786f`

Read: `.infi/recon/recon-121.md`, `components/SettingsSidebar/index.jsx`,
`components/SettingsSidebar/MenuOption/index.jsx`, `components/Modals/ManageWorkspace/index.jsx`,
`QuickActions`, `server/endpoints/mobile/index.js`, `server/endpoints/extensions/index.js`,
`prisma/migrations/20260902020000_t1_authz_schema/migration.sql`.

## The three rulings

**R1 — `ManageWorkspace` = `workspace.embeddings.manage`. ACCEPT, with a correction.**
Traced the same way and reached the same place: `:90-95` renders `DocumentSettings` on the
`documents` tab, whose only write is `Workspace.modifyEmbeddings`
(`ManageWorkspace/Documents/index.jsx:70`) → `workspace.embeddings.manage`. Dev1 is right that
`workspace.write` would offer the tab to callers the server refuses.

**But the switcher opens TWO tabs, and the second one is a different permission.** The `else`
branch at `:94` renders `DataConnectors`, and every data-connector route is gated on
`document.create` (`endpoints/extensions/index.js:19,43,68,90,111,132,154,176`, 8 sites, one
action). So one boolean cannot honestly gate `ModalTabSwitcher` — a caller holding
`document.create` but not `workspace.embeddings.manage` should see the connectors tab and not
the documents tab. Gating the whole switcher on the embeddings permission hides a tab they
may use; gating it on `document.create` shows one they may not.

The smallest honest version: gate **each tab button** on its own capability and the switcher
on the OR. If that is too much for this issue, gate on the OR and record the residual — but
do not ship one permission standing for two.

**R2 — `QuickActions:33` = `workspace.write`, not `user.manage`. ACCEPT, no reservation.**
Confirmed: `onEditWorkspace` navigates to `paths.workspace.settings.generalAppearance()`;
nothing on that path touches a user. The `["admin","manager"]` list matching `user.manage`'s
holder set is the coincidence Dev1 names, and it is exactly the "derive the new check from
the old one and inherit its drift" failure the issue exists to fix. Good catch.

**R3 — no-server-action entries (telegram, scheduled-jobs) get no capability = residual. ACCEPT.**
A capability invented for a menu with no server gate behind it is a guard that cannot be
wrong, which is worse than the role string: at least the role string is visibly legacy.
Leaving them and recording it is right.

**R4 — users/invites = READ action. ACCEPT** — the menu opens a list; the write is behind the
buttons inside it, each of which re-decides. `user.read` / `invite.read` are the actions the
page's first request actually makes.

## FINDING-1 — `settings/security` is unreachable in multi-user mode TODAY, and the mapping hides that

`SettingsSidebar/index.jsx:453-460`:

```jsx
<Option ... href={paths.settings.security()} flex={true}
        roles={["admin","manager"]} hidden={user?.role} />
```

`MenuOption:44` is `if (hidden) return null;` — evaluated **before** any roles check. `user?.role`
is a non-empty string for every user in multi-user mode, so it is truthy and the option is
**always hidden**. It appears only in single-user mode, where `user` is null and `hidden` is
`undefined`. The `roles={["admin","manager"]}` prop on that line is dead today.

That makes the `settings.write` vs `system.write` question Dev1 parked (recon §"ยังไม่ได้ทำ")
moot for behaviour and dangerous for the diff: swapping `roles` for a capability changes
nothing, and **removing `hidden`** — which a dev tidying the line would reasonably do, since it
now looks like leftover role logic — silently un-hides a menu item that has been hidden. That
is a behaviour change smuggled into a mapping issue.

**Ruling I recommend: leave `hidden={user?.role}` exactly as it is, map the capability beside
it, and put a comment on the line saying it is load-bearing.** Whether the security menu
should be visible in multi-user mode is a real question and it is not this issue's.

## FINDING-2 — `flex` already encodes the `!user ||` disjunct; do not re-implement it

`MenuOption:50-51` and `:58-59` are a pair:

```js
if (!flex && !roles.includes(user?.role)) return null;
if (flex && !!user && !roles.includes(user?.role)) return null;
```

`flex: true` means "no user (single-user) ⇒ visible", which is the same disjunct the recon
correctly insists on preserving at `FileUploadWarningModal:28` / `ParsedFilesMenu:23` /
`QuickActions`. Every sidebar entry sets `flex: true` (measured: 27 `roles:` entries, all
flex). So the capability version must keep the `!!user &&` guard, not just swap
`roles.includes(user?.role)` for `!can(action)`. Dropping it takes the whole settings sidebar
away from single-user installs.

`hasVisibleOptions:186-187` repeats both lines. Changing one and not the other gives a parent
that hides while its children show, or the reverse — as the recon says. It must be the same
predicate, which argues for extracting one function both call rather than editing two copies.

## FINDING-3 — `can()` is false while loading, and the sidebar has no loading state today

`useCapabilities` returns `can(action) === false` during load. The sidebar renders
immediately, so every gated entry will **flash absent then appear** on every settings page
load — where today the role string is available synchronously from storage and nothing
flashes. That is a visible regression, not just a test concern.

`hidePrivacyLink` in #40 t4 handles it with `loading || !can(...)` (hide while unsure), which
is right for a link but wrong for a whole menu: hiding the entire sidebar for a beat is worse
than a late-appearing item. **Recommend: render gated entries only once `loading === false`,
and render nothing (not a skeleton) for them until then** — same visual result as today for a
fast response, and no flash of a wrong menu. Say which was chosen in the code.

## REQUIRED RED FIXTURES

```
RF-1 : per-site capability identity — for each of the 14 sites, the fixture holds
       EXACTLY ONE capability and asserts that site visible + at least one OTHER
       gated site hidden in the same render
mut  : swap any two sites' capabilities (e.g. QuickActions:33 workspace.write <->
       user.manage, per R2)
why  : a fixture holding an "admin-like" bundle is green under every swap, because
       admin holds both. Only a single-capability fixture separates them, and only
       asserting a second site in the same render catches a swap rather than a
       widening.
```
```
RF-2 : single-user (user === null) sees every one of the 14 sites
mut  : drop the `!!user &&` half of MenuOption:51 / :59 / :187 (or the `!user ||`
       disjunct at the three component sites)
why  : every multi-user fixture is green under this mutation — it only changes the
       branch where `user` is null. This is the one that costs a real deployment its
       whole UI, and nothing else reaches it.
```
```
RF-3 : parent/child agreement — a fixture with no capabilities asserts the PARENT
       menu is absent, not merely its children; and a fixture holding exactly one
       child's capability asserts the parent IS present
mut  : convert MenuOption:50-51 to capabilities and leave hasVisibleOptions:186-187
       on roles
why  : the mutation leaves both the all-caps and no-caps fixtures green — the parent
       and children agree at both extremes. Only the one-child-visible fixture
       separates them.
```
```
RF-4 : ManageWorkspace — a fixture holding document.create but NOT
       workspace.embeddings.manage; assert what the ruling on R1 decides (both tabs
       reachable / connectors only / switcher hidden with residual recorded)
mut  : gate the switcher on workspace.write
why  : an admin fixture holds all three, so the R1 correction is invisible without a
       fixture that splits document.create from workspace.embeddings.manage.
```
```
RF-5 : settings/security stays hidden for a multi-user admin holding system.write
mut  : delete `hidden={user?.role}` at SettingsSidebar:459
why  : FINDING-1 — every capability fixture is green under that deletion, because
       the capability check passes for an admin either way. The assertion must be
       "hidden DESPITE holding the capability", which is the only shape that fails.
```
```
RF-6 : loading — assert the chosen behaviour (FINDING-3) explicitly: during load a
       gated entry is absent AND the ungated entries are present
mut  : `loading || !can(x)` -> `!can(x)`
why  : both spellings hide the entry while loading; they differ only in what happens
       when can() resolves true late. Assert the RESOLVED state after loading too, in
       the same test, or the mutation survives.
```

## Not blocking, worth one line each

- The recon's "MenuOption client-side guard is not evidence, I traced the API each page calls" is the right method and is why R2 was caught. Say so in the ledger; it is the reusable part.
- `mobile-app` — my separate ruling stands: `system.read` must go into `ORG_CAPABILITIES` in this issue (it is not there: `system.js:111-121`, 7 entries), and the `ManagerRoute → AdminRoute` change is a separate auth-tier issue.
