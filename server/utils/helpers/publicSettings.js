/**
 * #114: what `GET /setup-complete` may say to a caller who has not authenticated.
 *
 * The route answered all of `currentSettings()` to anyone. Credentials were already
 * booleanised — no API key ever left it — but every endpoint, base path and connection
 * string went out raw, which on a self-hosted install is the shape of the operator's
 * private network.
 *
 * Three branches, because the route serves three genuinely different callers:
 *
 *   1. unauthenticated, on an instance that has users — the login screen, which needs
 *      six fields to decide what to render.
 *   2. pre-user, before anyone has signed up — the onboarding form, which mounts 37
 *      provider components reading ~128 fields. It needs the KEYS; on a fresh install
 *      every endpoint among them is unset anyway.
 *   3. authenticated — eight admin settings pages read ~200 fields off this response,
 *      so it is unchanged.
 */
const {
  validatedRequest,
} = require("../middleware/validatedRequest");

/**
 * The six a browser needs before it can show a login screen: whether auth is required,
 * which mode the instance is in, and how SSO should be offered.
 */
const PUBLIC_SETTING_FIELDS = Object.freeze([
  "MultiUserMode",
  "RequiresAuth",
  "SSOProviders",
  "SimpleSSOEnabled",
  "SimpleSSONoLogin",
  "SimpleSSONoLoginRedirect",
]);

/**
 * Fields emptied in the pre-user branch.
 *
 * Written out rather than derived from a name pattern. A rule like
 * `/BasePath$|Endpoint$/` applied to the same object it is checked against can never
 * fail: adding `FooBasePath` would make the rule match it and the assertion agree, and
 * nobody would have decided anything. The list is the decision; the drift test compares
 * it against the pattern so a new field fails loudly instead of being masked silently.
 *
 * `StorageDir` is here despite carrying no endpoint suffix: it is a filesystem path on
 * the host, which is the same class of disclosure by a different spelling.
 */
const MASKED_ENDPOINT_FIELDS = Object.freeze([
  "AgentCrwApiUrl",
  "AgentSearXNGApiUrl",
  "AstraDBEndpoint",
  "AzureOpenAiEndpoint",
  "ChromaEndpoint",
  "EmbeddingBasePath",
  "FoundryBasePath",
  "GenericOpenAiBasePath",
  "ImageGenerationLemonadeBasePath",
  "ImageGenerationLocalAiBasePath",
  "ImageGenerationOllamaBasePath",
  "KoboldCPPBasePath",
  "LMStudioBasePath",
  "LemonadeLLMBasePath",
  "LiteLLMBasePath",
  "LlmmanBasePath",
  "LocalAiBasePath",
  "MilvusAddress",
  "NvidiaNimLLMBasePath",
  "OMLXLLMBasePath",
  "OllamaLLMBasePath",
  "PGVectorConnectionString",
  "PrivateModeBasePath",
  "QdrantEndpoint",
  "STTLemonadeBasePath",
  "STTOpenAICompatibleEndpoint",
  "StorageDir",
  "TTSKokoroEndpoint",
  "TTSOpenAICompatibleEndpoint",
  "TextGenWebUIBasePath",
  "WeaviateEndpoint",
  "WhisperGenericOpenAiBaseUrl",
  "ZillizEndpoint",
]);

/**
 * The settings a caller may see, given who they are.
 *
 * @param {object} settings the full `currentSettings()` result
 * @param {{authenticated: boolean, preUser: boolean}} caller
 * @returns {object}
 */
function publicSettingsFor(settings, { authenticated, preUser }) {
  if (authenticated) return settings;

  if (!preUser) {
    const narrowed = Object.create(null);
    for (const field of PUBLIC_SETTING_FIELDS) narrowed[field] = settings[field];
    return narrowed;
  }

  // Pre-user: every key, endpoints emptied.
  //
  // The empty STRING matters. Onboarding renders these into controlled inputs, and
  // `JSON.stringify` drops an `undefined` value — so a field that arrives as undefined
  // on one render and a string on the next makes React switch the input from controlled
  // to uncontrolled and warn. "" is a value the form can hold from the first render.
  const masked = { ...settings };
  for (const field of MASKED_ENDPOINT_FIELDS) masked[field] = "";
  return masked;
}

/**
 * Does this request carry a session `validatedRequest` would accept?
 *
 * `validatedRequest` is RUN rather than reimplemented. Writing a second "is this caller
 * authenticated" check is how the two answers drift apart — the same hazard that
 * middleware's own comment describes about single-user mode, where one call site read
 * the setting and another read the rows. There would be nothing to keep a local copy in
 * step with the passthrough branches, the encrypted-`p` format, or the next change to
 * any of it.
 *
 * It is invoked with a response stand-in that swallows what it writes, because here a
 * refusal is an ANSWER — "no session, narrow the body" — not a status to send. The real
 * response is written by the route afterwards either way.
 *
 * @param {import("express").Request} request
 * @returns {Promise<boolean>}
 */
function callerHasSession(request) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    // Only the members `validatedRequest` touches on a refusal path. Each returns the
    // stub so the `.status(...).json(...)` chain works; none of it reaches the socket.
    const sink = {
      locals: {},
      status() {
        return sink;
      },
      json() {
        finish(false);
        return sink;
      },
      send() {
        finish(false);
        return sink;
      },
      sendStatus() {
        finish(false);
        return sink;
      },
      end() {
        finish(false);
        return sink;
      },
      setHeader() {
        return sink;
      },
    };
    Promise.resolve(validatedRequest(request, sink, () => finish(true)))
      // A throw is not a session. Resolving false rather than rejecting keeps the route
      // answering the public body instead of 500-ing on a malformed token.
      .then(() => finish(false))
      .catch(() => finish(false));
  });
}

module.exports = {
  PUBLIC_SETTING_FIELDS,
  MASKED_ENDPOINT_FIELDS,
  publicSettingsFor,
  callerHasSession,
};
