# Channel seam

## Responsibility

Adapt an ingress/egress surface to canonical chat requests and responses while forcing all conversation execution through chat pipeline. Resolve external sender and conversation bindings without granting authority itself.

## Driver contract

```js
/** @typedef {{deliveryId:string, externalActorId:string, externalConversationId:string, workspaceHint:string|null, text:string, attachments:Object[], replyToken?:string, metadata:Object}} ChannelInbound */
/** @typedef {{type:"user"|"service"|"embed", id:string, orgId:string, workspaceIds:string[], groupIds:string[], scopedKeyId?:string, onBehalfOf?:{type:"user", id:string}, impersonatedBy?:{type:"user", id:string}}} Actor */
/** @typedef {{requestId:string, actor:Actor, workspaceId:string, channel:string, prompt:string, attachments:Object[], mode:"persistent"|"temporary", metadata:Object}} CanonicalChatRequest */
/** @interface ChannelDriver */
class ChannelDriver {
  /** @returns {string} */
  static channelId() {}
  /** Verify webhook signature/session authenticity and parse once. @param {Object} transport @returns {Promise<ChannelInbound>} */
  async receive(transport) {}
  /** Resolve through core identity/binding service. @param {ChannelInbound} inbound @returns {Promise<CanonicalChatRequest>} */
  async normalize(inbound) {}
  /** @param {{inbound:ChannelInbound, response:Object, signal:AbortSignal}} input @returns {Promise<{externalMessageId:string}>} */
  async deliver(input) {}
  /** @param {{externalMessageId:string, reason:string}} input @returns {Promise<void>} */
  async retract(input) {}
}
module.exports = { ChannelDriver };
```

Core calls `receive → normalize → ChatPipelineDriver.run → deliver`. `deliveryId` deduplicates retries. `EmbedWidgetChannel.normalize` verifies a scoped embed key and creates `type:"embed"` actor with `scopedKeyId`; anonymous visitor data never becomes a user ID or group membership.

## First driver

`WebChannel` for existing web UI. `LarkBotChannel` and hardened `EmbedWidgetChannel` follow.

## Boundaries

- Driver MUST NOT call LLM/vector providers or duplicate redaction, guardrails, authorization, license, budget, persistence, or metering.
- Driver MUST NOT create identities, trust external workspace hints, or map sender to elevated roles.
- Embed actor workspace/document-set scope comes only from verified key claims and is narrowed by authorization engine; channel-supplied parameters can only narrow it.
- View-as-user channel sessions preserve `impersonatedBy` provenance and cannot strip it while normalizing.
- Driver MUST NOT expose internal errors, prompts, secrets, or inaccessible citations to external transport.
- Channel formatting may shorten/split output but must preserve guarded canonical content and citation targets.

## Failure semantics

Invalid signature/token throws non-retryable `ChannelAuthenticationError` before parsing content. Duplicate `deliveryId` returns prior outcome and never reruns chat. Unmapped identity/conversation throws non-retryable `ChannelBindingError`. Delivery rate limits/timeouts are retryable with same canonical response and idempotency key; pipeline does not rerun. Partial multi-message delivery is tracked and retry resumes unsent parts. Retraction is idempotent; unsupported retraction returns explicit `ChannelCapabilityError`.
