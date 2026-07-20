const EMPTY_COVERAGE = Object.freeze({
  postsFound: 0, videosLinked: 0, transcriptsAvailable: 0, possibleClaimPosts: 0,
  specificClaimCandidates: 0, claimsCheckedByPeople: 0, finalRatings: 0,
  archiveClaimsCatalogued: 0, archiveOriginalVideos: 0, archiveSourceChecksCompleted: 0,
  lastScanAt: null, scanStatus: "not_started", sources: [],
});

async function all(statement) {
  const result = await statement.all();
  return result.results || [];
}

function ingestionTablesMissing(error) {
  return /no such table:\s*(source_items|source_item_revisions|transcript_artifacts|claim_candidates|eligible_claim_candidates|ingestion_runs|first_party_archive_leads|first_party_archive_lead_revisions|first_party_archive_revision_links|archive_verification_work_items)/i
    .test(String(error?.message || error));
}

export async function listPeople(db) {
  try {
    const people = await all(db.prepare(
      `WITH latest_revisions AS (
         SELECT revision.* FROM source_item_revisions revision
         WHERE NOT EXISTS (
           SELECT 1 FROM source_item_revisions newer
           WHERE newer.source_item_id=revision.source_item_id
             AND (newer.fetched_at>revision.fetched_at OR
               (newer.fetched_at=revision.fetched_at AND newer.revision_id>revision.revision_id))
         )),
       post_counts AS (
         SELECT person_id,COUNT(*) count FROM source_items
         WHERE platform='official_site' GROUP BY person_id
       ),
       video_counts AS (
         SELECT item.person_id,COUNT(DISTINCT revision.embedded_item_id) count
         FROM source_items item JOIN latest_revisions revision ON revision.source_item_id=item.source_item_id
         WHERE revision.embedded_item_id IS NOT NULL GROUP BY item.person_id
       ),
       transcript_counts AS (
         SELECT item.person_id,COUNT(DISTINCT item.source_item_id) count
         FROM source_items item JOIN transcript_artifacts artifact ON artifact.source_item_id=item.source_item_id
         GROUP BY item.person_id
       ),
       candidate_counts AS (
         SELECT item.person_id,COUNT(DISTINCT candidate.candidate_id) count
         FROM source_items item JOIN eligible_claim_candidates candidate ON candidate.source_item_id=item.source_item_id
         WHERE candidate.candidate_kind='exact_transcript_claim'
         GROUP BY item.person_id
       ),
       possible_lead_counts AS (
         SELECT item.person_id,COUNT(DISTINCT item.source_item_id) count
         FROM source_items item JOIN claim_candidates candidate ON candidate.source_item_id=item.source_item_id
         WHERE candidate.candidate_kind='description_lead'
         GROUP BY item.person_id
       ),
       latest_archive_revisions AS (
         SELECT revision.* FROM first_party_archive_lead_revisions revision
         WHERE NOT EXISTS (
           SELECT 1 FROM first_party_archive_lead_revisions newer
           WHERE newer.archive_lead_id=revision.archive_lead_id
             AND (newer.fetched_at>revision.fetched_at OR
               (newer.fetched_at=revision.fetched_at AND newer.archive_revision_id>revision.archive_revision_id))
         )
       ),
       archive_claim_counts AS (
         SELECT person_id,COUNT(*) count FROM first_party_archive_leads GROUP BY person_id
       ),
       archive_video_counts AS (
         SELECT lead.person_id,COUNT(DISTINCT link.source_item_id) count
         FROM first_party_archive_leads lead
         JOIN latest_archive_revisions revision ON revision.archive_lead_id=lead.archive_lead_id
         JOIN first_party_archive_revision_links link ON link.archive_revision_id=revision.archive_revision_id
         WHERE link.link_role='original_video' AND link.source_item_id IS NOT NULL
         GROUP BY lead.person_id
       ),
       archive_check_counts AS (
         SELECT lead.person_id,COUNT(DISTINCT work.archive_work_item_id) count
         FROM first_party_archive_leads lead
         JOIN latest_archive_revisions revision ON revision.archive_lead_id=lead.archive_lead_id
         JOIN archive_verification_work_items work ON work.archive_revision_id=revision.archive_revision_id
         WHERE work.status='complete' GROUP BY lead.person_id
       ),
       review_counts AS (
         SELECT claim.person_id,COUNT(DISTINCT review.claim_id) count
         FROM moderator_reviews review JOIN claims claim ON claim.claim_id=review.claim_id
         GROUP BY claim.person_id
       ),
       rating_counts AS (
         SELECT person_id,COUNT(*) count FROM claims WHERE visibility='published' GROUP BY person_id
       ),
       latest_runs AS (
         SELECT run.person_id,run.status,
           COALESCE(run.completed_at,run.discovery_finished_at,run.started_at,run.created_at) last_scan_at
         FROM ingestion_runs run WHERE NOT EXISTS (
           SELECT 1 FROM ingestion_runs newer WHERE newer.person_id=run.person_id
             AND (newer.created_at>run.created_at OR
               (newer.created_at=run.created_at AND newer.run_id>run.run_id))
         )
       )
       SELECT person.slug,person.display_name,person.corpus_label,
         COALESCE(posts.count,0) posts_found,COALESCE(videos.count,0) videos_linked,
         COALESCE(transcripts.count,0) transcripts_available,
         COALESCE(possible_leads.count,0) possible_claim_posts,
         COALESCE(candidates.count,0) specific_claim_candidates,
         COALESCE(archive_claims.count,0) archive_claims_catalogued,
         COALESCE(archive_videos.count,0) archive_original_videos,
         COALESCE(archive_checks.count,0) archive_source_checks_completed,
         COALESCE(reviews.count,0) claims_checked,COALESCE(ratings.count,0) final_ratings,
         latest_runs.status scan_status,latest_runs.last_scan_at
       FROM people person
       LEFT JOIN post_counts posts ON posts.person_id=person.person_id
       LEFT JOIN video_counts videos ON videos.person_id=person.person_id
       LEFT JOIN transcript_counts transcripts ON transcripts.person_id=person.person_id
       LEFT JOIN candidate_counts candidates ON candidates.person_id=person.person_id
       LEFT JOIN possible_lead_counts possible_leads ON possible_leads.person_id=person.person_id
       LEFT JOIN archive_claim_counts archive_claims ON archive_claims.person_id=person.person_id
       LEFT JOIN archive_video_counts archive_videos ON archive_videos.person_id=person.person_id
       LEFT JOIN archive_check_counts archive_checks ON archive_checks.person_id=person.person_id
       LEFT JOIN review_counts reviews ON reviews.person_id=person.person_id
       LEFT JOIN rating_counts ratings ON ratings.person_id=person.person_id
       LEFT JOIN latest_runs ON latest_runs.person_id=person.person_id
       ORDER BY person.created_at,person.display_name,person.person_id`
    ));
    return people.map((person) => ({
      person: { slug: person.slug, displayName: person.display_name, corpusLabel: person.corpus_label },
      corpusCoverage: {
        postsFound: Number(person.posts_found || 0), videosLinked: Number(person.videos_linked || 0),
        transcriptsAvailable: Number(person.transcripts_available || 0),
        possibleClaimPosts: Number(person.possible_claim_posts || 0),
        specificClaimCandidates: Number(person.specific_claim_candidates || 0),
        archiveClaimsCatalogued: Number(person.archive_claims_catalogued || 0),
        archiveOriginalVideos: Number(person.archive_original_videos || 0),
        archiveSourceChecksCompleted: Number(person.archive_source_checks_completed || 0),
        claimsCheckedByPeople: Number(person.claims_checked || 0), finalRatings: Number(person.final_ratings || 0),
        lastScanAt: person.last_scan_at || null, scanStatus: person.scan_status || "not_started", sources: [],
      },
    }));
  } catch (error) {
    if (!ingestionTablesMissing(error)) throw error;
    const people = await all(db.prepare(
      `SELECT slug,display_name,corpus_label FROM people ORDER BY created_at,display_name,person_id`
    ));
    return people.map((person) => ({
      person: { slug: person.slug, displayName: person.display_name, corpusLabel: person.corpus_label },
      corpusCoverage: { ...EMPTY_COVERAGE },
    }));
  }
}
