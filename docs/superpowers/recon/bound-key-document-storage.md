# Recon: bound API key reaches cross-tenant document storage via 7 /v1/document routes (QA-1 T-4b carve-out probe)
- Routes without apiKeyContext narrowing: GET /v1/documents, GET /v1/documents/folder/:folderName, GET /v1/document/:docName, POST /v1/document/create-folder, DELETE /v1/document/remove-folder, POST /v1/document/move-files, GET /v1/document/generated-files/:filename.
- They read/write document storage on disk (findDocumentInDocuments document/index.js:877 searches all storage); bound key with document.read reads other workspaces' docs; document.folder.manage moves/deletes cross-tenant folders.
- Not a T-4b regression (were TEMPORARY_ALL before PR-4b). Structural: storage is a global namespace. Comment validApiKey.js:40-44 overclaims "document routes narrow" — only 4/16 carve-out routes do.
- Fix: for bound keys, restrict listing/read to docs attached to the bound workspace (workspace_documents join) and refuse folder mutations touching docs of other workspaces; unbound keys unchanged. Fix the comment. HTTP RED per route.
- Owner: Dev1 (owns api/document + bound-key work) after #27.
