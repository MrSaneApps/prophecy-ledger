import { resolveReviewerPrincipal } from "../../lib/reviewer-auth.js";
import { listAllClaimWork } from "../../lib/review-workflow.js";
import { apiError, json } from "../../lib/response.js";

export async function onRequestGet({ request, env }) {
  const principal = await resolveReviewerPrincipal(request, env);
  if (!principal) return apiError("Not found.", "not_found", 404);
  try {
    const claims = await listAllClaimWork(env.DB);
    return json({ claims });
  } catch (error) {
    console.error("pending_list_failed", error);
    return apiError("The claim list is unavailable.", "pending_unavailable", 503);
  }
}
