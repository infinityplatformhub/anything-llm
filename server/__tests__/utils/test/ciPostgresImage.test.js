/**
 * #146 — CI's postgres service must be an image that ships pgvector.
 *
 * The workflow is not covered by any suite: it is YAML that only GitHub executes, so
 * a change to it is invisible to every test in this repo and a revert to
 * `postgres:16` would be caught by nobody. That is exactly the shape #142 closed for
 * hook timeouts — a property nothing witnesses gets deleted by a later reader as an
 * unnecessary detail.
 *
 * Asserted as "the image is one that ships pgvector", not as an exact string: the tag
 * will move (pg16 → pg17) and pinning the literal would fail on a correct upgrade,
 * which is how a guard earns its removal.
 */

const fs = require("fs");
const path = require("path");

const WORKFLOW = path.resolve(__dirname, "../../../../.github/workflows/ci.yml");

describe("#146: the CI postgres service ships pgvector", () => {
  test("the image is a pgvector-bearing one, not stock postgres", () => {
    const source = fs.readFileSync(WORKFLOW, "utf8");
    // The postgres SERVICE's image line specifically — the file also names chroma,
    // qdrant, weaviate and milvus images, and matching any `image:` would pass on
    // one of those.
    const service = source.match(
      /postgres:\s*\n\s*image:\s*(\S+)/
    );
    expect(service).not.toBeNull();
    const image = service[1];
    // `pgvector/pgvector:pg16` today. A stock `postgres:16` does not carry the
    // extension, and the failure it produces is remote-only: green locally for every
    // developer whose container has it, red in CI alone.
    expect(image).toMatch(/pgvector/);
  });
});
