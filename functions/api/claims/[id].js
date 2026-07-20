import { getPublicClaim } from "../../lib/repository.js";
import { apiError, json } from "../../lib/response.js";

export async function onRequestGet({ env, params }) {
  try {
    const claim = await getPublicClaim(env.DB, String(params.id || ""));
    if (!claim) return apiError("Claim not found.", "claim_not_found", 404);
    return json(claim);
  } catch (error) {
    console.error("claim_failed", error);
    return apiError("The claim is temporarily unavailable.", "claim_unavailable", 503);
  }
}
