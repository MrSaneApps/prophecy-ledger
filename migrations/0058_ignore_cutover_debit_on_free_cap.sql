-- Deploy-runtime writes a same-day 86400s legacy_cutover_fail_closed debit.
-- That must not lock a free-tier day whose configured cap is already <= 7.5h.
DROP TRIGGER IF EXISTS gemini_physical_media_budget_guard;

CREATE TRIGGER gemini_physical_media_budget_guard
BEFORE INSERT ON gemini_physical_request_reservations
WHEN (
  COALESCE((SELECT SUM(CASE
      WHEN reason = 'legacy_cutover_fail_closed'
        AND reserved_seconds >= 86400
        AND NEW.budget_limit_seconds <= 27000 THEN 0
      ELSE reserved_seconds END)
    FROM gemini_physical_day_debits
    WHERE media_day = NEW.media_day), 0)
  + COALESCE((SELECT SUM(reserved_seconds) FROM gemini_physical_request_reservations
    WHERE media_day = NEW.media_day), 0)
  + NEW.reserved_seconds
) > MIN(86400, NEW.budget_limit_seconds)
BEGIN
  SELECT RAISE(ABORT, 'gemini physical media budget exhausted');
END;
