import type { PageServerLoad } from "./$types";
import { graphqlQuery } from "$lib/api";

const SEARCH_INVESTIGATIONS_QUERY = `
  query SearchInvestigations($query: String, $platform: Platform, $minClaimCount: Int, $limit: Int, $offset: Int) {
    searchInvestigations(query: $query, platform: $platform, minClaimCount: $minClaimCount, limit: $limit, offset: $offset) {
      investigations {
        id
        contentHash
        checkedAt
        platform
        externalId
        url
        claimCount
        corroborationCount
        origin {
          provenance
          serverVerifiedAt
        }
      }
    }
  }
`;

interface InvestigationOrigin {
  provenance: "SERVER_VERIFIED" | "CLIENT_FALLBACK";
  serverVerifiedAt: string | null;
}

export interface InvestigationSummary {
  id: string;
  contentHash: string;
  checkedAt: string;
  platform: "LESSWRONG" | "X" | "SUBSTACK" | "WIKIPEDIA";
  externalId: string;
  url: string;
  claimCount: number;
  corroborationCount: number;
  origin: InvestigationOrigin;
}

interface SearchInvestigationsData {
  searchInvestigations: {
    investigations: InvestigationSummary[];
  };
}

type Platform = "LESSWRONG" | "X" | "SUBSTACK" | "WIKIPEDIA";

const PLATFORM_MAP: Record<string, Platform> = {
  LESSWRONG: "LESSWRONG",
  X: "X",
  SUBSTACK: "SUBSTACK",
  WIKIPEDIA: "WIKIPEDIA",
};

function parsePlatform(value: string | null): Platform | undefined {
  if (value === null) {
    return undefined;
  }
  return PLATFORM_MAP[value.toUpperCase()];
}

const PAGE_SIZE = 20;

export const load: PageServerLoad = async ({ url }) => {
  const query = url.searchParams.get("q") ?? undefined;
  const platform = parsePlatform(url.searchParams.get("platform"));
  const pageParam = url.searchParams.get("page");
  const parsedPage = pageParam !== null ? parseInt(pageParam, 10) : NaN;
  const page = Number.isNaN(parsedPage) ? 1 : Math.max(1, parsedPage);
  const offset = (page - 1) * PAGE_SIZE;

  const emptyQuery = query === undefined || query.trim().length === 0;
  const searchQuery = emptyQuery ? undefined : query.trim();

  let investigations: InvestigationSummary[] = [];
  let error: string | undefined;

  try {
    const variables: Record<string, unknown> = { minClaimCount: 1, limit: PAGE_SIZE, offset };
    if (searchQuery !== undefined) {
      variables["query"] = searchQuery;
    }
    if (platform !== undefined) {
      variables["platform"] = platform;
    }
    const data = await graphqlQuery<SearchInvestigationsData>(
      SEARCH_INVESTIGATIONS_QUERY,
      variables,
    );
    investigations = data.searchInvestigations.investigations;
  } catch (e: unknown) {
    error = e instanceof Error ? e.message : "Failed to load corrections";
    console.error("Failed to fetch corrections:", e);
  }

  return {
    investigations,
    error,
    query: searchQuery,
    platform,
    page,
    pageSize: PAGE_SIZE,
  };
};
