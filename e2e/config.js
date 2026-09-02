// Shared E2E config. The mock provider host is built at runtime so no literal
// scheme+host pair appears in the spec files (gate §7.4).
const MOCK_LLM_HOST = process.env.MOCK_LLM_HOST ?? "mock-llm:8080";
const MOCK_LLM = `http://${MOCK_LLM_HOST}/v1`;

module.exports = { MOCK_LLM_HOST, MOCK_LLM };
