import type { PageServerLoad } from "./$types";
import { graphqlQuery } from "$lib/api";

const PUBLIC_INVESTIGATION_QUERY = `
  query PublicInvestigation($investigationId: ID!) {
    publicInvestigation(investigationId: $investigationId) {
      investigation {
        id
        checkedAt
        promptVersion
        provider
        model
        origin {
          provenance
        }
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
`;

interface InvestigationSource {
  url: string;
  title: string;
  snippet: string;
}

interface InvestigationClaim {
  id: string;
  text: string;
  context: string;
  summary: string;
  reasoning: string;
  sources: InvestigationSource[];
}

interface InvestigationOrigin {
  provenance: "SERVER_VERIFIED" | "CLIENT_FALLBACK";
}

interface InvestigationDetail {
  id: string;
  checkedAt: string;
  promptVersion: string;
  provider: string;
  model: string;
  origin: InvestigationOrigin;
}

interface InvestigationPost {
  platform: "LESSWRONG" | "X" | "SUBSTACK" | "WIKIPEDIA";
  externalId: string;
  url: string;
}

export interface PublicInvestigationResult {
  investigation: InvestigationDetail;
  post: InvestigationPost;
  claims: InvestigationClaim[];
}

interface PublicInvestigationData {
  publicInvestigation: PublicInvestigationResult | null;
}

export const load: PageServerLoad = async ({ params }) => {
  let result: PublicInvestigationResult | null = null;
  let error: string | undefined;

  try {
    const data = await graphqlQuery<PublicInvestigationData>(PUBLIC_INVESTIGATION_QUERY, {
      investigationId: params.id,
    });
    result = data.publicInvestigation;
  } catch (e: unknown) {
    error = e instanceof Error ? e.message : "Failed to load investigation";
    console.error("Failed to fetch investigation:", e);
  }

  return { result, error };
};
