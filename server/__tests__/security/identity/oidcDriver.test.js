// S1 (#36) T3 — OidcIdentityProvider. RED-first, written before the driver.
//
// Covers recon §4 cases 2,3,4,7,8. The driver's whole job is to REFUSE things:
// every test here is a rejection, because the one case that must never happen is
// a malformed assertion producing a principal core would then trust.
//
// Signing keys are generated per-run, so a test that passes because verification
// was skipped is impossible — an unsigned or wrongly-signed token has to fail.

const crypto = require("crypto");
const JWT = require("jsonwebtoken");
const {
  OidcIdentityProvider,
} = require("../../../utils/identityProviders/OidcIdentityProvider");
const {
  IdentityAuthenticationError,
  IdentityUnavailableError,
  IdentityCapabilityError,
  IdentityConfigurationError,
} = require("../../../utils/identityProviders/errors");

const ISSUER = "https://idp.example.com";
const CLIENT_ID = "approof-workspace";
const REDIRECT_URI = "https://app.example.com/sso/oidc/callback";

let privateKey;
let publicJwk;
const kid = "test-key-1";

beforeAll(() => {
  const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateKey = pair.privateKey;
  publicJwk = {
    ...pair.publicKey.export({ format: "jwk" }),
    kid,
    alg: "RS256",
    use: "sig",
  };
});

const discovery = () => ({
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/jwks`,
});

/** An ID token signed by the test key. Overrides let each case break one thing. */
function idToken(overrides = {}, signWith = privateKey) {
  const { iss, aud, ...claims } = overrides;
  return JWT.sign(
    {
      sub: "external-subject-1",
      email: "person@example.com",
      email_verified: true,
      name: "A Person",
      nonce: "the-expected-nonce",
      ...claims,
    },
    signWith,
    {
      algorithm: "RS256",
      keyid: kid,
      issuer: iss ?? ISSUER,
      audience: aud ?? CLIENT_ID,
      expiresIn: "5m",
    }
  );
}

/** A token missing one of the claims idToken always sets. */
function tokenWithout(claims) {
  return JWT.sign(claims, privateKey, {
    algorithm: "RS256",
    keyid: kid,
    issuer: ISSUER,
    audience: CLIENT_ID,
    expiresIn: "5m",
  });
}

/**
 * A fetch stub covering discovery, JWKS and the token endpoint. `tokenResponse`
 * is what the IdP returns from /token; `fail` forces a network-level error.
 */
function fakeFetch({ token, fail = null, tokenStatus = 200, keys = null, counter = null } = {}) {
  return async (url) => {
    const href = String(url);
    if (fail) throw fail;
    if (href.endsWith("/.well-known/openid-configuration"))
      return { ok: true, status: 200, json: async () => discovery() };
    if (href === `${ISSUER}/jwks`) {
      if (counter) counter.jwks += 1;
      const published = typeof keys === "function" ? keys() : (keys ?? [publicJwk]);
      return { ok: true, status: 200, json: async () => ({ keys: published }) };
    }
    if (href === `${ISSUER}/token`)
      return {
        ok: tokenStatus === 200,
        status: tokenStatus,
        json: async () => ({ id_token: token, token_type: "Bearer" }),
        text: async () => "token endpoint error",
      };
    throw new Error(`unexpected fetch: ${href}`);
  };
}

const driver = (overrides = {}) =>
  new OidcIdentityProvider({
    issuer: ISSUER,
    clientId: CLIENT_ID,
    clientSecret: "shhh",
    fetchImpl: fakeFetch(),
    ...overrides,
  });

describe("OidcIdentityProvider — static contract", () => {
  test("providerId is stable", () => {
    expect(OidcIdentityProvider.providerId()).toBe("oidc");
  });

  test("advertises no directory or group sync", () => {
    // S4 owns directory sync. A driver claiming it here would have core
    // emulating org membership from login activity, which seam §Boundaries
    // forbids outright.
    expect(OidcIdentityProvider.capabilities()).toEqual({
      directorySync: false,
      groupSync: false,
      deltaSync: false,
    });
  });

  test("construction without issuer or clientId fails closed", () => {
    expect(() => new OidcIdentityProvider({ clientId: CLIENT_ID })).toThrow(
      IdentityConfigurationError
    );
    expect(() => new OidcIdentityProvider({ issuer: ISSUER })).toThrow(
      IdentityConfigurationError
    );
  });
});

describe("capability honesty (recon §4 case 8)", () => {
  test("listPrincipals throws because directorySync is false", async () => {
    await expect(driver().listPrincipals({})).rejects.toThrow(IdentityCapabilityError);
  });

  test("listGroups throws because groupSync is false", async () => {
    await expect(driver().listGroups({})).rejects.toThrow(IdentityCapabilityError);
  });
});

describe("beginLogin", () => {
  test("returns an authorization URL carrying state and a PKCE challenge", async () => {
    const challenge = await driver().beginLogin({
      redirectUri: REDIRECT_URI,
      stateToken: "state-abc",
      nonce: "nonce-abc",
      codeVerifier: "verifier-abc",
    });

    const url = new URL(challenge.authorizationUrl);
    expect(url.origin + url.pathname).toBe(`${ISSUER}/authorize`);
    expect(url.searchParams.get("state")).toBe("state-abc");
    expect(url.searchParams.get("nonce")).toBe("nonce-abc");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("response_type")).toBe("code");
    // S256, never "plain": a plain challenge is the verifier in the clear and
    // defeats the point of PKCE.
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const expected = crypto
      .createHash("sha256")
      .update("verifier-abc")
      .digest("base64url");
    expect(url.searchParams.get("code_challenge")).toBe(expected);
  });
});

describe("completeLogin — every assertion the driver must refuse", () => {
  const call = (extra = {}) =>
    driver({ fetchImpl: fakeFetch({ token: extra.token }) }).completeLogin({
      redirectUri: REDIRECT_URI,
      callbackParams: { code: "auth-code" },
      codeVerifier: "verifier-abc",
      expectedNonce: "the-expected-nonce",
      ...extra.input,
    });

  test("a well-formed token yields a normalized ExternalPrincipal", async () => {
    const principal = await call({ token: idToken() });
    expect(principal).toMatchObject({
      provider: "oidc",
      subject: "external-subject-1",
      email: "person@example.com",
      emailVerified: true,
      displayName: "A Person",
      groups: [],
    });
    // The raw claims travel for core's benefit, but the driver must not have
    // decided anything with them.
    expect(principal.claims.sub).toBe("external-subject-1");
  });

  test("case 2: a nonce that does not match the stored one is rejected", async () => {
    await expect(
      call({ token: idToken({ nonce: "someone-elses-nonce" }) })
    ).rejects.toThrow(IdentityAuthenticationError);
  });

  test("case 2b: a token with NO nonce is rejected, not treated as matching", async () => {
    // An absent claim compared against an expected value is the classic
    // undefined == undefined bypass.
    const token = tokenWithout({ sub: "s", email: "e@x.com", email_verified: true });
    await expect(call({ token })).rejects.toThrow(IdentityAuthenticationError);
  });

  test("case 3a: a token from the wrong issuer is rejected", async () => {
    await expect(
      call({ token: idToken({ iss: "https://evil.example.com" }) })
    ).rejects.toThrow(IdentityAuthenticationError);
  });

  test("case 3b: a token minted for a different audience is rejected", async () => {
    await expect(
      call({ token: idToken({ aud: "some-other-client" }) })
    ).rejects.toThrow(IdentityAuthenticationError);
  });

  test("case 3c: a token signed by an unknown key is rejected", async () => {
    const { privateKey: attackerKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    await expect(
      call({ token: idToken({}, attackerKey) })
    ).rejects.toThrow(IdentityAuthenticationError);
  });

  test("case 3d: an unsigned (alg:none) token is rejected", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
      "base64url"
    );
    const body = Buffer.from(
      JSON.stringify({
        sub: "s",
        email: "e@x.com",
        email_verified: true,
        nonce: "the-expected-nonce",
        iss: ISSUER,
        aud: CLIENT_ID,
        exp: Math.floor(Date.now() / 1000) + 300,
      })
    ).toString("base64url");
    await expect(call({ token: `${header}.${body}.` })).rejects.toThrow(
      IdentityAuthenticationError
    );
  });

  test("case 3e: an HS256 token signed with the client secret is rejected (alg confusion)", async () => {
    // The classic attack: a verifier that reads `alg` off the header can be
    // told to verify symmetrically, so an attacker holding the CLIENT SECRET —
    // a credential the app hands out, not a signing key — signs their own
    // token and it passes. The allowlist is fixed, so the header's claim about
    // its own algorithm never chooses the verification path.
    const forged = JWT.sign(
      {
        sub: "attacker",
        email: "attacker@example.com",
        email_verified: true,
        nonce: "the-expected-nonce",
      },
      "shhh",
      { algorithm: "HS256", issuer: ISSUER, audience: CLIENT_ID, expiresIn: "5m" }
    );
    await expect(call({ token: forged })).rejects.toThrow(IdentityAuthenticationError);
  });

  test("case 4: email_verified false is rejected — an IdP may not assert an address it did not verify", async () => {
    await expect(
      call({ token: idToken({ email_verified: false }) })
    ).rejects.toThrow(IdentityAuthenticationError);
  });

  test("case 4b: a missing email_verified claim is rejected, not assumed true", async () => {
    const token = tokenWithout({
      sub: "s",
      email: "e@x.com",
      nonce: "the-expected-nonce",
    });
    await expect(call({ token })).rejects.toThrow(IdentityAuthenticationError);
  });

  test("case 7: a provider that cannot be reached raises the retryable error and no principal", async () => {
    const network = Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
    const failing = new OidcIdentityProvider({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      clientSecret: "shhh",
      fetchImpl: fakeFetch({ fail: network }),
    });
    const error = await failing
      .completeLogin({
        redirectUri: REDIRECT_URI,
        callbackParams: { code: "auth-code" },
        codeVerifier: "v",
        expectedNonce: "the-expected-nonce",
      })
      .catch((e) => e);
    expect(error).toBeInstanceOf(IdentityUnavailableError);
    // Retryable is what separates "try again" from "this login is invalid";
    // a caller that retried an auth failure would loop on a bad token.
    expect(error.retryable).toBe(true);
  });

  test("a token endpoint returning an error status is not treated as a login", async () => {
    const failing = new OidcIdentityProvider({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      clientSecret: "shhh",
      fetchImpl: fakeFetch({ token: idToken(), tokenStatus: 401 }),
    });
    await expect(
      failing.completeLogin({
        redirectUri: REDIRECT_URI,
        callbackParams: { code: "bad-code" },
        codeVerifier: "v",
        expectedNonce: "the-expected-nonce",
      })
    ).rejects.toThrow(IdentityAuthenticationError);
  });

  test("a callback carrying the IdP's own error is rejected before any exchange", async () => {
    let called = false;
    const spy = new OidcIdentityProvider({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      clientSecret: "shhh",
      fetchImpl: async (...args) => {
        called = true;
        return fakeFetch({ token: idToken() })(...args);
      },
    });
    await expect(
      spy.completeLogin({
        redirectUri: REDIRECT_URI,
        callbackParams: { error: "access_denied" },
        codeVerifier: "v",
        expectedNonce: "the-expected-nonce",
      })
    ).rejects.toThrow(IdentityAuthenticationError);
    expect(called).toBe(false);
  });
});

describe("JWKS handling (Techlead F1/F2)", () => {
  /** A second signing key, as an IdP mid-rotation would publish. */
  function secondKey() {
    const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    return {
      privateKey: pair.privateKey,
      jwk: { ...pair.publicKey.export({ format: "jwk" }), alg: "RS256", use: "sig" },
    };
  }

  test("F2: two published keys with NO kid — a token signed by the SECOND is accepted", async () => {
    // Normal state during key rotation: providers may publish several keys and
    // omit kid entirely. Picking the first match and giving up would turn every
    // rotation into an outage, and the failure would read as "bad signature".
    const second = secondKey();
    const bare = { ...publicJwk };
    delete bare.kid;

    const token = JWT.sign(
      {
        sub: "rotated",
        email: "rotated@example.com",
        email_verified: true,
        nonce: "the-expected-nonce",
      },
      second.privateKey,
      { algorithm: "RS256", issuer: ISSUER, audience: CLIENT_ID, expiresIn: "5m" }
    );

    const provider = new OidcIdentityProvider({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      clientSecret: "shhh",
      fetchImpl: fakeFetch({ token, keys: [bare, second.jwk] }),
    });

    const principal = await provider.completeLogin({
      redirectUri: REDIRECT_URI,
      callbackParams: { code: "auth-code" },
      codeVerifier: "verifier-abc",
      expectedNonce: "the-expected-nonce",
    });
    expect(principal.subject).toBe("rotated");
  });

  test("F2b: a token signed by a key that is NOT published still fails", async () => {
    // Trying every candidate must not become "accept anything": the candidates
    // are only ever the issuer's own published keys.
    const outsider = secondKey();
    const bare = { ...publicJwk };
    delete bare.kid;
    const token = JWT.sign(
      { sub: "x", email: "x@example.com", email_verified: true, nonce: "the-expected-nonce" },
      outsider.privateKey,
      { algorithm: "RS256", issuer: ISSUER, audience: CLIENT_ID, expiresIn: "5m" }
    );
    const provider = new OidcIdentityProvider({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      clientSecret: "shhh",
      fetchImpl: fakeFetch({ token, keys: [bare] }),
    });
    await expect(
      provider.completeLogin({
        redirectUri: REDIRECT_URI,
        callbackParams: { code: "auth-code" },
        codeVerifier: "verifier-abc",
        expectedNonce: "the-expected-nonce",
      })
    ).rejects.toThrow(IdentityAuthenticationError);
  });

  test("F1: two consecutive logins fetch the JWKS once", async () => {
    // Without a cache every login — including ones driven by junk tokens — is a
    // round trip to the IdP, which makes the login path only as available as
    // the provider and turns garbage traffic into amplified load on it.
    const counter = { jwks: 0 };
    const provider = new OidcIdentityProvider({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      clientSecret: "shhh",
      fetchImpl: fakeFetch({ token: idToken(), counter }),
    });
    const input = {
      redirectUri: REDIRECT_URI,
      callbackParams: { code: "auth-code" },
      codeVerifier: "verifier-abc",
      expectedNonce: "the-expected-nonce",
    };
    await provider.completeLogin(input);
    await provider.completeLogin(input);
    expect(counter.jwks).toBe(1);
  });

  test("F1b: an unknown kid triggers exactly ONE refetch, and then verifies", async () => {
    // The cache must not become a way to lock out a rotated key — but a token
    // carrying a random kid must not buy an unbounded number of fetches either.
    const counter = { jwks: 0 };
    const rotated = secondKey();
    rotated.jwk.kid = "rotated-key";
    let published = [publicJwk];

    const provider = new OidcIdentityProvider({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      clientSecret: "shhh",
      fetchImpl: fakeFetch({
        token: idToken(),
        counter,
        keys: () => published,
      }),
    });

    // Warm the cache with the original key.
    await provider.completeLogin({
      redirectUri: REDIRECT_URI,
      callbackParams: { code: "auth-code" },
      codeVerifier: "verifier-abc",
      expectedNonce: "the-expected-nonce",
    });
    expect(counter.jwks).toBe(1);

    // The IdP rotates; the next token carries a kid the cache has never seen.
    published = [rotated.jwk];
    const rotatedToken = JWT.sign(
      {
        sub: "after-rotation",
        email: "after@example.com",
        email_verified: true,
        nonce: "the-expected-nonce",
      },
      rotated.privateKey,
      { algorithm: "RS256", keyid: "rotated-key", issuer: ISSUER, audience: CLIENT_ID, expiresIn: "5m" }
    );
    const rotatedProvider = new OidcIdentityProvider({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      clientSecret: "shhh",
      fetchImpl: fakeFetch({ token: rotatedToken, counter, keys: () => published }),
    });
    rotatedProvider._jwksCache = provider._jwksCache;
    const before = counter.jwks;
    const principal = await rotatedProvider.completeLogin({
      redirectUri: REDIRECT_URI,
      callbackParams: { code: "auth-code" },
      codeVerifier: "verifier-abc",
      expectedNonce: "the-expected-nonce",
    });
    expect(principal.subject).toBe("after-rotation");
    expect(counter.jwks - before).toBe(1);
  });

  test("F1c: an unknown kid that is STILL unknown after refetch does not fetch again", async () => {
    const counter = { jwks: 0 };
    const outsider = secondKey();
    const token = JWT.sign(
      { sub: "x", email: "x@example.com", email_verified: true, nonce: "the-expected-nonce" },
      outsider.privateKey,
      { algorithm: "RS256", keyid: "never-published", issuer: ISSUER, audience: CLIENT_ID, expiresIn: "5m" }
    );
    const provider = new OidcIdentityProvider({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      clientSecret: "shhh",
      fetchImpl: fakeFetch({ token, counter }),
    });
    await expect(
      provider.completeLogin({
        redirectUri: REDIRECT_URI,
        callbackParams: { code: "auth-code" },
        codeVerifier: "verifier-abc",
        expectedNonce: "the-expected-nonce",
      })
    ).rejects.toThrow(IdentityAuthenticationError);
    // One fetch to populate, at most one refetch for the unknown kid. A token
    // with a random kid must not be a free DoS lever against the IdP.
    expect(counter.jwks).toBeLessThanOrEqual(2);
  });
});
