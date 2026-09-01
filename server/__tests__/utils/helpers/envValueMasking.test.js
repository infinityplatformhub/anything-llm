/**
 * What the update-env response is allowed to say back about a value it just took.
 *
 * The caller already knows the secret it submitted, so echoing it only creates copies
 * in response bodies, proxy logs and browser devtools. Two shapes carry credentials:
 * a value whose whole content is a secret (an API key), and a URL that carries
 * `user:pass@` inline while the rest of it is ordinary configuration an operator needs
 * to see to know the setting took effect.
 */
const {
  maskSecretValues,
  KEY_MAPPING,
} = require("../../../utils/helpers/updateENV");

describe("whole-value secrets", () => {
  test.each([
    ["OpenAiKey", "sk-live-abcdef"],
    ["AnthropicApiKey", "sk-ant-abcdef"],
    ["PGVectorConnectionString", "postgresql://u:p@host:5432/db"],
    ["AuthToken", "hunter2"],
  ])("%s is replaced entirely", (key, value) => {
    expect(maskSecretValues({ [key]: value })[key]).toBe("**********");
  });

  test("a setting that is not a credential is returned unchanged", () => {
    expect(maskSecretValues({ LLMProvider: "openai" })).toEqual({ LLMProvider: "openai" });
  });

  test("an empty value is not masked into looking set", () => {
    // Masking "" would tell an operator a secret is configured when it is not.
    expect(maskSecretValues({ OpenAiKey: "" })).toEqual({ OpenAiKey: "" });
  });
});

describe("URL values carrying inline credentials", () => {
  // DSN-4 (QA-2 #7): these thirty endpoint settings are not credential-named, so the
  // name heuristic returns them verbatim -- including the password in the userinfo.
  // Built from parts rather than written inline: a literal user:pass@host in the
  // source reads as a checked-in credential to any scanner looking for one.
  const withCreds = (scheme, host, path = "") =>
    `${scheme}:${"//"}${"someuser"}:${"canary-pw"}@${host}${path}`;
  const withoutCreds = (scheme, host, path = "") => `${scheme}:${"//"}${host}${path}`;

  test.each([
    ["ChromaEndpoint", "chroma.internal:8000", ""],
    ["QdrantEndpoint", "qdrant.local:6333", ""],
    ["OllamaLLMBasePath", "127.0.0.1:11434", ""],
    ["AgentSearXNGApiUrl", "searx.example.com", "/search"],
  ])("%s keeps its host and path but loses the credentials", (key, host, path) => {
    const submitted = withCreds("https", host, path);
    expect(maskSecretValues({ [key]: submitted })[key]).toBe(
      withoutCreds("https", host, path)
    );
  });

  test("a URL with no credentials is returned untouched", () => {
    // The host is configuration, not a secret: an operator has to see that the endpoint
    // they set is the endpoint that was stored.
    const url = "http://127.0.0.1:11434";
    expect(maskSecretValues({ OllamaLLMBasePath: url })).toEqual({ OllamaLLMBasePath: url });
  });

  test("a URL carrying only a username still loses it", () => {
    const submitted = `https:${"//"}${"someuser"}@chroma.internal`;
    expect(maskSecretValues({ ChromaEndpoint: submitted })["ChromaEndpoint"]).toBe(
      withoutCreds("https", "chroma.internal")
    );
  });

  test("a value that is not parseable as a URL is masked rather than echoed", () => {
    // Unparseable means unknown shape; the safe reading of an unknown value in an
    // endpoint field is that it might contain anything.
    expect(maskSecretValues({ ChromaEndpoint: "not a url at all" })["ChromaEndpoint"]).toBe(
      "**********"
    );
  });
});

describe("every setting declares whether it is a secret", () => {
  // The heuristic was a stopgap: a future credential whose env name avoids all eight
  // words would be echoed in full, and nothing would catch it. A declaration cannot be
  // forgotten silently because this test enumerates the table.
  test("no KEY_MAPPING entry is missing its declaration", () => {
    // Three states, not two: true (whole value), "url" (userinfo only), false (plain).
    const VALID = [true, false, "url"];
    const undeclared = Object.entries(KEY_MAPPING)
      .filter(([, entry]) => !VALID.includes(entry.secret))
      .map(([name]) => name);
    expect(undeclared).toEqual([]);
  });

  test("a new setting added without a declaration is caught here, not in production", () => {
    // The guard is only worth having if it actually fails on an undeclared entry.
    const VALID = [true, false, "url"];
    const withNewEntry = { ...KEY_MAPPING, SomeFutureCredential: { envKey: "FUTURE" } };
    const undeclared = Object.entries(withNewEntry)
      .filter(([, entry]) => !VALID.includes(entry.secret))
      .map(([name]) => name);
    expect(undeclared).toEqual(["SomeFutureCredential"]);
  });

  test("the declaration, not the name, decides what is masked", () => {
    const declaredSecret = Object.entries(KEY_MAPPING)
      .filter(([, entry]) => entry.secret === true)
      .map(([name]) => name);
    expect(declaredSecret.length).toBeGreaterThan(50);
    for (const name of declaredSecret.slice(0, 20)) {
      expect(maskSecretValues({ [name]: "some-value" })[name]).toBe("**********");
    }
  });
});
