-- Manual rollback for 20260815_002_baileys_session_state.sql.
-- WARNING: This permanently deletes only encrypted Baileys auth state and
-- non-sensitive connection-state history. Existing bot tables are untouched.

begin;

drop table if exists public.whatsapp_connection_state;
drop table if exists public.whatsapp_auth_state;

commit;
