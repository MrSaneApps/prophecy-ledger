PRAGMA foreign_keys = ON;

-- Decisive passage from each evidence source. Append-only tables forbid UPDATE
-- seeds here; fill excerpts via INSERT of new evidence rows or one-off ops.
ALTER TABLE evidence ADD COLUMN supporting_excerpt TEXT;
