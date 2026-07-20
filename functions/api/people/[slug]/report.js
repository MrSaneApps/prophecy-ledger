import { getPersonProfile } from "../../../lib/repository.js";
import { buildProfileReportPdf } from "../../../lib/profile-report.js";
import { apiError } from "../../../lib/response.js";

export async function onRequestGet({ env, params }) {
  try {
    const profile = await getPersonProfile(env.DB, params.slug);
    if (!profile) return apiError("Profile not found.", "not_found", 404);
    const report = await buildProfileReportPdf(profile);
    return new Response(report.bytes, {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${report.filename}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    console.error("profile_report_failed", error);
    return apiError("The report could not be generated.", "report_generation_failed", 500);
  }
}
