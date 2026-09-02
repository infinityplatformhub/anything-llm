# QA-3 evidence — #78 pre-review on main `a325e180` — 23-key access table

Author: QA-3 (anything-llm-ea). Read-only; no probe DB needed — this is a static
trace of `supportedFields` against the UI that writes each key and the route guard
on the page that hosts it.

## Method

`supportedFields` (28) minus `managerAllowedFields` (5, `admin.js:590-596`) = **23
keys**. For each: which page calls `Admin.updateSystemPreferences` with it, and
which guard wraps that route in `frontend/src/main.jsx`.

Guards measured at `frontend/src/components/PrivateRoute/index.jsx`:
- `AdminRoute` (:79-89) — `user?.role === "admin" || !multiUserMode`
- `ManagerRoute` (:108-117) — `user?.role !== "default" || !multiUserMode` (manager passes)

## The table

| key | page that writes it | guard | manager can open |
|---|---|---|---|
| `text_splitter_chunk_size` | `/settings/text-splitter-preference` | AdminRoute | no |
| `text_splitter_chunk_overlap` | same | AdminRoute | no |
| `agent_clarifying_questions_enabled` | `/settings/agents` | AdminRoute | no |
| `agent_clarifying_questions_max_per_turn` | `/settings/agents` | AdminRoute | no |
| `agent_search_provider` | `/settings/agents` (WebSearchSelection) | AdminRoute | no |
| `agent_sql_connections` | `/settings/agents` (SQLConnectorSelection) | AdminRoute | no |
| `default_agent_skills` | `/settings/agents` | AdminRoute | no |
| `disabled_agent_skills` | `/settings/agents` | AdminRoute | no |
| `disabled_filesystem_skills` | `/settings/agents` | AdminRoute | no |
| `disabled_create_files_skills` | `/settings/agents` | AdminRoute | no |
| `disabled_gmail_skills` | `/settings/agents` | AdminRoute | no |
| `disabled_google_calendar_skills` | `/settings/agents` | AdminRoute | no |
| `disabled_outlook_skills` | `/settings/agents` | AdminRoute | no |
| `gmail_agent_config` | agent plugin `updateConfig`, not this route | — | no |
| `google_calendar_agent_config` | agent plugin `updateConfig`, not this route | — | no |
| `outlook_agent_config` | agent plugin `updateConfig`, not this route | — | no |
| `experimental_live_file_sync` | `/settings/beta-features` | AdminRoute | no |
| `hub_api_key` | `/settings/community-hub/authentication` | AdminRoute | no |
| `default_system_prompt` | `/settings/default-system-prompt`, and it posts to `POST /system/default-system-prompt` — a different route | AdminRoute | no |
| `logo_filename` | no page writes it through this route | — | no |
| `telemetry_id` | no page writes it at all | — | no |
| `memory_enabled` | `MemoriesSidebar/PersonalizationToggle` | not a route guard — `MemoriesContext.jsx:25` `canToggle = !user \|\| user?.role === "admin"` | no |
| `memory_auto_extraction` | same | same | no |

The five manager-allowed keys, for contrast, are written by `/settings/branding`
(`ManagerRoute`): `custom_app_name`, `footer_data`, `support_email`,
`meta_page_title`, `meta_page_favicon`.

## What this changes about #78

1. **The issue's stated premise is wrong.** It says the manager-forbidden settings
   "are already visible to a manager in the UI". None of the 23 are: every page
   that writes one is `AdminRoute`, or gated by an equivalent role check.

2. **The ruling "403 only for keys the manager can actually reach in the UI" makes
   the issue a no-op.** No key qualifies, including `text_splitter_chunk_size`,
   which the issue uses as its worked example.

3. Three findings that belong elsewhere:
   - `memory_enabled` / `memory_auto_extraction` are gated in **React context
     only** — a client-side check with no server counterpart. A manager posting
     them directly is not stopped by anything in the browser. Separate recon item.
   - `default_system_prompt` reaches `SystemSettings.updateSettings` through
     `POST /system/default-system-prompt` (`system.js:1011`), not through
     `admin.js:583`, so it is outside this issue's route regardless.
   - `logo_filename` and `telemetry_id` have no writer on this route, so a refusal
     for them would refuse something nobody sends.

## Recommendation taken

Option 3 (PMO accepted): refuse with 403 `forbidden_keys` when the key is in
`supportedFields` but not manager-allowed; keep 200-and-silent for keys that are
not in `supportedFields` at all, per #72. The oracle this opens is "does this
build know this key", which an open-source build discloses in its source anyway —
unlike per-instance state, which is what #72's silence protects.
