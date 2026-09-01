export const BRAND_REPOSITORY_URL =
  import.meta.env.VITE_BRAND_REPOSITORY_URL ||
  "https://github.com/infinityplatformhub/anything-llm";

export const brandReleaseUrl = (version) =>
  `${BRAND_REPOSITORY_URL}/releases/tag/v${version}`;
