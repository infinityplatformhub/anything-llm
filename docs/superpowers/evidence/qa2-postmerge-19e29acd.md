# QA-2 post-merge probe — main 19e29acd (2026-09-02)
Fresh DB, migrate deploy: 109/109 suites, 1163/1163 tests (run 2; run 1 had providerDocIdCallSites 5s hook timeout, passes alone 20/20).
#27 PASS: no includes("*") in validApiKey; W-9 chain intact; raw ["*"] + 8 glob/case/trim variants → 403 {"error":"Insufficient scope."}; positive control 200; bootHTTP+bootSSL report; migration 045000 records legacy grants before rewrite, drops only system.env.read.
Note: admin self-mint scopes:["system.env.read"] → env-dump 200 (creator holds super_admin). Preset is default not ceiling → #35 PR-4d.
#45 PASS: assertKeyKind throws AuthorizationContractError for 13 malformed shapes; positive controls api-key / browser-extension / no context pass; surfaces to 500 at requirePermission.js:70 by design.
