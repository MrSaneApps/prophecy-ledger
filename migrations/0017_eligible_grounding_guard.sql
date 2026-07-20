PRAGMA foreign_keys = ON;

-- Migration 0015 is already live. Strengthen only future eligible inserts;
-- existing append-only assessments remain unchanged historical evidence.
CREATE TRIGGER IF NOT EXISTS candidate_admissibility_eligible_grounding_guard
BEFORE INSERT ON candidate_admissibility_assessments
WHEN NEW.decision='eligible' AND COALESCE((
  json_type(NEW.grounding_json,'$.contextStart')='integer'
  AND json_type(NEW.grounding_json,'$.contextEnd')='integer'
  AND json_extract(NEW.grounding_json,'$.contextStart') >= 0
  AND json_extract(NEW.grounding_json,'$.contextEnd') > json_extract(NEW.grounding_json,'$.contextStart')
  AND json_extract(NEW.grounding_json,'$.contextEnd') - json_extract(NEW.grounding_json,'$.contextStart') <= 1200
  AND json_type(NEW.grounding_json,'$.dimensions')='object'
  AND EXISTS (
    SELECT 1 FROM claim_candidates candidate
    WHERE candidate.candidate_id=NEW.candidate_id
      AND candidate.quote_start >= json_extract(NEW.grounding_json,'$.contextStart')
      AND candidate.quote_end <= json_extract(NEW.grounding_json,'$.contextEnd')
  )
  AND json_type(NEW.grounding_json,'$.dimensions.who')='object'
  AND json_type(NEW.grounding_json,'$.dimensions.who.value')='text'
  AND trim(json_extract(NEW.grounding_json,'$.dimensions.who.value'))=trim(NEW.who_text)
  AND json_type(NEW.grounding_json,'$.dimensions.who.supportQuote')='text'
  AND length(trim(json_extract(NEW.grounding_json,'$.dimensions.who.supportQuote'))) > 0
  AND instr(lower(json_extract(NEW.grounding_json,'$.dimensions.who.supportQuote')),lower(trim(NEW.who_text))) > 0
  AND json_type(NEW.grounding_json,'$.dimensions.who.supportStart')='integer'
  AND json_type(NEW.grounding_json,'$.dimensions.who.supportEnd')='integer'
  AND json_extract(NEW.grounding_json,'$.dimensions.who.supportStart') >= json_extract(NEW.grounding_json,'$.contextStart')
  AND json_extract(NEW.grounding_json,'$.dimensions.who.supportEnd') <= json_extract(NEW.grounding_json,'$.contextEnd')
  AND json_extract(NEW.grounding_json,'$.dimensions.who.supportEnd') > json_extract(NEW.grounding_json,'$.dimensions.who.supportStart')
  AND json_type(NEW.grounding_json,'$.dimensions.what')='object'
  AND json_type(NEW.grounding_json,'$.dimensions.what.value')='text'
  AND trim(json_extract(NEW.grounding_json,'$.dimensions.what.value'))=trim(NEW.what_text)
  AND json_type(NEW.grounding_json,'$.dimensions.what.supportQuote')='text'
  AND length(trim(json_extract(NEW.grounding_json,'$.dimensions.what.supportQuote'))) > 0
  AND instr(lower(json_extract(NEW.grounding_json,'$.dimensions.what.supportQuote')),lower(trim(NEW.what_text))) > 0
  AND json_type(NEW.grounding_json,'$.dimensions.what.supportStart')='integer'
  AND json_type(NEW.grounding_json,'$.dimensions.what.supportEnd')='integer'
  AND json_extract(NEW.grounding_json,'$.dimensions.what.supportStart') >= json_extract(NEW.grounding_json,'$.contextStart')
  AND json_extract(NEW.grounding_json,'$.dimensions.what.supportEnd') <= json_extract(NEW.grounding_json,'$.contextEnd')
  AND json_extract(NEW.grounding_json,'$.dimensions.what.supportEnd') > json_extract(NEW.grounding_json,'$.dimensions.what.supportStart')
  AND json_type(NEW.grounding_json,'$.dimensions.why')='object'
  AND json_type(NEW.grounding_json,'$.dimensions.why.value')='text'
  AND trim(json_extract(NEW.grounding_json,'$.dimensions.why.value'))=trim(NEW.why_text)
  AND json_type(NEW.grounding_json,'$.dimensions.why.supportQuote')='text'
  AND length(trim(json_extract(NEW.grounding_json,'$.dimensions.why.supportQuote'))) > 0
  AND instr(lower(json_extract(NEW.grounding_json,'$.dimensions.why.supportQuote')),lower(trim(NEW.why_text))) > 0
  AND json_type(NEW.grounding_json,'$.dimensions.why.supportStart')='integer'
  AND json_type(NEW.grounding_json,'$.dimensions.why.supportEnd')='integer'
  AND json_extract(NEW.grounding_json,'$.dimensions.why.supportStart') >= json_extract(NEW.grounding_json,'$.contextStart')
  AND json_extract(NEW.grounding_json,'$.dimensions.why.supportEnd') <= json_extract(NEW.grounding_json,'$.contextEnd')
  AND json_extract(NEW.grounding_json,'$.dimensions.why.supportEnd') > json_extract(NEW.grounding_json,'$.dimensions.why.supportStart')
  AND json_type(NEW.grounding_json,'$.dimensions.where')='object'
  AND json_type(NEW.grounding_json,'$.dimensions.where.value')='text'
  AND trim(json_extract(NEW.grounding_json,'$.dimensions.where.value'))=trim(NEW.where_text)
  AND json_type(NEW.grounding_json,'$.dimensions.where.supportQuote')='text'
  AND length(trim(json_extract(NEW.grounding_json,'$.dimensions.where.supportQuote'))) > 0
  AND instr(lower(json_extract(NEW.grounding_json,'$.dimensions.where.supportQuote')),lower(trim(NEW.where_text))) > 0
  AND json_type(NEW.grounding_json,'$.dimensions.where.supportStart')='integer'
  AND json_type(NEW.grounding_json,'$.dimensions.where.supportEnd')='integer'
  AND json_extract(NEW.grounding_json,'$.dimensions.where.supportStart') >= json_extract(NEW.grounding_json,'$.contextStart')
  AND json_extract(NEW.grounding_json,'$.dimensions.where.supportEnd') <= json_extract(NEW.grounding_json,'$.contextEnd')
  AND json_extract(NEW.grounding_json,'$.dimensions.where.supportEnd') > json_extract(NEW.grounding_json,'$.dimensions.where.supportStart')
  AND json_type(NEW.grounding_json,'$.dimensions.when')='object'
  AND json_type(NEW.grounding_json,'$.dimensions.when.value')='text'
  AND trim(json_extract(NEW.grounding_json,'$.dimensions.when.value'))=trim(NEW.when_text)
  AND json_type(NEW.grounding_json,'$.dimensions.when.supportQuote')='text'
  AND length(trim(json_extract(NEW.grounding_json,'$.dimensions.when.supportQuote'))) > 0
  AND instr(lower(json_extract(NEW.grounding_json,'$.dimensions.when.supportQuote')),lower(trim(NEW.when_text))) > 0
  AND json_type(NEW.grounding_json,'$.dimensions.when.supportStart')='integer'
  AND json_type(NEW.grounding_json,'$.dimensions.when.supportEnd')='integer'
  AND json_extract(NEW.grounding_json,'$.dimensions.when.supportStart') >= json_extract(NEW.grounding_json,'$.contextStart')
  AND json_extract(NEW.grounding_json,'$.dimensions.when.supportEnd') <= json_extract(NEW.grounding_json,'$.contextEnd')
  AND json_extract(NEW.grounding_json,'$.dimensions.when.supportEnd') > json_extract(NEW.grounding_json,'$.dimensions.when.supportStart')
  AND json_type(NEW.grounding_json,'$.dimensions.how')='object'
  AND json_type(NEW.grounding_json,'$.dimensions.how.value')='text'
  AND trim(json_extract(NEW.grounding_json,'$.dimensions.how.value'))=trim(NEW.how_text)
  AND (
    (NEW.how_specificity='not_stated'
      AND lower(trim(json_extract(NEW.grounding_json,'$.dimensions.how.value')))='not stated'
      AND json_type(NEW.grounding_json,'$.dimensions.how.supportQuote')='null'
      AND json_type(NEW.grounding_json,'$.dimensions.how.supportStart')='null'
      AND json_type(NEW.grounding_json,'$.dimensions.how.supportEnd')='null')
    OR
    (NEW.how_specificity='stated'
      AND json_type(NEW.grounding_json,'$.dimensions.how.supportQuote')='text'
      AND length(trim(json_extract(NEW.grounding_json,'$.dimensions.how.supportQuote'))) > 0
      AND instr(lower(json_extract(NEW.grounding_json,'$.dimensions.how.supportQuote')),lower(trim(NEW.how_text))) > 0
      AND json_type(NEW.grounding_json,'$.dimensions.how.supportStart')='integer'
      AND json_type(NEW.grounding_json,'$.dimensions.how.supportEnd')='integer'
      AND json_extract(NEW.grounding_json,'$.dimensions.how.supportStart') >= json_extract(NEW.grounding_json,'$.contextStart')
      AND json_extract(NEW.grounding_json,'$.dimensions.how.supportEnd') <= json_extract(NEW.grounding_json,'$.contextEnd')
      AND json_extract(NEW.grounding_json,'$.dimensions.how.supportEnd') > json_extract(NEW.grounding_json,'$.dimensions.how.supportStart'))
  )
), 0) <> 1
BEGIN SELECT RAISE(ABORT, 'eligible assessment requires grounded support spans'); END;
