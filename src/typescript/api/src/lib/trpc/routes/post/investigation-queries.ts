/**
 * Investigation query helpers for the post router: loading, claim formatting,
 * interim claim carry-forward, and corroboration recording.
 */

import {
  claimIdSchema,
  investigationClaimPayloadSchema,
  normalizeContent,
  type InvestigationClaim,
  type InvestigationClaimPayload,
} from "@openerrata/shared";
import { z } from "zod";
import { isUniqueConstraintError } from "$lib/db/errors.js";
import type { Prisma, PrismaClient } from "$lib/db/prisma-client";
import { TRPCError } from "@trpc/server";

// ---------------------------------------------------------------------------
// Prisma include shapes and derived payload types
// ---------------------------------------------------------------------------

const investigationWithClaimsInclude = {
  input: true,
  lease: true,
  postVersion: {
    select: {
      id: true,
      postId: true,
      contentBlob: {
        select: {
          contentText: true,
          contentHash: true,
        },
      },
    },
  },
  claims: {
    include: {
      sources: true,
    },
  },
} satisfies Prisma.InvestigationInclude;

type InvestigationWithClaims = Prisma.InvestigationGetPayload<{
  include: typeof investigationWithClaimsInclude;
}>;

interface ClaimSourceSummary {
  url: string;
  title: string;
  snippet: string;
}

interface ClaimSummary {
  id: string;
  text: string;
  context: string;
  summary: string;
  reasoning: string;
  sources: ClaimSourceSummary[];
}

/** A complete investigation whose claims may be carried forward to another version. */
interface CompleteInvestigationClaims {
  id: string;
  claims: ClaimSummary[];
}

/**
 * Semantic repository interface for investigation queries. Both PrismaClient
 * (production) and test stubs implement this — decoupled from Prisma's exact
 * query-shape types so consumers depend on behavior, not call signatures.
 */
export interface InvestigationRepository {
  findInvestigationWithClaims(id: string): Promise<InvestigationWithClaims | null>;
  /**
   * The post's most recently completed investigation of any provenance on a
   * version other than `excludedPostVersionId`, or null when there is none.
   */
  findLatestCompleteOnOtherVersion(
    postId: string,
    excludedPostVersionId: string,
  ): Promise<CompleteInvestigationClaims | null>;
  findClientFallbackInvestigationId(postVersionId: string): Promise<string | null>;
  recordCorroborationCredit(investigationId: string, reporterKey: string): Promise<void>;
}

/** Create an InvestigationRepository backed by PrismaClient. */
export function prismaInvestigationRepository(prisma: PrismaClient): InvestigationRepository {
  return {
    async findInvestigationWithClaims(id) {
      return prisma.investigation.findUnique({
        where: { id },
        include: investigationWithClaimsInclude,
      });
    },
    async findLatestCompleteOnOtherVersion(postId, excludedPostVersionId) {
      return prisma.investigation.findFirst({
        where: {
          status: "COMPLETE",
          postVersion: { postId, id: { not: excludedPostVersionId } },
        },
        orderBy: [{ checkedAt: "desc" }, { id: "desc" }],
        select: {
          id: true,
          claims: { include: { sources: true } },
        },
      });
    },
    async findClientFallbackInvestigationId(postVersionId) {
      const result = await prisma.investigation.findFirst({
        where: {
          postVersionId,
          input: { provenance: "CLIENT_FALLBACK" },
        },
        select: { id: true },
      });
      return result?.id ?? null;
    },
    async recordCorroborationCredit(investigationId, reporterKey) {
      try {
        await prisma.corroborationCredit.create({
          data: { investigationId, reporterKey },
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) return;
        throw error;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Progress claims parsing
// ---------------------------------------------------------------------------

const progressClaimsDbSchema = z
  .object({
    pending: z.array(investigationClaimPayloadSchema),
    confirmed: z.array(investigationClaimPayloadSchema),
  })
  .strict();

export function parseProgressClaims(raw: unknown): {
  pendingClaims: InvestigationClaimPayload[];
  confirmedClaims: InvestigationClaimPayload[];
} {
  if (raw === null || raw === undefined) {
    return { pendingClaims: [], confirmedClaims: [] };
  }
  const result = progressClaimsDbSchema.safeParse(raw);
  if (!result.success) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `progressClaims failed schema validation: ${result.error.message}`,
    });
  }
  return { pendingClaims: result.data.pending, confirmedClaims: result.data.confirmed };
}

// ---------------------------------------------------------------------------
// Invariant helpers
// ---------------------------------------------------------------------------

export function unreachableInvestigationStatus(status: never): never {
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: `Unexpected investigation status: ${String(status)}`,
  });
}

export function requireCompleteCheckedAtIso(
  investigationId: string,
  checkedAt: Date | null,
): string {
  if (checkedAt === null) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `Investigation ${investigationId} is COMPLETE with null checkedAt`,
    });
  }
  return checkedAt.toISOString();
}

// ---------------------------------------------------------------------------
// Claim formatting
// ---------------------------------------------------------------------------

export function formatClaims(claims: ClaimSummary[]): InvestigationClaim[] {
  return claims.map((c) => ({
    id: claimIdSchema.parse(c.id),
    text: c.text,
    context: c.context,
    summary: c.summary,
    reasoning: c.reasoning,
    sources: c.sources.map((s) => ({
      url: s.url,
      title: s.title,
      snippet: s.snippet,
    })),
  }));
}

// ---------------------------------------------------------------------------
// Investigation loading
// ---------------------------------------------------------------------------

export async function loadInvestigationWithClaims(
  repo: InvestigationRepository,
  investigationId: string,
): Promise<InvestigationWithClaims | null> {
  return repo.findInvestigationWithClaims(investigationId);
}

// ---------------------------------------------------------------------------
// Interim claim carry-forward (spec §2.8 "Interim carry-forward")
// ---------------------------------------------------------------------------

/** Claims shown on a post version while it has no finished investigation of its own. */
interface CarriedForwardClaims {
  oldClaims: InvestigationClaim[];
  sourceInvestigationId: string;
}

/**
 * Whether a claim's quoted text occurs verbatim in `contentText`, compared
 * after the normalization all content text gets (spec §3.8) — the text the
 * extension locates claims in. Empty text quotes nothing.
 */
function claimTextOccursIn(claimText: string, contentText: string): boolean {
  const normalizedClaimText = normalizeContent(claimText);
  return normalizedClaimText.length > 0 && contentText.includes(normalizedClaimText);
}

/**
 * The claims of `source` that are still about `contentText`: those whose
 * quoted text still occurs in it. A correction is only shown while the exact
 * text it corrects is still on the page. Null when no claim survives.
 */
export function carryForwardClaims(
  source: CompleteInvestigationClaims,
  contentText: string,
): CarriedForwardClaims | null {
  const survivingClaims = source.claims.filter((claim) =>
    claimTextOccursIn(claim.text, contentText),
  );
  if (survivingClaims.length === 0) {
    return null;
  }
  return {
    oldClaims: formatClaims(survivingClaims),
    sourceInvestigationId: source.id,
  };
}

/**
 * Interim claims for a post version with no finished investigation (spec §2.8
 * "Interim carry-forward"): the claims of the post's latest complete
 * investigation of another version — of either provenance — that still occur
 * in this version's content text. Null when there is no such investigation or
 * none of its claims survive. Every status that reports interim claims
 * (not investigated, investigating) takes them from here.
 */
export async function findCarriedForwardClaims(
  repo: InvestigationRepository,
  postVersion: { id: string; postId: string; contentText: string },
): Promise<CarriedForwardClaims | null> {
  const source = await repo.findLatestCompleteOnOtherVersion(postVersion.postId, postVersion.id);
  return source === null ? null : carryForwardClaims(source, postVersion.contentText);
}

// ---------------------------------------------------------------------------
// Corroboration recording
// ---------------------------------------------------------------------------

export async function maybeRecordCorroboration(
  repo: InvestigationRepository,
  postVersionId: string,
  viewerKey: string,
  isAuthenticated: boolean,
): Promise<void> {
  if (!isAuthenticated) return;

  const investigationId = await repo.findClientFallbackInvestigationId(postVersionId);
  if (investigationId === null) return;

  await repo.recordCorroborationCredit(investigationId, viewerKey);
}
