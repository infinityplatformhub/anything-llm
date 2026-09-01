# Ledger — #33 part 2 follow-up: AAD binding on credential rows

QA-2 finding against my own part-2 commit (`905d20b0`). Correct, and worth stating plainly: GCM's tag proves the ciphertext was not *edited*; it says nothing about which row it belongs to. Copying KEY_A's `ciphertext`/`iv`/`authTag` over KEY_B's row made `get("KEY_B")` return A's plaintext — so anyone with table write access could point a provider endpoint at a host of their choosing without ever knowing `SIG_KEY`. That is the same class of attack the GCM-over-CBC ruling was meant to close, left open one level up.

Ruling: bound each row with `setAAD(\`${envKey}:v${keyVersion}\`)` on both encrypt and decrypt, as QA-2 specified. The env key makes a blob undecryptable outside the row it was sealed for; the version is included so a future re-key cannot be undone by replaying a row encrypted under an older derivation.

Ruling: decrypt reads the AAD version from `row.keyVersion`, not the module's `KEY_VERSION` constant. Using the constant would make every pre-existing row fail the day the version is bumped, turning a re-key into an outage; reading the row's own version means a stored value decrypts under the derivation it was written with, and a *tampered* version field still fails because it no longer matches the AAD sealed into the tag.

Ruling: added a third case QA-2 did not name — **renaming a row's `envKey` does not carry its value across**. Relocation-by-copy and rename-in-place are the same attack through different SQL, and a fix that caught only the first would leave `UPDATE ... SET "envKey" = ...` open.

Ruling: no re-encryption or migration needed — the table is still empty (part 3, which would populate it, is not written). Doing this before part 3 rather than after is what keeps it a code change instead of a data migration.

RED-proven: removing both `setAAD` calls fails all three new tests, and the relocation test then returns the other key's plaintext rather than null — the attack succeeding is what the red state shows.
