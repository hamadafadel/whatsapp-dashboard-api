-- Local review artifact ONLY. No existing table, queue or customer data is changed.
BEGIN;
CREATE TABLE IF NOT EXISTS public.whatsapp_template_media_files (
 id uuid PRIMARY KEY,
 format text NOT NULL CHECK (format IN ('IMAGE','VIDEO','DOCUMENT')),
 mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','video/mp4','application/pdf')),
 content bytea NOT NULL CHECK (octet_length(content)>0 AND octet_length(content)<=16777216),
 sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
 created_by text NOT NULL,
 source text NOT NULL CHECK (source IN ('upload','meta-sample')),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((format='IMAGE' AND mime_type IN ('image/jpeg','image/png') AND octet_length(content)<=5242880)
     OR (format='VIDEO' AND mime_type='video/mp4' AND octet_length(content)<=16777216)
     OR (format='DOCUMENT' AND mime_type='application/pdf')),
 UNIQUE(id,format)
);
CREATE TABLE IF NOT EXISTS public.whatsapp_template_media_defaults (
 template_id text NOT NULL CHECK (template_id ~ '^[0-9]{1,100}$'),
 language text NOT NULL,
 format text NOT NULL CHECK (format IN ('IMAGE','VIDEO','DOCUMENT')),
 file_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (template_id,language,format),
 FOREIGN KEY(file_id,format) REFERENCES public.whatsapp_template_media_files(id,format)
);
-- Immutable file URLs preserve the exact media in already-reviewed/queued sends.
-- The application role needs SELECT/INSERT on files and SELECT/INSERT/UPDATE on
-- defaults, not DELETE, TRUNCATE, ownership or schema CREATE. Grant separately
-- to the actual Backend role after review; do not guess its name here.
COMMIT;
