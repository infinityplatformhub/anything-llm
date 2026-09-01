// P0-4D(c): provider credentials, encrypted at rest.
//
// Provider secrets live in the .env file today. PR-4D(a) made that file 0600 and wrote
// it atomically, which stops another local account reading it — but it is still
// plaintext on disk and still in every backup of the storage volume.
//
// AES-256-GCM, not EncryptionManager's aes-256-cbc. CBC is unauthenticated: anyone who
// can write the table can flip ciphertext bits and the decrypted value changes with
// nothing to detect it, which for a provider endpoint means redirecting traffic. GCM's
// tag makes that a decryption failure instead.

const crypto = require("crypto");
const prisma = require("../utils/prisma");

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // GCM's standard nonce length; 16 would be re-derived internally.
const KEY_VERSION = 1;

/**
 * The table's encryption key, derived from SIG_KEY.
 *
 * SIG_KEY already has to be stable for a deployment (EncryptionManager depends on it),
 * so this adds no new secret to manage. It is derived rather than used directly so that
 * a future rotation can version the derivation without touching SIG_KEY itself.
 *
 * @returns {Buffer} 32-byte key
 * @throws when SIG_KEY is absent — a credential store with no key must not start,
 *   the way an absent API_KEY_PEPPER fails closed rather than self-assigning.
 */
/**
 * What each row's ciphertext is bound to, so a blob only decrypts under the identity it
 * was sealed with.
 *
 * GCM's tag proves the ciphertext was not edited; it says nothing about which row it
 * belongs to. Without this, copying KEY_A's ciphertext/iv/authTag over KEY_B's row makes
 * `get("KEY_B")` return A's value — an attacker with table write access redirects a
 * provider endpoint without ever knowing SIG_KEY (QA-2, #33 part 2).
 *
 * The version is included so a future re-key cannot be undone by replaying a row
 * encrypted under an older derivation.
 *
 * @param {string} envKey
 * @param {number} keyVersion
 * @returns {Buffer}
 */
function credentialAAD(envKey, keyVersion) {
  return Buffer.from(`${envKey}:v${keyVersion}`, "utf8");
}

function encryptionKey() {
  const material = process.env.SIG_KEY;
  if (!material || material.trim().length < 32)
    throw new Error(
      "SIG_KEY must be set and at least 32 characters before credentials can be stored."
    );
  return crypto.scryptSync(material, `credential-store-v${KEY_VERSION}`, 32);
}

const CredentialStore = {
  /**
   * Stores one credential, replacing any previous value for the same key.
   *
   * @param {string} envKey the KEY_MAPPING envKey this value belongs to
   * @param {string} value the plaintext credential
   * @param {Object} db injectable for tests
   * @returns {Promise<{envKey:string, error:string|null}>}
   */
  set: async function (envKey, value, db = prisma) {
    try {
      if (typeof envKey !== "string" || !envKey.trim())
        throw new Error("A credential must be stored under a non-empty env key.");
      if (typeof value !== "string" || !value)
        throw new Error("A credential must have a value; delete the row to clear it.");

      const iv = crypto.randomBytes(IV_BYTES);
      const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey(), iv);
      cipher.setAAD(credentialAAD(envKey, KEY_VERSION));
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      const authTag = cipher.getAuthTag();

      await db.credential_store.upsert({
        where: { envKey },
        create: { envKey, ciphertext, iv, authTag, keyVersion: KEY_VERSION },
        update: { ciphertext, iv, authTag, keyVersion: KEY_VERSION },
      });
      return { envKey, error: null };
    } catch (error) {
      // Never log the value; the message may carry the key name only.
      console.error(`[credential-store] failed to store ${envKey}:`, error.message);
      return { envKey, error: error.message };
    }
  },

  /**
   * @param {string} envKey
   * @param {Object} db injectable for tests
   * @returns {Promise<string|null>} the plaintext, or null when absent or tampered with
   */
  get: async function (envKey, db = prisma) {
    const row = await db.credential_store.findUnique({ where: { envKey } }).catch(() => null);
    if (!row) return null;
    try {
      const decipher = crypto.createDecipheriv(ALGORITHM, encryptionKey(), row.iv);
      // Bound to the row's own identity: a blob moved from another key, or written under
      // a different keyVersion, fails the tag rather than decrypting.
      decipher.setAAD(credentialAAD(envKey, row.keyVersion));
      decipher.setAuthTag(row.authTag);
      return decipher.update(row.ciphertext, undefined, "utf8") + decipher.final("utf8");
    } catch (error) {
      // A tag mismatch means the row was altered, or SIG_KEY changed. Either way the
      // value is not trustworthy: return nothing rather than a guess.
      console.error(`[credential-store] could not decrypt ${envKey}:`, error.message);
      return null;
    }
  },

  /**
   * @param {Object} db injectable for tests
   * @returns {Promise<string[]>} which env keys have a stored credential — names only,
   *   never values, so a caller can report coverage without decrypting anything.
   */
  keys: async function (db = prisma) {
    const rows = await db.credential_store
      .findMany({ select: { envKey: true } })
      .catch(() => []);
    return rows.map((row) => row.envKey);
  },

  delete: async function (envKey, db = prisma) {
    return db.credential_store
      .delete({ where: { envKey } })
      .then(() => true)
      .catch(() => false);
  },
};

module.exports = { CredentialStore, ALGORITHM, KEY_VERSION };
