PRAGMA foreign_keys = ON;

-- Citation locators. Schema-only in the migration lane so append-only triggers
-- stay honest in fresh DBs / tests. Live excerpt/page seeds are ops work.
ALTER TABLE evidence ADD COLUMN source_page INTEGER;
ALTER TABLE public_research_references ADD COLUMN supporting_excerpt TEXT;
ALTER TABLE public_research_references ADD COLUMN source_page INTEGER;
