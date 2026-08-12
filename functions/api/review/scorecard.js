import { resolveReviewerPrincipal } from "../../lib/reviewer-auth.js";
import { apiError, json } from "../../lib/response.js";

async function rows(db, sql) {
  const result = await db.prepare(sql).all();
  return result.results || [];
}

export async function onRequestGet({ request, env }) {
  const principal = await resolveReviewerPrincipal(request, env);
  if (!principal) return apiError("Not found.", "not_found", 404);
  try {
    const humanDecisions = await rows(env.DB,
      `SELECT run.prompt_version promptVersion, decision.decision, COUNT(*) count
       FROM candidate_review_decisions decision
       JOIN claim_candidates candidate ON candidate.candidate_id=decision.candidate_id
       JOIN extraction_runs run ON run.extraction_run_id=candidate.extraction_run_id
       GROUP BY run.prompt_version, decision.decision
       ORDER BY run.prompt_version, decision.decision`);
    const rejectionReasons = await rows(env.DB,
      `SELECT run.prompt_version promptVersion,
        COALESCE(json_extract(decision.decision_fields_json,'$.reasonCode'),'unrecorded') reason,
        COUNT(*) count
       FROM candidate_review_decisions decision
       JOIN claim_candidates candidate ON candidate.candidate_id=decision.candidate_id
       JOIN extraction_runs run ON run.extraction_run_id=candidate.extraction_run_id
       WHERE decision.decision='reject'
       GROUP BY run.prompt_version, reason
       ORDER BY run.prompt_version, count DESC`);
    const admissibility = await rows(env.DB,
      `SELECT gate_version gateVersion, decision, COUNT(*) count
       FROM candidate_admissibility_assessments
       GROUP BY gate_version, decision ORDER BY gate_version, decision`);
    const reviewerFeedback = await rows(env.DB,
      "SELECT category, COUNT(*) count FROM reviewer_feedback GROUP BY category ORDER BY count DESC");
    const publicReports = await rows(env.DB,
      "SELECT category, COUNT(*) count FROM public_issue_reports GROUP BY category ORDER BY count DESC");
    return json({
      asOf: new Date().toISOString(),
      basis: "Computed from append-only human review decisions and feedback; the AI never grades itself.",
      humanDecisions, rejectionReasons, admissibility, reviewerFeedback, publicReports,
    });
  } catch (error) {
    console.error("scorecard_failed", error);
    return apiError("The scorecard is unavailable.", "scorecard_unavailable", 503);
  }
}
