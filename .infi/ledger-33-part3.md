# Ledger — issue 33, P0-4D(c) part 3: .env stops holding provider credentials

Part 2 built the encrypted store and nothing used it. This is the half that moves the secrets.

Ruling: `dumpENV` builds its allowlist from `KEY_MAPPING` **excluding `secret: true`** — 91 settings stop being written to the file. `secret: "url"` entries stay: an endpoint's host is configuration an operator needs in the file, and its inline userinfo is stripped before the value is stored. If wrong, a deployment that reads a provider key straight out of `.env` with its own tooling stops finding it there.

Ruling: **`SIG_KEY` and `SIG_SALT` stay in the file** even though they are the most sensitive values present. They derive the key that decrypts the store; putting them inside it would be a circular dependency with no boot path. Called out because a later pass tightening "no secrets in .env" will look at these two and must not move them.

Ruling: **no data migration.** Slot 061000 is a documented no-op. Moving existing values would mean encrypting them in SQL, and the key is derived from `SIG_KEY` through scrypt in the application — a migration has neither that derivation nor the process environment holding the plaintext, so any SQL that appeared to do it would be writing something other than a valid GCM row. Each credential moves on its next save, through the same `CredentialStore` path every new value takes.

The consequence, stated rather than left to be discovered: after this ships, a credential that has never been re-saved lives **only** in the existing `.env` file. A deployment that rebuilds `.env` from scratch (a fresh container with no volume) loses it and must set it again. That is the exposure the file always had, not a new one, and it ends per-credential as each is re-saved. If wrong, an operator hits a missing provider key on a rebuild and the release note is where they should have read about it.

Ruling: **`process.env` stays the read path.** Hundreds of call sites read these variables directly and rewriting them is not this task; what changed is where a value *persists*. `loadStoredCredentials()` puts stored values back into `process.env` at boot, so nothing downstream knows the difference.

Ruling: a value **already in the environment wins** over a stored row. An operator exporting a variable, or a container injecting one, is making a deliberate override that a database row must not silently replace.

Ruling: a row that **fails its auth tag leaves the variable unset**, not set to something. `CredentialStore.get` returns null for a tampered row; an unconfigured provider fails loudly at first use, where a tampered value fails silently or somewhere worse.

Ruling: `persistCredential` **logs and continues** rather than throwing. The value is already live in `process.env` and the setting has been accepted, so throwing would 500 a request whose work is done. The cost — the credential not surviving a restart — is what the log says explicitly.

Ruling: the loader is wired into **both `bootHTTP` and `bootSSL`**, first in each, with a test asserting two call sites. This is the exact gap QA-1 found in my legacy-wildcard report (#27), where an HTTPS deployment saw nothing; the same omission here would leave every provider unconfigured on HTTPS rather than merely unreported.

Ruling: gave `dumpENV` an optional `envPath`. My first version of the dumpENV test re-derived the allowlist and asserted against its own filter — it would have passed with `dumpENV` untouched, and it did: the RED proof came back green. The test now drives the real function against a temp file, and removing the filter fails it. Recorded because a test that tests itself is worse than no test, and I nearly shipped one.
