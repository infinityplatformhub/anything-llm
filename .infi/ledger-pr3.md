# PR-3 ledger

Ruling: Store deterministic HMAC-SHA-256 digests as PostgreSQL BYTEA and index them uniquely — O(1) lookup plus pepper separation makes DB dump insufficient — if wrong, pepper compromise still requires forced rotation.
Ruling: Generate 32 random bytes with explicit `apw-key-` and `apw-brx-` prefixes — meets 256-bit entropy and credential dispatch convention — if wrong, clients depending on legacy prefixes require forced migration already mandated by plaintext removal.
Ruling: Store scope arrays as JSON text with temporary `["*"]` on every route — PR-4 owns exact route vocabulary while PR-3 establishes default-deny middleware — if wrong, wildcard transition window remains broader than final least privilege.
Ruling: Missing API_KEY_PEPPER throws synchronously after dotenv and before Express construction/listen — boot must fail closed without self-assignment — if wrong, tests and utility scripts importing models need an explicit test pepper.
Ruling: Authentication audit carries scoped key id and display prefix only — no bearer secret or digest crosses event seam — if wrong, operators lose forensic correlation without improving secrecy.
Ruling: Migration deletes both legacy key tables before dropping plaintext columns — forced rotation was approved because no customer compatibility is required — if wrong, every integration must provision new keys after release.
