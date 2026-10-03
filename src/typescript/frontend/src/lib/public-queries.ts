import {
  getPublicInvestigationInputSchema,
  publicGetInvestigationOutputSchema,
  publicSearchInvestigationsOutputSchema,
  searchInvestigationsInputSchema,
} from "@openerrata/shared";
import { z } from "zod";

/**
 * A GraphQL document the site sends to the API's public `/graphql` endpoint,
 * paired with the shared public-API schemas for its variables and response.
 *
 * Each document selects every field of its response schema, so a response that
 * fails to parse means the API broke the public contract. The API's
 * `test/unit/frontend-graphql-contract.test.ts` executes these documents
 * against the real GraphQL schema to keep both sides in step.
 *
 * This module must stay free of SvelteKit imports so that test can load it.
 */
export interface PublicQuery<TVariables extends z.ZodType, TData extends z.ZodType> {
  document: string;
  variablesSchema: TVariables;
  dataSchema: TData;
}

const INVESTIGATION_ORIGIN_FIELDS = `
  origin {
    provenance
    serverVerifiedAt
  }
`;

export const searchInvestigationsQuery = {
  document: `
    query SearchInvestigations(
      $query: String
      $platform: Platform
      $minClaimCount: Int
      $limit: Int
      $offset: Int
    ) {
      searchInvestigations(
        query: $query
        platform: $platform
        minClaimCount: $minClaimCount
        limit: $limit
        offset: $offset
      ) {
        investigations {
          id
          contentHash
          checkedAt
          platform
          externalId
          url
          corroborationCount
          claimCount
          claimSummaries {
            id
            summary
          }
          ${INVESTIGATION_ORIGIN_FIELDS}
        }
        hasMore
      }
    }
  `,
  variablesSchema: searchInvestigationsInputSchema,
  dataSchema: z.object({ searchInvestigations: publicSearchInvestigationsOutputSchema }).strict(),
} satisfies PublicQuery<z.ZodType, z.ZodType>;

export const publicInvestigationQuery = {
  document: `
    query PublicInvestigation($investigationId: ID!) {
      publicInvestigation(investigationId: $investigationId) {
        investigation {
          id
          corroborationCount
          checkedAt
          promptVersion
          provider
          model
          ${INVESTIGATION_ORIGIN_FIELDS}
        }
        post {
          platform
          externalId
          url
        }
        claims {
          id
          text
          context
          summary
          reasoning
          sources {
            url
            title
            snippet
          }
        }
      }
    }
  `,
  variablesSchema: getPublicInvestigationInputSchema,
  dataSchema: z.object({ publicInvestigation: publicGetInvestigationOutputSchema }).strict(),
} satisfies PublicQuery<z.ZodType, z.ZodType>;
