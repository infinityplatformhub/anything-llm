const { default: weaviate } = require("weaviate-ts-client");
const { TextSplitter } = require("../../TextSplitter");
const { SystemSettings } = require("../../../models/systemSettings");
const { storeVectorResult, cachedVectorInformation } = require("../../files");
const { v4: uuidv4 } = require("uuid");
const { toChunks, getEmbeddingEngineSelection } = require("../../helpers");
const { camelCase } = require("../../helpers/camelcase");
const { sourceIdentifier } = require("../../chats");
const { VectorDatabase } = require("../base");
const {
  assertFilter,
  constraintFor,
  isRowAllowed,
} = require("../../authorization/vectorPredicate");
const {
  aclMetadataForNamespace,
} = require("../../authorization/vectorAclMetadata");

/**
 * The class configuration a Weaviate class needs before the ACL filter can work on it.
 *
 * TWO things, both required, both only settable AT CREATION (measured on Weaviate
 * 1.24.10):
 *
 *   1. The ACL properties must be DECLARED. Weaviate infers a class schema from the first
 *      object written to it, so a class whose first document predates T-5 has no `orgId`
 *      property at all — and a `where` naming it fails with
 *      "no such prop with name 'orgId' found in class".
 *   2. `invertedIndexConfig.indexNullState` must be true, or an `IsNull` filter fails with
 *      "Nullstate must be indexed to be filterable".
 *
 * Neither can be added later. `PUT /v1/schema/<class>` rejects the change outright:
 *
 *   422 "inverted index config: IndexNullState cannot be changed when updating a schema"
 *
 * so an existing class cannot be upgraded in place — it has to be dropped and re-embedded.
 * That is why `hasAclSchema` exists on the read side rather than a migration here: classes
 * created from now on work, and older ones are reported rather than silently mishandled.
 */
const ACL_CLASS_PROPERTIES = Object.freeze([
  "orgId",
  "workspaceId",
  "docId",
]);

function aclClassConfig() {
  return {
    properties: ACL_CLASS_PROPERTIES.map((name) => ({
      name,
      dataType: ["text"],
      // `field` = match the WHOLE value; the default (`word`) splits on punctuation.
      //
      // Measured on 1.24.10 with a deny-list of "doc-bad" over three documents
      // (doc-bad, doc-good, and a UUID):
      //
      //   tokenization word   NotEqual "doc-bad" -> UUID only
      //   tokenization field  NotEqual "doc-bad" -> UUID and doc-good
      //
      // Under `word` the value becomes the tokens [doc, bad], so NotEqual excludes
      // everything sharing the token `doc` — it drops doc-good as well. The deny-list
      // over-denies, silently: the denied document is excluded (correct) and so are
      // unrelated documents that happen to share a word (a retrieval outage that looks
      // like poor recall).
      //
      // Today's ids are UUIDs with no shared tokens, so nothing visibly breaks. Any id
      // scheme with a common prefix — "invoice-2024-01", "hr-policy-3" — breaks it, and
      // the failure appears at that customer only.
      tokenization: "field",
    })),
    invertedIndexConfig: { indexNullState: true },
  };
}

/**
 * Can this Weaviate class support the unprovable-rows escape clause?
 *
 * Both halves are required and both are fixed at creation:
 *   - the ACL properties are declared (a class whose first object predated T-5 has none,
 *     and `where` on an undeclared prop fails with "no such prop with name 'orgId'")
 *   - `invertedIndexConfig.indexNullState` is true (or `IsNull` fails with
 *     "Nullstate must be indexed to be filterable")
 *
 * Returns false when the class cannot be inspected. That is the safe direction here: a
 * false negative keeps the strict predicate, which works on every class; a false positive
 * emits an `IsNull` the class cannot answer and fails the whole query.
 *
 * @param {Object|null} weaviateClass the class definition from the schema
 */
function hasAclSchema(weaviateClass) {
  if (!weaviateClass) return false;
  // Tokenization is checked, not just presence. A class whose docId is tokenized `word`
  // (auto-schema's default) answers a NotEqual deny-list by excluding every document
  // sharing a token, so the filter is wrong in a way that returns FEWER rows — a silent
  // over-deny that looks like poor recall rather than a fault. Such a class is treated as
  // not ACL-ready, like one missing the properties outright.
  const declared = new Map(
    (weaviateClass.properties ?? []).map((prop) => [prop.name, prop])
  );
  const propsReady = ACL_CLASS_PROPERTIES.every(
    (name) => declared.get(name)?.tokenization === "field"
  );
  return (
    propsReady && weaviateClass.invertedIndexConfig?.indexNullState === true
  );
}

class Weaviate extends VectorDatabase {
  constructor() {
    super();
  }

  get name() {
    return "Weaviate";
  }

  async connect() {
    if (process.env.VECTOR_DB !== "weaviate")
      throw new Error("Weaviate::Invalid ENV settings");

    const weaviateUrl = new URL(process.env.WEAVIATE_ENDPOINT);
    const options = {
      scheme: weaviateUrl.protocol?.replace(":", "") || "http",
      host: weaviateUrl?.host,
      ...(process.env?.WEAVIATE_API_KEY?.length > 0
        ? { apiKey: new weaviate.ApiKey(process.env?.WEAVIATE_API_KEY) }
        : {}),
    };
    const client = weaviate.client(options);
    const isAlive = await await client.misc.liveChecker().do();
    if (!isAlive)
      throw new Error(
        "Weaviate::Invalid Alive signal received - is the service online?"
      );
    return { client };
  }

  async heartbeat() {
    await this.connect();
    return { heartbeat: Number(new Date()) };
  }

  async totalVectors() {
    const { client } = await this.connect();
    const collectionNames = await this.allNamespaces(client);
    var totalVectors = 0;
    for (const name of collectionNames) {
      totalVectors += await this.namespaceCountWithClient(client, name);
    }
    return totalVectors;
  }

  async namespaceCountWithClient(client, namespace) {
    try {
      const response = await client.graphql
        .aggregate()
        .withClassName(camelCase(namespace))
        .withFields("meta { count }")
        .do();
      return (
        response?.data?.Aggregate?.[camelCase(namespace)]?.[0]?.meta?.count || 0
      );
    } catch (e) {
      this.logger(`namespaceCountWithClient`, e.message);
      return 0;
    }
  }

  async namespaceCount(namespace = null) {
    try {
      const { client } = await this.connect();
      const response = await client.graphql
        .aggregate()
        .withClassName(camelCase(namespace))
        .withFields("meta { count }")
        .do();

      return (
        response?.data?.Aggregate?.[camelCase(namespace)]?.[0]?.meta?.count || 0
      );
    } catch (e) {
      this.logger(`namespaceCountWithClient`, e.message);
      return 0;
    }
  }

  /**
   * ACL-filtered search. See base.queryAuthorized for the contract.
   *
   * The predicate goes into `.withWhere()`, applied inside the GraphQL query before the
   * limit, so the actor's own documents compete for the topN slots (S-17).
   *
   * Weaviate's operator enum is closed and has no `Not`, so the deny-list is rendered as a
   * conjunction of NotEqual clauses rather than a negated ContainsAny — see
   * `toWeaviateWhere`. It does have `IsNull`, so the pre-backfill escape clause IS
   * expressible here.
   */
  async queryAuthorized({
    namespace = null,
    queryVector = null,
    aclFilter = null,
    similarityThreshold = 0.25,
    topN = 4,
    filterIdentifiers = [],
  }) {
    assertFilter(aclFilter);
    const empty = { contextTexts: [], sourceDocuments: [], scores: [] };

    const { client } = await this.connect();
    if (!(await this.namespaceExists(client, namespace))) return empty;

    const weaviateClass = await this.namespace(client, namespace);

    // A class created before T-5 declares no ACL properties, because Weaviate infers a
    // class schema from the first object written to it. On such a class NO ACL predicate
    // is expressible at all — measured on 1.24.10, even the strict one fails:
    //
    //   IsNull orgId        -> "Nullstate must be indexed to be filterable"
    //   Equal  orgId '1'    -> "no such prop with name 'orgId' found in class"
    //
    // and neither the properties nor `indexNullState` can be added afterwards
    // (422 "IndexNullState cannot be changed when updating a schema").
    //
    // So the choice is not strict-versus-lenient, it is FILTER OR DO NOT QUERY. The class
    // is refused in both flag states, the same answer Lance gives for a table that
    // predates the ACL columns.
    //
    // Dropping the `where` and serving the class was rejected: the entire predicate lives
    // in that one clause, so removing it returns every object with no ACL — not the
    // unlabelled ones, all of them. That is a hole rather than a rollout accommodation.
    //
    // Announced at boot by retrievalSupport, naming the class, because it cannot be fixed
    // in place — the class has to be recreated and re-embedded (#56).
    if (!hasAclSchema(weaviateClass)) {
      this.logger(
        `class "${camelCase(namespace)}" predates the ACL metadata (no orgId/workspaceId/docId properties, indexNullState off) and Weaviate cannot add either to an existing class. No ACL predicate can be expressed against it, so its vectors are EXCLUDED in both states of RETRIEVAL_FILTER_ALLOW_UNPROVABLE. Recreating the class and re-embedding its documents is the only fix.`
      );
      return empty;
    }

    const where = constraintFor(aclFilter).toWeaviateWhere();
    if (where === null) return empty;
    const fields =
      weaviateClass.properties?.map((prop) => prop.name)?.join(" ") ?? "";
    const queryResponse = await client.graphql
      .get()
      .withClassName(camelCase(namespace))
      .withFields(`${fields} _additional { id certainty }`)
      .withNearVector({ vector: queryVector })
      .withWhere(where)
      .withLimit(topN)
      .do();

    const result = { contextTexts: [], sourceDocuments: [], scores: [] };
    const responses = queryResponse?.data?.Get?.[camelCase(namespace)] ?? [];
    for (const response of responses) {
      const {
        _additional: { id, certainty },
        ...rest
      } = response;
      // Second layer, deliberately redundant with the pushdown (S-26/G4).
      if (!isRowAllowed(rest, aclFilter)) continue;
      if (certainty < similarityThreshold) continue;
      if (filterIdentifiers.includes(sourceIdentifier(rest))) {
        this.logger(
          "A source was filtered from context as it's parent document is pinned."
        );
        continue;
      }
      result.contextTexts.push(rest.text);
      result.sourceDocuments.push({ ...rest, id, score: certainty });
      result.scores.push(certainty);
    }
    return result;
  }

  async similarityResponse({
    client,
    namespace,
    queryVector,
    similarityThreshold = 0.25,
    topN = 4,
    filterIdentifiers = [],
  }) {
    const result = {
      contextTexts: [],
      sourceDocuments: [],
      scores: [],
    };

    const weaviateClass = await this.namespace(client, namespace);
    const fields =
      weaviateClass.properties?.map((prop) => prop.name)?.join(" ") ?? "";
    const queryResponse = await client.graphql
      .get()
      .withClassName(camelCase(namespace))
      .withFields(`${fields} _additional { id certainty }`)
      .withNearVector({ vector: queryVector })
      .withLimit(topN)
      .do();

    const responses = queryResponse?.data?.Get?.[camelCase(namespace)];
    responses.forEach((response) => {
      // In Weaviate we have to pluck id from _additional and spread it into the rest
      // of the properties.
      const {
        _additional: { id, certainty },
        ...rest
      } = response;
      if (certainty < similarityThreshold) return;
      if (filterIdentifiers.includes(sourceIdentifier(rest))) {
        this.logger(
          "A source was filtered from context as it's parent document is pinned."
        );
        return;
      }
      result.contextTexts.push(rest.text);
      result.sourceDocuments.push({ ...rest, id, score: certainty });
      result.scores.push(certainty);
    });

    return result;
  }

  async allNamespaces(client) {
    try {
      const { classes = [] } = await client.schema.getter().do();
      return classes.map((classObj) => classObj.class);
    } catch (e) {
      this.logger("AllNamespace", e);
      return [];
    }
  }

  async namespace(client, namespace = null) {
    if (!namespace) throw new Error("No namespace value provided.");
    if (!(await this.namespaceExists(client, namespace))) return null;

    const weaviateClass = await client.schema
      .classGetter()
      .withClassName(camelCase(namespace))
      .do();

    return {
      ...weaviateClass,
      vectorCount: await this.namespaceCount(namespace),
    };
  }

  async addVectors(client, vectors = []) {
    const response = { success: true, errors: new Set([]) };
    const results = await client.batch
      .objectsBatcher()
      .withObjects(...vectors)
      .do();

    results.forEach((res) => {
      const { status, errors = [] } = res.result;
      if (status === "SUCCESS" || errors.length === 0) return;
      response.success = false;
      response.errors.add(errors.error?.[0]?.message || null);
    });

    response.errors = [...response.errors];
    return response;
  }

  async hasNamespace(namespace = null) {
    if (!namespace) return false;
    const { client } = await this.connect();
    const weaviateClasses = await this.allNamespaces(client);
    return weaviateClasses.includes(camelCase(namespace));
  }

  async namespaceExists(client, namespace = null) {
    if (!namespace) throw new Error("No namespace value provided.");
    const weaviateClasses = await this.allNamespaces(client);
    return weaviateClasses.includes(camelCase(namespace));
  }

  async deleteVectorsInNamespace(client, namespace = null) {
    await client.schema.classDeleter().withClassName(camelCase(namespace)).do();
    return true;
  }

  async addDocumentToNamespace(
    namespace,
    documentData = {},
    fullFilePath = null,
    skipCache = false
  ) {
    const { DocumentVectors } = require("../../../models/vectors");
    try {
      const {
        pageContent,
        docId,
        id: _id, // Weaviate will abort if `id` is present in properties
        ...metadata
      } = documentData;
      if (!pageContent || pageContent.length == 0) return false;

      // The ACL fields the filter reads. Resolved once and spread into every stored
      // object below, including the cached path — a cache hit must not be a hole.
      const aclMetadata =
        (await aclMetadataForNamespace({ namespace, docId })) ?? {};

      this.logger("Adding new vectorized document into namespace", namespace);
      if (!skipCache) {
        const cacheResult = await cachedVectorInformation(fullFilePath);
        if (cacheResult.exists) {
          const { client } = await this.connect();
          const weaviateClassExits = await this.hasNamespace(namespace);
          if (!weaviateClassExits) {
            await client.schema
              .classCreator()
              .withClass({
                class: camelCase(namespace),
                description: `Class created by ApproofWorkspace named ${camelCase(
                  namespace
                )}`,
                vectorizer: "none",
                ...aclClassConfig(),
              })
              .do();
          }

          const { chunks } = cacheResult;
          const documentVectors = [];
          const vectors = [];

          for (const chunk of chunks) {
            // Before sending to Weaviate and saving the records to our db
            // we need to assign the id of each chunk that is stored in the cached file.
            chunk.forEach((chunk) => {
              const id = uuidv4();
              const flattenedMetadata = this.flattenObjectForWeaviate(
                chunk.properties ?? chunk.metadata
              );
              documentVectors.push({ docId, vectorId: id });
              const vectorRecord = {
                id,
                class: camelCase(namespace),
                vector: chunk.vector || chunk.values || [],
                properties: { ...flattenedMetadata, ...aclMetadata },
              };
              vectors.push(vectorRecord);
            });

            const { success: additionResult, errors = [] } =
              await this.addVectors(client, vectors);
            if (!additionResult) {
              this.logger("addVectors failed to insert", errors);
              throw new Error("Error embedding into Weaviate");
            }
          }

          await DocumentVectors.bulkInsert(documentVectors);
          return { vectorized: true, error: null };
        }
      }

      // If we are here then we are going to embed and store a novel document.
      // We have to do this manually as opposed to using LangChains `Chroma.fromDocuments`
      // because we then cannot atomically control our namespace to granularly find/remove documents
      // from vectordb.
      const EmbedderEngine = getEmbeddingEngineSelection();
      const textSplitter = new TextSplitter({
        chunkSize: TextSplitter.determineMaxChunkSize(
          await SystemSettings.getValueOrFallback({
            label: "text_splitter_chunk_size",
          }),
          EmbedderEngine?.embeddingMaxChunkLength
        ),
        chunkOverlap: await SystemSettings.getValueOrFallback(
          { label: "text_splitter_chunk_overlap" },
          20
        ),
        chunkHeaderMeta: TextSplitter.buildHeaderMeta(metadata),
        chunkPrefix: EmbedderEngine?.embeddingPrefix,
      });
      const textChunks = await textSplitter.splitText(pageContent);

      this.logger("Snippets created from document:", textChunks.length);
      const documentVectors = [];
      const vectors = [];
      const vectorValues = await EmbedderEngine.embedChunks(textChunks);
      const submission = {
        ids: [],
        vectors: [],
        properties: [],
      };

      if (!!vectorValues && vectorValues.length > 0) {
        for (const [i, vector] of vectorValues.entries()) {
          const flattenedMetadata = this.flattenObjectForWeaviate(metadata);
          const vectorRecord = {
            class: camelCase(namespace),
            id: uuidv4(),
            vector: vector,
            // [DO NOT REMOVE]
            // LangChain will be unable to find your text if you embed manually and dont include the `text` key.
            // https://github.com/hwchase17/langchainjs/blob/5485c4af50c063e257ad54f4393fa79e0aff6462/langchain/src/vectorstores/weaviate.ts#L133
            properties: {
              ...flattenedMetadata,
              text: textChunks[i],
              ...aclMetadata,
            },
          };

          submission.ids.push(vectorRecord.id);
          submission.vectors.push(vectorRecord.values);
          submission.properties.push(metadata);

          vectors.push(vectorRecord);
          documentVectors.push({ docId, vectorId: vectorRecord.id });
        }
      } else {
        throw new Error(
          "Could not embed document chunks! This document will not be recorded."
        );
      }

      const { client } = await this.connect();
      const weaviateClassExits = await this.hasNamespace(namespace);
      if (!weaviateClassExits) {
        await client.schema
          .classCreator()
          .withClass({
            class: camelCase(namespace),
            description: `Class created by ApproofWorkspace named ${camelCase(
              namespace
            )}`,
            vectorizer: "none",
            ...aclClassConfig(),
          })
          .do();
      }

      if (vectors.length > 0) {
        const chunks = [];
        for (const chunk of toChunks(vectors, 500)) chunks.push(chunk);

        this.logger("Inserting vectorized chunks into Weaviate collection.");
        const { success: additionResult, errors = [] } = await this.addVectors(
          client,
          vectors
        );
        if (!additionResult) {
          this.logger("addVectors failed to insert", errors);
          throw new Error("Error embedding into Weaviate");
        }
        await storeVectorResult(chunks, fullFilePath);
      }

      await DocumentVectors.bulkInsert(documentVectors);
      return { vectorized: true, error: null };
    } catch (e) {
      this.logger("addDocumentToNamespace", e.message);
      return { vectorized: false, error: e.message };
    }
  }

  async deleteDocumentFromNamespace(namespace, docId) {
    const { DocumentVectors } = require("../../../models/vectors");
    const { client } = await this.connect();
    if (!(await this.namespaceExists(client, namespace))) return;

    const knownDocuments = await DocumentVectors.forDocument(docId);
    if (knownDocuments.length === 0) return;

    for (const doc of knownDocuments) {
      await client.data
        .deleter()
        .withClassName(camelCase(namespace))
        .withId(doc.vectorId)
        .do();
    }

    const indexes = knownDocuments.map((doc) => doc.id);
    await DocumentVectors.deleteIds(indexes);
    return true;
  }

  async performSimilaritySearch({
    namespace = null,
    input = "",
    LLMConnector = null,
    similarityThreshold = 0.25,
    topN = 4,
    filterIdentifiers = [],
  }) {
    if (!namespace || !input || !LLMConnector)
      throw new Error("Invalid request to performSimilaritySearch.");

    const { client } = await this.connect();
    if (!(await this.namespaceExists(client, namespace))) {
      return {
        contextTexts: [],
        sources: [],
        message: "Invalid query - no documents found for workspace!",
      };
    }

    const queryVector = await LLMConnector.embedTextInput(input);
    const { contextTexts, sourceDocuments } = await this.similarityResponse({
      client,
      namespace,
      queryVector,
      similarityThreshold,
      topN,
      filterIdentifiers,
    });

    const sources = sourceDocuments.map((metadata, i) => {
      return { ...metadata, text: contextTexts[i] };
    });
    return {
      contextTexts,
      sources: this.curateSources(sources),
      message: false,
    };
  }

  async "namespace-stats"(reqBody = {}) {
    const { namespace = null } = reqBody;
    if (!namespace) throw new Error("namespace required");
    const { client } = await this.connect();
    const stats = await this.namespace(client, namespace);
    return stats
      ? stats
      : { message: "No stats were able to be fetched from DB for namespace" };
  }

  async "delete-namespace"(reqBody = {}) {
    const { namespace = null } = reqBody;
    const { client } = await this.connect();
    const details = await this.namespace(client, namespace);
    await this.deleteVectorsInNamespace(client, namespace);
    return {
      message: `Namespace ${camelCase(namespace)} was deleted along with ${
        details?.vectorCount
      } vectors.`,
    };
  }

  async reset() {
    const { client } = await this.connect();
    const weaviateClasses = await this.allNamespaces(client);
    for (const weaviateClass of weaviateClasses) {
      await client.schema.classDeleter().withClassName(weaviateClass).do();
    }
    return { reset: true };
  }

  curateSources(sources = []) {
    const documents = [];
    for (const source of sources) {
      if (Object.keys(source).length > 0) {
        const metadata = source.hasOwnProperty("metadata")
          ? source.metadata
          : source;
        documents.push({ ...metadata });
      }
    }

    return documents;
  }

  flattenObjectForWeaviate(obj = {}) {
    // Note this function is not generic, it is designed specifically for Weaviate
    // https://weaviate.io/developers/weaviate/config-refs/datatypes#introduction
    // Credit to LangchainJS
    // https://github.com/hwchase17/langchainjs/blob/5485c4af50c063e257ad54f4393fa79e0aff6462/langchain/src/vectorstores/weaviate.ts#L11C1-L50C3
    const flattenedObject = {};

    for (const key in obj) {
      if (!Object.hasOwn(obj, key) || key === "id") {
        continue;
      }
      const value = obj[key];
      if (typeof obj[key] === "object" && !Array.isArray(value)) {
        const recursiveResult = this.flattenObjectForWeaviate(value);

        for (const deepKey in recursiveResult) {
          if (Object.hasOwn(obj, key)) {
            flattenedObject[`${key}_${deepKey}`] = recursiveResult[deepKey];
          }
        }
      } else if (Array.isArray(value)) {
        if (
          value.length > 0 &&
          typeof value[0] !== "object" &&
          value.every((el) => typeof el === typeof value[0])
        ) {
          // Weaviate only supports arrays of primitive types,
          // where all elements are of the same type
          flattenedObject[key] = value;
        }
      } else {
        flattenedObject[key] = value;
      }
    }

    return flattenedObject;
  }
}

module.exports.Weaviate = Weaviate;
// Exported for the boot report, which names the classes an operator must re-embed.
module.exports.hasAclSchema = hasAclSchema;
module.exports.aclClassConfig = aclClassConfig;
module.exports.ACL_CLASS_PROPERTIES = ACL_CLASS_PROPERTIES;
