import { error } from "@sveltejs/kit";
import { platformSchema, type Platform } from "@openerrata/shared";
import type { PageServerLoad } from "./$types";
import { searchInvestigationsQuery } from "$lib/public-queries";
import { loadPublicQuery } from "$lib/server/public-api";

const PAGE_SIZE = 20;

/** An absent or empty `platform` (the "All platforms" option) means no filter. */
function parsePlatformFilter(value: string | null): Platform | undefined {
  if (value === null || value === "") {
    return undefined;
  }
  const parsed = platformSchema.safeParse(value);
  if (!parsed.success) {
    error(400, "Unknown platform filter.");
  }
  return parsed.data;
}

function parsePageNumber(value: string | null): number {
  if (value === null) {
    return 1;
  }
  const page = Number(value);
  if (!Number.isSafeInteger(page) || page < 1) {
    error(400, "Page must be a positive integer.");
  }
  return page;
}

export const load: PageServerLoad = async ({ url, fetch }) => {
  const trimmedQuery = url.searchParams.get("q")?.trim() ?? "";
  const query = trimmedQuery.length > 0 ? trimmedQuery : undefined;
  const platform = parsePlatformFilter(url.searchParams.get("platform"));
  const page = parsePageNumber(url.searchParams.get("page"));

  const { searchInvestigations } = await loadPublicQuery(fetch, searchInvestigationsQuery, {
    query,
    platform,
    minClaimCount: 1,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  return {
    investigations: searchInvestigations.investigations,
    hasMore: searchInvestigations.hasMore,
    query,
    platform,
    page,
  };
};
