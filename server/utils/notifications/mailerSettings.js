// S11a (#80): the mailer's configuration, and the gate that decides whether it
// may be saved.
//
// The rule this file exists to enforce (mockup B, QA-3): a configuration cannot
// be saved until it has ACTUALLY SENT SOMETHING, and the proof is bound to the
// exact settings that sent it. Binding it to the settings rather than to a
// session is the whole point — otherwise an operator verifies one host, edits
// the form, and saves on the previous host's evidence.
//
// The gate lives here, on the server. The wizard's own check is a convenience:
// the save endpoint is reachable without the page, so a client-side gate
// protects nobody.

const crypto = require("crypto");
const { SystemSettings } = require("../../models/systemSettings");

/** Non-secret connection settings. The password is NEVER one of these. */
const SETTING_KEYS = [
  "smtp_host",
  "smtp_port",
  "smtp_secure",
  "smtp_allow_insecure",
  "smtp_username",
  "smtp_from_address",
  "smtp_from_name",
];

/** Where the credential lives: CredentialStore, via KEY_MAPPING. */
const PASSWORD_ENV_KEY = "SMTP_PASSWORD";

/** The row recording which configuration was proven to work. */
const VERIFIED_HASH_KEY = "smtp_verified_hash";

/**
 * Fingerprint the configuration that a successful test proves.
 *
 * HMAC rather than a plain hash: the inputs are largely guessable — a host, a
 * port, a username — so an unkeyed digest could be precomputed and forged into
 * the settings table by anyone who could write one row, producing a "verified"
 * marker for a configuration nobody tested. SIG_KEY makes the marker
 * unforgeable without it.
 *
 * The PLAINTEXT PASSWORD is an input (TL-1). It has to be: rotating the password
 * changes what the configuration means, and a hash that ignored it would keep
 * saying "verified" against a credential that has since changed and may not
 * work. Its presence or absence is not enough — a swapped password is the case
 * that matters.
 *
 * The digest is stored; the inputs are not. Nothing here is reversible into the
 * credential, which is why this can live in `system_settings` beside the
 * non-secret fields while the password itself stays encrypted elsewhere.
 */
function configHash(config = {}, password = "") {
  const material = process.env.SIG_KEY;
  if (!material || material.trim().length < 32)
    throw new Error(
      "SIG_KEY must be set and at least 32 characters before mailer settings can be verified."
    );
  // Sorted and explicitly enumerated, so adding a field to SETTING_KEYS changes
  // every hash — which is correct: a new connection-determining field means the
  // old proof no longer describes the configuration.
  const canonical = SETTING_KEYS.map(
    (key) => `${key}=${String(config[key] ?? "")}`
  ).join("\n");
  return crypto
    .createHmac("sha256", material)
    .update(`${PASSWORD_ENV_KEY}\n${password}\n${canonical}`)
    .digest("hex");
}

/** Read the stored settings, without the password. */
async function readSettings() {
  const rows = await SystemSettings.where({ label: { in: SETTING_KEYS } });
  const settings = {};
  for (const row of rows) settings[row.label] = row.value;
  return settings;
}

/**
 * Is the CURRENT configuration one that was proven to work?
 *
 * Compares against the stored hash, so any edit to a connection field — or a
 * rotated password — invalidates the proof by construction rather than by
 * anyone remembering to clear a flag.
 */
async function isVerified(password) {
  const [settings, stored] = await Promise.all([
    readSettings(),
    SystemSettings.get({ label: VERIFIED_HASH_KEY }),
  ]);
  if (!stored?.value) return false;
  try {
    // Timing-safe: the comparison is against a value an attacker may be able to
    // influence, and a length-varying early exit leaks how much of a forged
    // digest was right.
    const expected = Buffer.from(configHash(settings, password), "utf8");
    const actual = Buffer.from(stored.value, "utf8");
    return (
      expected.length === actual.length &&
      crypto.timingSafeEqual(expected, actual)
    );
  } catch {
    // A missing SIG_KEY means nothing can be verified — fail closed.
    return false;
  }
}

module.exports = {
  SETTING_KEYS,
  PASSWORD_ENV_KEY,
  VERIFIED_HASH_KEY,
  configHash,
  readSettings,
  isVerified,
};
