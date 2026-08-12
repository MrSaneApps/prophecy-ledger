import { getSourceCatalogue, SourceCatalogueError } from "../../../lib/repository.js";
import { apiError, json } from "../../../lib/response.js";

export async function onRequestGet({ request, env, params }) {
  const url = new URL(request.url);
  try {
    const catalogue = await getSourceCatalogue(env.DB, String(params.slug || ""), {
      status: url.searchParams.get("status") || undefined,
      platform: url.searchParams.get("platform") || undefined,
      sort: url.searchParams.get("sort") || undefined,
      query: url.searchParams.get("q") || undefined,
      limit: url.searchParams.has("limit") ? url.searchParams.get("limit") : undefined,
      cursor: url.searchParams.get("cursor") || undefined,
    });
    if (!catalogue) return apiError("Profile not found.", "profile_not_found", 404);
    return json(catalogue);
  } catch (error) {
    if (error instanceof SourceCatalogueError) return apiError(error.message, error.code, 400);
    if (/no such (?:table|view):\s*(source_items|source_item_revisions|transcript_artifacts|claim_candidates|transcript_analysis_runs|transcript_batch_items|effective_transcript_batch_item_dispositions|review_work_items|review_assignments|candidate_review_decisions)/i.test(String(error?.message || error))) {
      return apiError("The source catalogue is not ready yet.", "catalogue_not_ready", 503);
    }
    console.error("source_catalogue_failed", error);
    return apiError("The source catalogue is temporarily unavailable.", "catalogue_unavailable", 503);
  }
}
