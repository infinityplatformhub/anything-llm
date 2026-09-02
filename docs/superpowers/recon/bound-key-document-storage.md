# Recon: bound API key reaches cross-tenant document storage via 7 /v1/document routes (QA-1 T-4b carve-out probe)
- Routes without apiKeyContext narrowing: GET /v1/documents, GET /v1/documents/folder/:folderName, GET /v1/document/:docName, POST /v1/document/create-folder, DELETE /v1/document/remove-folder, POST /v1/document/move-files, GET /v1/document/generated-files/:filename.
- They read/write document storage on disk (findDocumentInDocuments document/index.js:877 searches all storage); bound key with document.read reads other workspaces' docs; document.folder.manage moves/deletes cross-tenant folders.
- Not a T-4b regression (were TEMPORARY_ALL before PR-4b). Structural: storage is a global namespace. Comment validApiKey.js:40-44 overclaims "document routes narrow" — only 4/16 carve-out routes do.
- Fix: for bound keys, restrict listing/read to docs attached to the bound workspace (workspace_documents join) and refuse folder mutations touching docs of other workspaces; unbound keys unchanged. Fix the comment. HTTP RED per route.
- Owner: Dev1 (owns api/document + bound-key work) after #27.

## §PMO rulings (2026-09-02, #41)
- Visibility: (ก) strict join — bound key sees only docs with a workspace_documents row for its workspace. Orphans are a shared namespace and never visible to a bound key.
- Upload: POST /v1/document/upload* with a bound key attaches to the bound workspace immediately (in scope for #41; same hole, write side). Unbound key keeps current behaviour.
- Folder routes (create-folder, remove-folder, move-files): bound key → 403, like /v1/workspace/new.
- GET /v1/document/:docName and generated-files: resolve, compare row workspaceId to binding, mismatch → 403 (org-level route, existence not secret).
- Fix validApiKey.js:40-44 comment: boundKeyWorkspaceScope does not exist; the real guard is inline in endpoints/api/workspace/index.js:154 and :82.
- HTTP RED per route with bound key of A against B's docs; unbound key positive control 200 on every route.
- AMENDED (Techlead design check): GET /v1/document/:docName and generated-files → 404 on both mismatch and not-found (§3.4 user-chosen slug; resolve first, compare, no short-circuit, identical body). 403 ruling withdrawn.
- Auto-attach must cover all 4 upload routes (upload, upload/:folderName, upload-link, raw-text via validateWorkspaceSlugQuery) and ship in the same PR as strict join (no window where a bound key uploads but cannot read).
- #54 overlap: none — Actor = grants(creator) ∩ scopes(key), binding only narrows. Add test: remove creator from workspace → bound key 403 immediately (grant read at request time, not mint time).
- generated-files has no owner row (flat disk, no table): bound key → 403 on the whole route (global-namespace class, like folders). Root fix (agent_generated_files table) → follow-up issue. 404 amendment applies to :docName only.
- #41 amendment (Dev1, correct): membership-revoke test replaced by ROLE-revoke → 403 immediately; org-level routes evaluate against workspace_id:null so membership does not authorize them (test asserts this explicitly). boundKeyWorkspaceScope exists as a test file name only.
