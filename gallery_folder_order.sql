-- Manual application only. Uses the existing Backend PostgreSQL connection.
-- Run as the Backend DB_USER (or grant it SELECT, INSERT, UPDATE afterwards).
-- No existing tables, messages or Drive files are modified.
BEGIN;
CREATE TABLE public.gallery_folder_order (
  folder_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'custom' CHECK (mode IN ('custom', 'alphabetical')),
  file_ids TEXT[] NOT NULL DEFAULT '{}'::text[],
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMIT;
