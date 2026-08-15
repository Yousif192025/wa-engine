-- Baileys session persistence for wa-engine.
-- This migration only ADDS two tables. It does not alter or delete existing bot tables.
-- Auth payloads are encrypted by the application with AES-256-GCM before insertion.
-- Apply after 20260815_001_bot_engine.sql.

create table if not exists public.whatsapp_auth_state (
  account_id text not null default 'default'
    check (account_id ~ '^[a-zA-Z0-9_-]{1,80}$'),
  auth_category text not null
    check (auth_category in ('creds', 'keys')),
  auth_key_id text not null
    check (char_length(auth_key_id) between 1 and 500),
  encrypted_value jsonb not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (account_id, auth_category, auth_key_id)
);

create table if not exists public.whatsapp_connection_state (
  account_id text primary key default 'default'
    check (account_id ~ '^[a-zA-Z0-9_-]{1,80}$'),
  status text not null default 'disconnected'
    check (status in ('disconnected', 'connecting', 'qr_pending', 'connected', 'logged_out', 'error')),
  connected_jid text,
  last_qr_at timestamptz,
  last_connected_at timestamptz,
  last_disconnect_at timestamptz,
  last_error text,
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists whatsapp_connection_state_status_updated_at_idx
  on public.whatsapp_connection_state (status, updated_at desc);

drop trigger if exists whatsapp_auth_state_set_updated_at on public.whatsapp_auth_state;
create trigger whatsapp_auth_state_set_updated_at
before update on public.whatsapp_auth_state
for each row execute function public.set_updated_at();

drop trigger if exists whatsapp_connection_state_set_updated_at on public.whatsapp_connection_state;
create trigger whatsapp_connection_state_set_updated_at
before update on public.whatsapp_connection_state
for each row execute function public.set_updated_at();

-- No public RLS policies are created. The server-only Supabase service-role key
-- used by wa-engine bypasses RLS; browser clients have no access.
alter table public.whatsapp_auth_state enable row level security;
alter table public.whatsapp_connection_state enable row level security;
