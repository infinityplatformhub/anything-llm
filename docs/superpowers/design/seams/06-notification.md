# Notification seam

## Responsibility

Deliver transactional and operational notifications through replaceable transports, using canonical templates, recipient policy, and delivery idempotency. Core decides what event warrants notification and supplies non-secret template data.

## Driver contract

```js
/** @typedef {{notificationId:string, templateId:string, recipient:{type:"user"|"address", id:string}, locale:string, data:Object, severity:"info"|"warning"|"critical"}} Notification */
/** @interface NotificationDriver */
class NotificationDriver {
  /** @returns {string} */
  static channelId() {}
  /** @param {Object} config @returns {Promise<{ok:boolean, details:Object}>} */
  static async validateConnection(config) {}
  /** @param {Notification} notification @returns {Promise<{deliveryId:string, acceptedAt:Date}>} */
  async send(notification) {}
  /** @param {{deliveryId:string}} input @returns {Promise<{status:"queued"|"delivered"|"failed"|"unknown", occurredAt:Date|null}>} */
  async status(input) {}
}
module.exports = { NotificationDriver };
```

`notificationId` is idempotency key across queue retries. Rendering happens in trusted core template service; driver receives finalized safe subject/body or constrained template data.

## First driver

`SmtpNotificationDriver` for invites, password reset, license expiry, connector failure, and backup failure. Lark and webhook drivers follow.

## Boundaries

- Driver MUST NOT decide recipients, escalation policy, authorization, or whether event is notifiable.
- Driver MUST NOT read app models to enrich messages or fetch chat/document content.
- Driver MUST NOT log bodies, reset tokens, invite links, credentials, or personal recipient details.
- Notifications are not audit records; delivery cannot replace event-bus audit publication.
- Webhook driver must use allowlisted destinations and egress policy; no arbitrary per-message URL.

## Failure semantics

Invalid recipient/template payload throws non-retryable `NotificationContractError`. Authentication/configuration failure disables channel and throws `NotificationConfigurationError`. Rate limits/network/temporary server failures throw retryable `NotificationUnavailableError` with retry-after. Permanent provider rejection throws `NotificationRejectedError` and emits delivery-failed event. Duplicate `notificationId` returns existing delivery. After retry limit, queue dead-letters and emits a distinct operational alert through another configured channel where available.
