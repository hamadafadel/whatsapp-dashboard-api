-- REVIEW ONLY. Run only after actual roles are confirmed and explicit grant approval.
-- psql -v api_role=ACTUAL_EXISTING_ROLE -v n8n_role=ACTUAL_EXISTING_ROLE
-- Never use this file for codex_mcp_readonly; no role creation, ownership or schema CREATE.
\set ON_ERROR_STOP on
BEGIN;
GRANT USAGE ON SCHEMA public TO :"api_role", :"n8n_role";
GRANT SELECT,INSERT,UPDATE ON public.whatsapp_contact_permissions,
 public.whatsapp_template_campaigns,public.whatsapp_template_campaign_recipients,
 public.whatsapp_template_status_inbox TO :"api_role";
GRANT SELECT,INSERT ON public.whatsapp_contact_permission_audit,
 public.whatsapp_template_delivery_events TO :"api_role";
GRANT USAGE ON SEQUENCE public.whatsapp_contact_permission_audit_id_seq TO :"api_role";
GRANT SELECT ON public.whatsapp_template_campaigns,public.whatsapp_template_campaign_recipients TO :"n8n_role";
GRANT INSERT ON public.whatsapp_template_status_inbox TO :"n8n_role";
GRANT SELECT(message_id) ON public.whatsapp_template_status_inbox TO :"n8n_role";
COMMIT;
