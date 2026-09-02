# Recon cleanup: 8 pre-existing `postgresql://` literals in test setup (§7.4) — gate is diff-scoped so they never tripped
- apiKeys.postgres.test.js:5 · t1-authz-migration.test.js:44,101 · documentFilter.test.js:22,45 · engine.test.js:23,46 · ssoIssuanceLockHttp.test.js:20
- Fix: import PG_SCHEME from server/utils/test/postgresUrl.js, replace startsWith("postgresql://"). Test-only, no logic. Excluded: connectionParser/envValueMasking test DATA literals (legit fixtures).
- After #29/#39/#27 merge (engine/documentFilter tests move in t4b). Any dev/subagent.
