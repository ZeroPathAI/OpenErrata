import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  InvestigatorAttemptAudit,
  InvestigatorResponseAudit,
} from "../../src/lib/investigators/interface.js";

/**
 * Invariants under test:
 *
 * 1. **Outcome is derived, not declared**: persistAttemptAudit derives
 *    "SUCCEEDED"/"FAILED" from the audit's discriminated union (error !== null
 *    → FAILED). There is no separate `outcome` parameter. This makes the
 *    inconsistent state (outcome=SUCCEEDED + error present) unrepresentable.
 *
 * 2. **parseInvestigatorAttemptAudit rejects untrusted payloads at the
 *    boundary**: The audit enters as `unknown` from the investigator. Invalid
 *    shapes (non-objects, malformed timestamps, invalid pairings) must be
 *    caught here, not at the DB layer. These are runtime validation checks on
 *    data we don't control (OpenAI response shapes).
 *
 * 3. **Paired-nullability superRefine guards**: outputItem's
 *    providerItemId/itemStatus and toolCall's providerToolCallId/status must
 *    be both-present or both-null. These are runtime refinements that the
 *    TypeScript type system can't express (both fields are `string | null`).
 */

import {
  investigatorOutputItemAuditSchema,
  investigatorToolCallAuditSchema,
  parseInvestigatorAttemptAudit,
} from "../../src/lib/investigators/interface.js";

// ── Test fixtures ────────────────────────────────────────────────────────────

const NOW = new Date().toISOString();

function makeMinimalResponse(): InvestigatorResponseAudit {
  return {
    responseId: "resp_test_1",
    responseStatus: "completed",
    responseModelVersion: "gpt-4o-2025-01-01",
    responseOutputText: '{"claims":[]}',
    outputItems: [
      {
        outputIndex: 0,
        providerItemId: "item_001",
        itemType: "message",
        itemStatus: "completed",
      },
    ],
    outputTextParts: [
      {
        outputIndex: 0,
        partIndex: 0,
        partType: "output_text",
        text: '{"claims":[]}',
      },
    ],
    outputTextAnnotations: [],
    reasoningSummaries: [],
    toolCalls: [],
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cachedInputTokens: null,
      reasoningOutputTokens: null,
    },
  };
}

function makeSucceededAudit(): InvestigatorAttemptAudit {
  return {
    startedAt: NOW,
    completedAt: NOW,
    requestModel: "gpt-4o",
    requestInstructions: "system prompt",
    requestInput: "user prompt",
    requestReasoningEffort: "medium",
    requestReasoningSummary: "auto",
    requestedTools: [
      {
        requestOrder: 0,
        toolType: "web_search_preview",
        rawDefinition: { type: "web_search_preview" },
      },
    ],
    response: makeMinimalResponse(),
    error: null,
  };
}

// ── parseInvestigatorAttemptAudit: boundary validation ────────────────────────
//
// The audit payload comes from the investigator as untyped data. These tests
// verify the runtime boundary rejects shapes that would cause DB errors or
// corrupt audit trails.

test("parseInvestigatorAttemptAudit rejects non-object input", () => {
  assert.throws(() => parseInvestigatorAttemptAudit("not an object"));
  assert.throws(() => parseInvestigatorAttemptAudit(null));
  assert.throws(() => parseInvestigatorAttemptAudit(42));
});

test("parseInvestigatorAttemptAudit rejects invalid ISO timestamps", () => {
  assert.throws(() =>
    parseInvestigatorAttemptAudit({
      ...makeSucceededAudit(),
      startedAt: "not-a-timestamp",
    }),
  );
});

test("parseInvestigatorAttemptAudit rejects error=null + response=null (impossible audit state)", () => {
  // The discriminated union has two branches:
  //   succeeded: error=null, response=ResponseAudit (non-null)
  //   failed:    error=ErrorAudit (non-null), response=ResponseAudit|null
  // error=null + response=null fits neither branch.
  assert.throws(() =>
    parseInvestigatorAttemptAudit({
      ...makeSucceededAudit(),
      response: null,
      error: null,
    }),
  );
});

// ── Paired-nullability: outputItem providerItemId ↔ itemStatus ───────────────
//
// OpenAI sometimes returns output items without an id (e.g., intermediate
// streaming items). The superRefine guard ensures we never store a half-
// identified item (id without status or vice versa), which would break
// the audit query joins. TypeScript's `string | null` can't express this
// pairing constraint.

test("outputItemAudit rejects providerItemId without itemStatus", () => {
  const result = investigatorOutputItemAuditSchema.safeParse({
    outputIndex: 0,
    providerItemId: "item_001",
    itemType: "message",
    itemStatus: null,
  });
  assert.equal(result.success, false);
});

test("outputItemAudit rejects itemStatus without providerItemId", () => {
  const result = investigatorOutputItemAuditSchema.safeParse({
    outputIndex: 0,
    providerItemId: null,
    itemType: "message",
    itemStatus: "completed",
  });
  assert.equal(result.success, false);
});

// ── Paired-nullability: toolCall providerToolCallId ↔ status ─────────────────
//
// Same invariant for tool calls. A tool call with an id but no status (or vice
// versa) indicates a parsing bug in the audit extraction layer.

test("toolCallAudit rejects providerToolCallId without status", () => {
  const result = investigatorToolCallAuditSchema.safeParse({
    outputIndex: 0,
    providerToolCallId: "tc_001",
    toolType: "web_search_preview",
    status: null,
    rawPayload: {},
    capturedAt: NOW,
    providerStartedAt: null,
    providerCompletedAt: null,
  });
  assert.equal(result.success, false);
});

test("toolCallAudit rejects status without providerToolCallId", () => {
  const result = investigatorToolCallAuditSchema.safeParse({
    outputIndex: 0,
    providerToolCallId: null,
    toolType: "web_search_preview",
    status: "completed",
    rawPayload: {},
    capturedAt: NOW,
    providerStartedAt: null,
    providerCompletedAt: null,
  });
  assert.equal(result.success, false);
});
