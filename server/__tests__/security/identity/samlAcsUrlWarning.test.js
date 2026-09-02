// S2 (#43) — the Host-header fallback must not be silent.
//
// RED-first: written before the warning exists.
//
// Background: the ACS URL is what the signed assertion's `Recipient` is compared
// against. Derived from the request's `Host` header, that comparison checks a
// caller-controlled string against itself and establishes nothing.
//
// The fallback stays, because removing it would break a deployment that has not
// configured a base URL yet. But a security check that has quietly degraded to a
// no-op is worse than one that is absent: the absent one is visible. So an
// operator running SAML without a configured ACS URL is told, every boot.

const { samlIdentityEndpoints } = require("../../../endpoints/identity/saml");

/** A stand-in for the Express router: it only has to accept route registrations. */
const fakeApp = () => ({ get: () => {}, post: () => {} });

const ENV_KEYS = [
  "SSO_SAML_ENABLED",
  "SSO_ACS_URL",
  "SSO_CALLBACK_BASE_URL",
];

let saved;
let errors;
let originalError;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  errors = [];
  originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
});

afterEach(() => {
  console.error = originalError;
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("the Host-header fallback is never silent", () => {
  test("SAML enabled with no configured ACS URL warns at boot", () => {
    process.env.SSO_SAML_ENABLED = "true";
    samlIdentityEndpoints(fakeApp());

    const warning = errors.join("\n");
    // It has to name what stopped working, not merely that something is unset —
    // "SSO_ACS_URL is not set" reads as a missing convenience, which is exactly
    // how a degraded security check gets ignored for a year.
    expect(warning).toMatch(/recipient/i);
    expect(warning).toMatch(/SSO_ACS_URL/);
  });

  test("a configured SSO_ACS_URL is silent", () => {
    process.env.SSO_SAML_ENABLED = "true";
    process.env.SSO_ACS_URL = "https://app.example.com/api/sso/saml/acs";
    samlIdentityEndpoints(fakeApp());
    expect(errors.join("\n")).not.toMatch(/recipient/i);
  });

  test("a configured SSO_CALLBACK_BASE_URL is also enough", () => {
    process.env.SSO_SAML_ENABLED = "true";
    process.env.SSO_CALLBACK_BASE_URL = "https://app.example.com";
    samlIdentityEndpoints(fakeApp());
    expect(errors.join("\n")).not.toMatch(/recipient/i);
  });

  test("SAML disabled says nothing", () => {
    // No warnings for a feature nobody turned on: an operator who ignores one
    // irrelevant warning learns to ignore the relevant ones too.
    samlIdentityEndpoints(fakeApp());
    expect(errors.join("\n")).not.toMatch(/recipient/i);
  });
});
