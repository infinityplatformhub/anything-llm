const BRAND_HOMEPAGE =
  process.env.BRAND_HOMEPAGE_URL ||
  "https://github.com/infinityplatformhub/anything-llm";
const BRAND_DOCS_URL = process.env.BRAND_DOCS_URL || BRAND_HOMEPAGE;
const BRAND_CDN =
  process.env.BRAND_CDN_URL || "https://cdn.anythingllm.com/support/models/";

module.exports = { BRAND_HOMEPAGE, BRAND_DOCS_URL, BRAND_CDN };
