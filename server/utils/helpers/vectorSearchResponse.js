// The `/v1/workspace/:slug/vector-search` response body — ONE shape for every outcome.
//
// #30 slice 3 follow-up (Techlead-1 NIT-3): this lived in `utils/authorization/` because
// the bug it fixes is a security bug, but the function itself makes no authorization
// decision — it maps sources to a response body. Keeping it under `authorization/` would
// teach the next reader that this directory holds response formatting, and the next
// formatter would land there too.
//
// What it fixes, kept here because the shape is the whole point: the route used to
// early-return `{results: [], message: "No embeddings found for this workspace."}` when
// `namespaceCount === 0`, while an ACL-filtered search that matched nothing returned
// `{results: []}`. A caller could therefore distinguish "this workspace holds content you
// may not read" from "this workspace is empty" — an existence oracle over workspace
// content, the same class as #32's mint oracle.
//
// So: no `message` key in any case. Byte-identical, not merely similar — the assertion in
// the test is on the serialized body, because comparing parsed fields lets a stray key
// through and a stray key WAS the bug.

/**
 * @param {{sources?: Object[]}} input
 * @returns {{results: Object[]}}
 */
function buildVectorSearchResponse({ sources = [] } = {}) {
  return {
    results: sources.map((source) => ({
      id: source.id,
      text: source.text,
      metadata: {
        url: source.url,
        title: source.title,
        author: source.docAuthor,
        description: source.description,
        docSource: source.docSource,
        chunkSource: source.chunkSource,
        published: source.published,
        wordCount: source.wordCount,
        tokenCount: source.token_count_estimate,
      },
      // `_distance`, matching the route this was extracted from. Writing `score` here
      // instead would be a silent behaviour change smuggled in under a security fix — the
      // field is undefined on providers that do not set it, and callers read it.
      distance: source._distance,
      score: source.score,
    })),
  };
}

module.exports = { buildVectorSearchResponse };
