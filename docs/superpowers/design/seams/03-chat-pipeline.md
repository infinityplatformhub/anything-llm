# Chat pipeline seam

## Responsibility

Run every conversational request through one ordered middleware chain, independent of ingress channel or model provider. Chain owns normalization, authorization, redaction, retrieval, guardrails, model routing, metering, persistence policy, and audit/event publication.

## Driver contract

```js
/** @typedef {{requestId:string, actor:Object, channel:string, workspaceId:string, prompt:string, attachments:Object[], mode:"persistent"|"temporary", metadata:Object}} ChatRequest */
/** @typedef {{status:"continue"|"stop", request:ChatRequest, response?:ChatResponse, state:Object}} ChatStageResult */
/** @typedef {{status:"continue"|"stop", chunk:string, reason?:string}} ChatChunkResult */
/** @typedef {{request:ChatRequest, state:Object, signal:AbortSignal, abort:(reason:string)=>void}} ChatContext */
/** @typedef {{requestId:string, text:string, citations:Object[], usage:Object, blocked:boolean}} ChatResponse */
/** @interface ChatMiddleware */
class ChatMiddleware {
  /** @returns {string} */
  static stageId() {}
  /** @param {ChatContext} context @returns {Promise<ChatStageResult>} */
  async handle(context) {}
  /** Called for every model chunk before delivery; may transform or stop stream. @param {ChatContext} context @param {string} chunk @returns {Promise<ChatChunkResult>} */
  async handleChunk(context, chunk) {}
  /** Best-effort compensation only; never replaces durable accounting. @returns {Promise<void>} */
  async onError(_context, _error) {}
}
/** @interface ChatPipelineDriver */
class ChatPipelineDriver {
  /** @param {ChatMiddleware[]} middleware */
  constructor(middleware) {}
  /** Pipeline creates a per-request AbortController, links caller signal, and exposes abort() to every stage. @param {ChatRequest} request @param {{signal?:AbortSignal, onChunk?:(chunk:string)=>Promise<void>|void}} options @returns {Promise<ChatResponse>} */
  async run(request, options) {}
}
module.exports = { ChatMiddleware, ChatPipelineDriver };
```

Required order constraints: identity/channel normalization → authorization/license/budget preflight → redaction → retrieval with ACL filter → input guardrails → model execution with every chunk crossing output-guardrail and budget `handleChunk` hooks → durable final metering → persistence (unless temporary) → event publication. `ChatPipelineDriver` owns one `AbortController` per request; caller abort and a stage `stop` verdict abort model/provider work immediately before further channel delivery.

## First driver

`DefaultChatPipeline` with `PatternRedactionMiddleware`, `WorkspaceGuardrailMiddleware`, and `UsageMeteringMiddleware`, wrapping existing LLM providers.

## Boundaries

- Channel drivers MUST NOT call LLM/vector providers, redactors, guardrails, or meters directly.
- Middleware MUST NOT bypass authorization or weaken results from earlier stages; strictest policy wins.
- Redacted secrets/PII MUST NOT be restored into provider requests, logs, events, or metering dimensions.
- Metering MUST NOT depend only on client completion; aborted/failed model calls record known usage.
- Chunk hooks run serially in configured security order. Once any returns `stop`, later delivery stops, controller aborts, known usage is consumed, and no middleware may restart stream.
- Temporary mode suppresses chat/content persistence, not security audit or aggregate usage records.

## Failure semantics

Validation, authorization, license, budget, and guardrail denials stop before model execution with typed non-retryable errors. Redaction/authorization/guardrail failure fails closed. Retryable model/provider errors may be retried only under request idempotency key and budget policy. Metering persistence failure prevents successful completion (or uses durable outbox before response). Client abort propagates `AbortSignal`, stops delivery, records known usage, and emits terminal event. Middleware exceptions call prior stages' `onError` in reverse order; no raw prompt enters error text.
