
### PMO rulings after Techlead-1 fixture review (da87ec42 FAIL)
- Every mock entry carries `objectClass`; the mock parses `&`/`|`/nested filters; injection fixture is the naive-driver shape `(&(objectClass=…)(uid=*)(uid=*))` and must return everyone.
- `Alice.Smith` DN-case entry exists; driver binds the DN returned by search.
- `search()` requires an authenticated service bind (anonymous read closed).
- Anonymous (§5.1.1) and unauthenticated (§5.1.2) binds are separate flags/tests; `bind(SERVICE_DN,"")` then search is refused.
- `escapeDn` escapes NUL; legit `(`/`*` in cn/mail must still match.
- Zero-result byte-identity is a route-level assertion.
- Ruling (FINDING-5, slot 092000 after route merge): shape-derived row CHECK on identity_providers, no discriminator column; `entityId`/`ssoUrl` empty-string = "not SAML" is a documented contract (COMMENT ON COLUMN + information_schema nullable test); 5 tests incl. mixed rows both directions and literal empty ldapUrl; no NOT VALID.
