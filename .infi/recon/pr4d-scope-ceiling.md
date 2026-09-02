# Recon PR-4d: API-key scope ceiling = creator's grants (after #27, #29)
- Today (PR-4c): key creation at admin.js:526 / system.js:1073 uses admin-gated presets; safe only because both sites sit behind admin gate (ponytail in #27 ledger).
- Work: ApiKey.create(creatorId, name, scopes) validates each requested scope with engine.authorize(creatorActor, scope-action, orgResource/workspaceResource) — reject with 403 listing the scopes the creator lacks; bound-key creation requires creator membership of that workspace. UI scope picker shows only creator-allowed scopes (frontend).
- Owner files: server/models/apiKeys.js (validateScopes → authorizeScopes), server/endpoints/admin.js + system.js key handlers (post-T-4a), frontend key-creation modal. No migration.
- Deps: #27 (validateScopes), #29 (grantPrincipal, resolveActor), #25 (requirePermission on those handlers).
- RED DoD: HTTP — setup_admin (holds key.manage, lacks system.env.read) creating key with `system.env.read` → 403 listing ALL missing scopes naming the scope; super_admin same → 201; bound key for non-member workspace → 403; extension keys unaffected. Ledger: replaces #27 ponytail.
