PRAGMA foreign_keys = ON;

-- Conservative pre-call reservations keep adversarial review below
-- Cloudflare Workers AI's 10,000-neuron daily free allocation. Reservations
-- are retained even when a provider call fails so retries cannot create spend.
CREATE TABLE IF NOT EXISTS workers_ai_neuron_reservations (
  reservation_id TEXT PRIMARY KEY,
  usage_day TEXT NOT NULL,
  claim_id TEXT NOT NULL REFERENCES claims(claim_id),
  role TEXT NOT NULL CHECK (role IN ('critic','judge')),
  model_name TEXT NOT NULL,
  reserved_neurons INTEGER NOT NULL CHECK (reserved_neurons BETWEEN 1 AND 7800),
  limit_neurons INTEGER NOT NULL CHECK (limit_neurons BETWEEN 1 AND 7800),
  created_at TEXT NOT NULL,
  UNIQUE(usage_day, claim_id, role)
);

CREATE INDEX IF NOT EXISTS workers_ai_neuron_reservations_day
  ON workers_ai_neuron_reservations(usage_day, created_at);

CREATE TRIGGER IF NOT EXISTS workers_ai_neuron_budget_guard
BEFORE INSERT ON workers_ai_neuron_reservations
WHEN COALESCE((SELECT SUM(reserved_neurons)
  FROM workers_ai_neuron_reservations WHERE usage_day=NEW.usage_day),0)
  + NEW.reserved_neurons > MIN(7800, NEW.limit_neurons)
BEGIN SELECT RAISE(ABORT, 'workers ai free neuron budget exhausted'); END;

CREATE TRIGGER IF NOT EXISTS workers_ai_neuron_reservations_no_update
BEFORE UPDATE ON workers_ai_neuron_reservations BEGIN
  SELECT RAISE(ABORT, 'workers ai neuron reservations are append-only');
END;

CREATE TRIGGER IF NOT EXISTS workers_ai_neuron_reservations_no_delete
BEFORE DELETE ON workers_ai_neuron_reservations BEGIN
  SELECT RAISE(ABORT, 'workers ai neuron reservations are append-only');
END;
