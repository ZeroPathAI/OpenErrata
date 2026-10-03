/**
 * Admitting investigations for execution (SPEC §3.7).
 *
 * An investigation is only ever created — or revived after its user key was
 * dropped — together with a decision about who pays for it:
 *
 * - SELECTOR: background selection under the per-UTC-day budget; server key.
 * - INSTANCE_REQUEST: investigateNow from an instance-API-key client; server key.
 * - USER_KEY_REQUEST: investigateNow funded by the requester's verified OpenAI
 *   key, attached in the same transaction that admits the investigation.
 *
 * A user key only ever funds what its own request admits; it never takes over
 * an investigation someone else is already paying for.
 */

import { randomUUID } from "node:crypto";
import type { Prisma } from "$lib/db/prisma-client";
import { DEFAULT_INVESTIGATION_PROVIDER } from "@openerrata/shared";
import { investigationInputRow, type InvestigationInputSnapshot } from "./investigation-input.js";
import type { UpdateLineage } from "./update-lineage.js";
import { attachOpenAiKeySource, type VerifiedOpenAiApiKey } from "./user-key-source.js";

export type InvestigationFunding =
  | { origin: "SELECTOR" }
  | { origin: "INSTANCE_REQUEST" }
  | { origin: "USER_KEY_REQUEST"; apiKey: VerifiedOpenAiApiKey };

/**
 * Investigations no one is paying for: user-key admissions whose key was
 * dropped. They wait, unqueued, until the selector or a new request funds them.
 */
export const unfundedInvestigationWhere = {
  status: "PENDING",
  origin: "USER_KEY_REQUEST",
  openAiKeySource: { is: null },
} satisfies Prisma.InvestigationWhereInput;

async function attachFunding(
  tx: Prisma.TransactionClient,
  investigationId: string,
  funding: InvestigationFunding,
  now: Date,
): Promise<void> {
  if (funding.origin === "USER_KEY_REQUEST") {
    await attachOpenAiKeySource(tx, { investigationId, apiKey: funding.apiKey, now });
  }
}

/**
 * Create the PENDING investigation (and its immutable input snapshot) for a
 * post version that has none. Throws a unique-constraint error if another
 * request created one first; callers treat that as "already exists".
 */
export async function insertAdmittedInvestigation(
  tx: Prisma.TransactionClient,
  input: {
    postVersionId: string;
    promptId: string;
    funding: InvestigationFunding;
    lineage: UpdateLineage | null;
    snapshot: InvestigationInputSnapshot;
    now: Date;
  },
): Promise<{ id: string }> {
  const investigationId = randomUUID();
  await tx.investigationInput.create({
    data: investigationInputRow(investigationId, input.snapshot),
  });
  const investigation = await tx.investigation.create({
    data: {
      id: investigationId,
      inputId: investigationId,
      postVersionId: input.postVersionId,
      status: "PENDING",
      parentInvestigationId: input.lineage?.parentInvestigationId ?? null,
      contentDiff: input.lineage?.contentDiff ?? null,
      promptId: input.promptId,
      provider: DEFAULT_INVESTIGATION_PROVIDER,
      origin: input.funding.origin,
      admittedAt: input.now,
      queuedAt: input.now,
    },
    select: { id: true },
  });
  await attachFunding(tx, investigation.id, input.funding, input.now);
  return investigation;
}

/**
 * Fund an unfunded investigation. Returns false when it is no longer
 * unfunded (someone else funded it first, or it is no longer PENDING).
 */
export async function fundUnfundedInvestigation(
  tx: Prisma.TransactionClient,
  input: { investigationId: string; funding: InvestigationFunding; now: Date },
): Promise<boolean> {
  const admitted = await tx.investigation.updateMany({
    where: { id: input.investigationId, ...unfundedInvestigationWhere },
    data: { origin: input.funding.origin, admittedAt: input.now, queuedAt: input.now },
  });
  if (admitted.count === 0) {
    return false;
  }
  await attachFunding(tx, input.investigationId, input.funding, input.now);
  return true;
}
