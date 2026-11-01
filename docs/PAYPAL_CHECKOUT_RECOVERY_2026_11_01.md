# PayPal checkout approval recovery — API 0.72.1

An unapproved PayPal subscription was stored as an incomplete subscription but its checkout was marked completed by the CREATED event. Billing then presented it as a renewal, including an unavailable paid-through date and a cancellation action. Live probing of an explicitly unapproved capability subscription confirmed that PayPal returns `404 INVALID_RESOURCE_ID` when that resource is sent to `/cancel` before buyer approval.

The provider now exposes a future billing start only after buyer approval. Subscription reconciliation records checkout completion only after approval and repairs the older incorrectly completed checkout rows on the next authoritative read. `approvalPending` distinguishes an unfinished checkout from an approved subscription awaiting its first payment. The account billing response also exposes the independent free period's source and end date. No grant is created, extended, removed or reset by this fix.

Cancellation first reads the owned subscription from PayPal. When it is unapproved, the response explicitly says `approvalPending: true, confirmed: false`; no provider cancellation is attempted or falsely claimed. Approved renewal cancellation still verifies PayPal's resulting state and preserves any verified paid period and existing free grants. History includes approval state and the approved future billing date for independent Plus/Bots+ display.

Validation before release: TypeScript/build and 33 PayPal, standalone-commerce and contract tests passed. The broader billing regressions passed 81 tests with one pre-existing expectation that still listed monthly Sparks; the same failure was reproduced on unchanged API 0.71.1. That expectation now checks the existing one-time Spark behavior. A separate broad server run was stopped after unrelated setup timeouts under concurrent build load; it is not claimed as passing.

## Expired provider references

A definitive PayPal GET 404 is now distinct from network, authorization and cancellation errors. Only an incomplete attempt with no verified payment period or paid invoice can become `incomplete_expired`; a paid subscription is never expired or declared canceled because of a 404. Each provider read is isolated, so one unavailable reference does not block other customers' reconciliation. An unavailable read cannot authorize a stale checkout reference.

Expired unpaid attempts can start fresh with a new owned checkout and retry key. Cancellation reports checkout expiry separately from confirmed cancellation. Added tests cover the transport classification, safe expiry/restart, isolation of a failed read and preservation of paid subscriptions. Final targeted PayPal/commerce/contracts suite: **38 passed**.

## Current production compatibility

API 0.72.1 preserves the deployed 0.72.0 message-collections implementation, database catalog, retrieval metadata, maintenance code and route registration byte for byte except the version identifier. It also preserves the deployed Embers implementation from 858daff8. The payment recovery changes are isolated to billing and its optional contract fields. Production sources were read from the active compose build contexts before integration; no database, price, grant or merchant configuration is replaced.
