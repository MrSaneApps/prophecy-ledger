import { listPeople } from "../lib/people-directory.js";
import { apiError, json } from "../lib/response.js";

export async function onRequestGet({ env }) {
  try {
    return json({ people: await listPeople(env.DB) });
  } catch (error) {
    console.error("people_list_failed", error);
    return apiError("The people directory is temporarily unavailable.", "people_unavailable", 503);
  }
}
