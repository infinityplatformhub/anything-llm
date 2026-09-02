# Recon: no way to clear a stored credential — validator rejects empty before persistCredential's delete path (QA-1 #33p3 post-merge)
- updateENV({OpenAiKey:""}) → validator "Value cannot be empty" → persistCredential delete branch (updateENV.js:1772-1775, credentialStore.js:50 "delete the row to clear it") is dead for every key with a non-empty validator. Row stays decryptable forever; operator cannot revoke via UI.
- Fix: explicit clear path — e.g. `DELETE /api/system/credential/:envKey` (requirePermission settings.write) or a sentinel in updateENV that bypasses value validators and calls CredentialStore.remove + unsets process.env. Audit event on clear. Frontend "Clear" button later.
- RED: set key → clear → store row gone, process.env unset, provider unconfigured. Pre-existing validator behavior; not a leak.
- Owner: Dev1 (owns updateENV/system.js key handlers) after #27/#35. No migration.
