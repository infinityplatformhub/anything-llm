# Recon hotfix: browser-extension check/disconnect 500 — locals.apiKey never set (found by QA-2 post-merge 4b-3/4b-4)
- Symptom: GET /api/browser-extension/check and DELETE /api/browser-extension/disconnect → 500 `Cannot read properties of undefined (reading 'id')` with a valid extension key. Extension cannot connect; users cannot self-disconnect.
- Cause: PR-3 fcf09619 rewrote validBrowserExtensionApiKey to set locals.apiKeyContext only; handlers browserExtension.js:30,:50 still read response.locals.apiKey.id. No test covers those 2 routes.
- Fix: in validBrowserExtensionApiKey.js before next(): `response.locals.apiKey = { id: apiKey.id, keyPrefix: apiKey.keyPrefix };` (do NOT touch apiKeyContext shape — T-4b adds keyKind there). HTTP tests: check → 200, disconnect → 200 + row deleted; RED first (500 now).
- Type: hotfix. Collision: Dev4 (T-4b) owns this file — 1-line add, Dev4 rebases.
