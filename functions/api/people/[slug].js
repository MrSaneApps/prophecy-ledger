import { getPersonProfile } from "../../lib/repository.js";
import { apiError, json } from "../../lib/response.js";

export async function onRequestGet({ env, params }) {
  try {
    const profile = await getPersonProfile(env.DB, String(params.slug || ""));
    if (!profile) return apiError("Profile not found.", "profile_not_found", 404);
    return json(profile);
  } catch (error) {
    console.error("profile_failed", error);
    return apiError("The profile is temporarily unavailable.", "profile_unavailable", 503);
  }
}
