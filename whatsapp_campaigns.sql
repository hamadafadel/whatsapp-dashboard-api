-- LOCAL REVIEW ONLY. Run explicitly after a backup, never from server startup.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = pg_catalog, public;
DO $$ DECLARE requirement record; BEGIN
  IF current_setting('server_version_num')::integer < 180000 THEN
    RAISE EXCEPTION 'PostgreSQL 18 or later required for this reviewed release';
  END IF;
  -- Fail BEFORE creating anything. Never repair or replace an existing installation.
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND (c.relname LIKE 'whatsapp_contact_%'
      OR c.relname LIKE 'whatsapp_template_campaign%' OR c.relname LIKE 'whatsapp_template_delivery%'
      OR c.relname LIKE 'whatsapp_campaign_%' OR c.relname='whatsapp_template_status_inbox'
      OR c.relname IN ('dashboard_send_queue_campaign_pacing','dashboard_send_queue_dynamic_history'))) THEN
    RAISE EXCEPTION 'Campaign object already exists; fresh-install migration stopped';
  END IF;
  FOR requirement IN SELECT * FROM (VALUES
    ('dashboard_send_queue','id','uuid'),('dashboard_send_queue','session_id','text'),
    ('dashboard_send_queue','owner_name','text'),('dashboard_send_queue','request_id','text'),
    ('dashboard_send_queue','payload','jsonb'),('dashboard_send_queue','result','jsonb'),
    ('dashboard_send_queue','state','text'),('dashboard_send_queue','created_at','timestamp with time zone'),
    ('dashboard_send_queue','updated_at','timestamp with time zone'),
    ('conversation_labels','id','integer'),('conversation_labels','name','text'),('conversation_labels','color','text'),
    ('conversation_label_assignments','session_id','text'),('conversation_label_assignments','label_id','integer'),
    ('chat_memory','id','integer'),('chat_memory','message','jsonb'),('chat_memory','created_at','timestamp with time zone'),
    ('chat_sessions','session_id','text'),('chat_sessions','ai_enabled','boolean'),
    ('chat_sessions','last_read_message_id','bigint'),('chat_sessions','hidden','boolean')
  ) AS expected(table_name,column_name,column_type) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
      AND c.relname=requirement.table_name AND c.relkind='r'
      AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
      AND a.attname=requirement.column_name AND a.attnum>0 AND NOT a.attisdropped
      AND format_type(a.atttypid,a.atttypmod)=requirement.column_type) THEN
      RAISE EXCEPTION 'Dependency type or RLS mismatch: %.%',requirement.table_name,requirement.column_name;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.chat_memory')
    AND attname='session_id' AND NOT attisdropped AND atttypid IN ('text'::regtype,'varchar'::regtype)) THEN
    RAISE EXCEPTION 'chat_memory.session_id must be text or varchar';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_index i JOIN pg_class x ON x.oid=i.indexrelid JOIN pg_am am ON am.oid=x.relam
    JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=i.indkey[0]
    JOIN pg_attribute b ON b.attrelid=i.indrelid AND b.attnum=i.indkey[1]
    WHERE i.indrelid='public.chat_memory'::regclass AND i.indisvalid AND i.indisready
      AND i.indpred IS NULL AND i.indexprs IS NULL AND am.amname='btree' AND a.attname='session_id' AND b.attname='id') THEN
    RAISE EXCEPTION 'Existing chat_memory(session_id,id) btree index required for bounded campaign queries';
  END IF;
END $$;

-- Separate consent ledger: Labels are never evidence of permission to contact.
CREATE TABLE public.whatsapp_contact_permissions (
  phone text PRIMARY KEY CHECK (phone ~ '^[1-9][0-9]{6,14}$'),
  status text NOT NULL CHECK (status IN ('granted','withdrawn')),
  categories text[] NOT NULL CHECK (categories <@ ARRAY['MARKETING','UTILITY','AUTHENTICATION']::text[] AND cardinality(categories)>0),
  evidence text NOT NULL CHECK (length(evidence) BETWEEN 5 AND 1000),
  recorded_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.whatsapp_contact_permission_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  phone text NOT NULL, status text NOT NULL, categories text[] NOT NULL,
  evidence text NOT NULL, recorded_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON public.whatsapp_contact_permission_audit(phone, id DESC);

CREATE TABLE public.whatsapp_template_campaigns (
  id uuid PRIMARY KEY, owner_name text NOT NULL, request_id uuid NOT NULL,
  fingerprint text NOT NULL, title text NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
  template jsonb NOT NULL, revision text NOT NULL,
  state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','running','paused','completed','cancelled')),
  interval_ms integer NOT NULL DEFAULT 2000 CHECK(interval_ms BETWEEN 1000 AND 60000),
  is_bulk boolean NOT NULL DEFAULT false,
  next_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz, UNIQUE(owner_name,request_id)
);
CREATE TABLE public.whatsapp_template_campaign_recipients (
  id uuid PRIMARY KEY, campaign_id uuid NOT NULL REFERENCES public.whatsapp_template_campaigns(id),
  phone text NOT NULL CHECK(phone ~ '^[1-9][0-9]{6,14}$'), name text NOT NULL DEFAULT '',
  sources jsonb NOT NULL DEFAULT '[]', values jsonb NOT NULL DEFAULT '{}',
  eligible boolean NOT NULL, reason text,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','queued','sent','failed','unknown','excluded')),
  queue_request_id uuid NOT NULL UNIQUE, queue_job_id uuid, message_id text,
  updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(campaign_id,phone)
);
CREATE INDEX ON public.whatsapp_template_campaign_recipients(campaign_id,state);
CREATE INDEX ON public.whatsapp_template_campaign_recipients(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX whatsapp_campaign_recipients_phone ON public.whatsapp_template_campaign_recipients(phone,campaign_id);
-- Canonical message metadata is written by the existing sender SQL from trusted queue rows.
CREATE UNIQUE INDEX whatsapp_campaign_message_recipient ON public.chat_memory((message->>'campaign_recipient_id'))
  WHERE message->>'campaign_recipient_id' IS NOT NULL;
-- Reuse the existing idx_chat_memory_user_session_id_desc partial index.
CREATE INDEX whatsapp_campaign_sent_by_phone ON public.chat_memory(session_id,id) WHERE message->>'campaign_recipient_id' IS NOT NULL;
CREATE INDEX whatsapp_campaign_normal_sessions ON public.chat_memory(session_id,id DESC)
  WHERE NOT(COALESCE(message->>'type','')='agent' AND COALESCE(message->>'campaign_bulk','false')='true');
CREATE INDEX dashboard_send_queue_campaign_pacing ON public.dashboard_send_queue(created_at DESC) WHERE payload ? 'campaignRecipientId';
CREATE INDEX dashboard_send_queue_dynamic_history ON public.dashboard_send_queue(created_at DESC) WHERE payload ? 'dynamicTemplate';
-- May precede the send acknowledgement. Never synthesize delivery from HTTP 200.
CREATE TABLE public.whatsapp_template_delivery_events (
  message_id text NOT NULL, phone text NOT NULL, status text NOT NULL CHECK(status IN ('sent','delivered','read','failed')),
  event_at timestamptz NOT NULL, error_code integer,
  PRIMARY KEY(message_id,phone,status,event_at)
);
-- Durable receipt intake; no message bodies, tokens or send commands.
CREATE TABLE public.whatsapp_template_status_inbox (
  message_id text NOT NULL, phone text NOT NULL CHECK(phone ~ '^[1-9][0-9]{6,14}$'),
  status text NOT NULL CHECK(status IN ('sent','delivered','read','failed')),
  event_at timestamptz NOT NULL, error_code integer,
  received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
  PRIMARY KEY(message_id,phone,status,event_at)
);
CREATE INDEX whatsapp_campaign_pending_receipts ON public.whatsapp_template_status_inbox(received_at) WHERE processed_at IS NULL;
COMMIT;
-- Rollback: disable WHATSAPP_CAMPAIGNS_ENABLED and WHATSAPP_CAMPAIGNS_WORKER_ENABLED,
-- stop the campaign scheduler; preserve these tables and the existing queue for audit.
-- Do not drop tables or reset unknown/claimed operations. No existing data/Labels modified.
