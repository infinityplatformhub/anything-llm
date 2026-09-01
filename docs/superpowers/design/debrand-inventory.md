# De-brand Inventory

Inventory command (run before replacement):

```sh
grep -RniE 'anythingllm|anything llm|mintplex|useanything|posthog' server frontend collector docker \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git --exclude=LICENSE
```

Initial scoped scan found 1,507 textual matches across 246 files. Counts include localized duplicates, generated OpenAPI examples, package lock metadata, compatibility identifiers, and upstream dependency names.

## Categorized inventory

| Category | Main locations | Action |
|---|---|---|
| UI strings | `frontend/src/locales/*/common.js`, login, onboarding, settings, chat, admin components | Replaced product name with `ApproofWorkspace`; login fallback and custom-app-name default now use new name. |
| Assets | `frontend/public`, `frontend/src/media/logo`, onboarding/login SVGs, `server/storage/assets`, generated-file assets | Replaced defaults with neutral navy/white `AW ApproofWorkspace` placeholders; renamed product-specific logo files; regenerated favicon. |
| Telemetry | `server/models/telemetry.js`, `server/package.json`, `server/yarn.lock`, telemetry UI/helper copy | Replaced adapter with API-compatible local no-op; removed `posthog-node` dependency and lock entry. |
| Docs links and product copy | Swagger/OpenAPI, Docker guide, source comments and README files under scoped directories | Replaced product-facing name. Upstream historical URLs remain only when needed as provenance or dependency references. |
| Package metadata | root, server, frontend, collector `package.json` | Renamed package names to `approofworkspace*`. Original author/license notices retained where legally required. |
| Third-party package names | `@mintplex-labs/*`, lockfiles, imports | Retained: changing registry package identities would break dependency resolution and is not de-branding source ownership. |
| Compatibility identifiers | `application/anythingllm-document`, `x-anythingllm-mobile-device-token`, `ANYTHINGLLM_*`, DB/storage filenames, exported `getAnythingLLMUserAgent` symbol | Retained to prevent API, deployment, and existing-storage breakage; values and user-visible output are de-branded where safe. |

## Remaining-reference policy

Remaining matches are permitted only for third-party package coordinates, original legal attribution, upstream source/history links, or stable compatibility identifiers. They are not UI-facing brand defaults. Placeholder assets are intentionally plain and ready for later design replacement without code changes.
