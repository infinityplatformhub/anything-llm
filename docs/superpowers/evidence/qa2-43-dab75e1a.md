# QA-2 evidence — #43 dab75e1a — PASS 23/23 (135 suites / 1395 tests, §7.9a suite-level)

Author: QA-2 (anything-llm-e6), transcribed by PMO. Pinned detached worktree at dab75e1a (first run on Dev3's live `s2-saml` worktree was void: uncommitted SAML registry edits flipped `isKnownProvider("saml")`). node 22.23.1, PG16.14 own container.

1. `xswUnwrappedSubject`: attacker NameID not returned; signed `person@example.com` returned. RED: document-wide `//saml:NameID` yields attacker. Fixture passes all 3 existing guards. Extended: forged `<saml:Conditions><saml:Audience>` in Extensions → document-wide read gets attacker, anchored read gets SP entity ID.
2. `selfSignedWithKeyInfo`: refused vs configured key; verifies with its own embedded key (proves well-formed forgery, not broken XML); X509Certificate present in KeyInfo; wrongKey/unsigned refused.
3. `UNIQUE(provider, assertionId)`: 2-way and 8-way concurrent claims → exactly 1 winner (P2002), 1 row; scoped per provider (`saml` vs `saml-tenant2` share an ID); unique index + `expiresAt` index present in `pg_indexes`.
4. `identity_providers`: no column matching `secret|private|password|credential|key$|token|pfx|pkcs`; `certificates` is ARRAY; `enabled` default false; `UNIQUE(provider)`.
5. NFC backfill on PG16: `normalize(...,NFC)` composes; migration UPDATE composes on scratch and on real `identity_links` (decomposed row inserted via Prisma → composed); idempotent; live table `WHERE email <> normalize(email,NFC)` → 0 rows.

Note for next commit: `registry.test.js:30` must expect `isKnownProvider("saml") === true` once SAML registers.
