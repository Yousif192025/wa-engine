-- wa-engine production storage for the standalone Gemini + Wassenger bot runtime.
-- Apply this migration in the Supabase SQL editor or through the Supabase CLI.

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table if not exists public.bot_users (
  id uuid primary key default gen_random_uuid(),
  phone_number text not null unique check (phone_number ~ '^\\+?[0-9]{6,20}$'),
  display_name text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.bot_users(id) on delete cascade,
  external_chat_id text not null unique,
  language text not null default 'ar' check (language in ('ar', 'en')),
  status text not null default 'active' check (status in ('active', 'human_handoff', 'closed')),
  summary text,
  summary_updated_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  external_message_id text not null unique,
  direction text not null check (direction in ('inbound', 'outbound')),
  message_type text not null check (message_type in ('text', 'document', 'image', 'audio', 'unsupported')),
  content text not null,
  language text not null check (language in ('ar', 'en')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.bot_users(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  external_media_id text unique,
  filename text not null,
  mime_type text not null check (mime_type in (
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  )),
  size_bytes integer check (size_bytes is null or size_bytes >= 0),
  extracted_text text not null,
  processing_status text not null default 'processed' check (processing_status in ('processed', 'failed')),
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.knowledge_base (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  content text not null,
  category text,
  source_url text,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  search_vector tsvector generated always as (
    to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(content, ''))
  ) stored,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.bot_settings (
  key text primary key check (key ~ '^[a-z0-9_]{1,100}$'),
  value jsonb not null,
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  external_event_id text not null unique,
  event_type text not null,
  status text not null check (status in ('processing', 'completed', 'failed')),
  error_message text,
  received_at timestamptz not null default timezone('utc', now()),
  processed_at timestamptz
);

create index if not exists conversations_user_id_updated_at_idx on public.conversations (user_id, updated_at desc);
create index if not exists messages_conversation_created_at_idx on public.messages (conversation_id, created_at desc);
create index if not exists messages_external_message_id_idx on public.messages (external_message_id);
create index if not exists documents_conversation_id_created_at_idx on public.documents (conversation_id, created_at desc);
create index if not exists knowledge_base_active_category_idx on public.knowledge_base (is_active, category);
create index if not exists knowledge_base_search_vector_idx on public.knowledge_base using gin (search_vector);
create index if not exists webhook_events_status_received_at_idx on public.webhook_events (status, received_at);

create or replace trigger bot_users_set_updated_at
before update on public.bot_users
for each row execute function public.set_updated_at();

create or replace trigger conversations_set_updated_at
before update on public.conversations
for each row execute function public.set_updated_at();

create or replace trigger knowledge_base_set_updated_at
before update on public.knowledge_base
for each row execute function public.set_updated_at();

create or replace trigger bot_settings_set_updated_at
before update on public.bot_settings
for each row execute function public.set_updated_at();

-- The bot uses a server-only service-role key. Keep all runtime tables closed to
-- browser clients; future admin UI access must add narrow, authenticated RLS policies.
alter table public.bot_users enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.documents enable row level security;
alter table public.knowledge_base enable row level security;
alter table public.bot_settings enable row level security;
alter table public.webhook_events enable row level security;

insert into public.bot_settings (key, value)
values
  ('fallback_message_ar', '"عذرًا، أواجه مشكلة مؤقتة في خدمة الرد الذكي. يرجى المحاولة مرة أخرى لاحقًا."'::jsonb),
  ('fallback_message_en', '"Sorry, I am having a temporary issue with the support service. Please try again later."'::jsonb)
on conflict (key) do nothing;

-- Optional future vector retrieval. Enable only after selecting an embedding
-- model and using its exact dimensionality consistently for all rows and queries.
-- create extension if not exists vector with schema extensions;
-- alter table public.knowledge_base add column embedding extensions.vector(<dimensions>);
-- create index knowledge_base_embedding_hnsw_idx on public.knowledge_base using hnsw (embedding vector_cosine_ops);
