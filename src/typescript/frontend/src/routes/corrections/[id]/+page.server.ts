import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { publicInvestigationQuery } from "$lib/public-queries";
import { loadPublicQuery } from "$lib/server/public-api";

export const load: PageServerLoad = async ({ params, fetch }) => {
  const { publicInvestigation } = await loadPublicQuery(fetch, publicInvestigationQuery, {
    investigationId: params.id,
  });
  if (publicInvestigation === null) {
    error(404, "This investigation doesn't exist or hasn't completed yet.");
  }
  return { result: publicInvestigation };
};
