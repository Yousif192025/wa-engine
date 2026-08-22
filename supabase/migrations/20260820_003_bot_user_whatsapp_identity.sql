-- Separate opaque WhatsApp identities (LID/JID) from true phone numbers.
-- This migration is additive and preserves all existing bot_users rows.

begin;

alter table public.bot_users
  add column if not exists whatsapp_identity text;

alter table public.bot_users
  alter column phone_number drop not null;

-- LID-derived legacy rows are not real phone numbers. Preserve their WhatsApp
-- identity in the new column and clear only the misused phone_number value.
update public.bot_users
set phone_number = null
where metadata -> 'whatsapp_identity' ->> 'kind' = 'lid'
  and nullif(metadata -> 'whatsapp_identity' ->> 'phone_number', '') is null;

-- Prefer the existing LID/JID metadata when present. Older phone-only rows get
-- a stable legacy identity derived from their existing real phone number.
update public.bot_users
set whatsapp_identity = case
  when nullif(metadata -> 'whatsapp_identity' ->> 'lid', '') is not null
    then 'lid:' || (metadata -> 'whatsapp_identity' ->> 'lid')
  when nullif(metadata -> 'whatsapp_identity' ->> 'jid', '') is not null
    then 'jid:' || (metadata -> 'whatsapp_identity' ->> 'jid')
  when phone_number is not null
    then 'legacy:phone:' || phone_number
  else 'legacy:user:' || id::text
end
where whatsapp_identity is null;

alter table public.bot_users
  alter column whatsapp_identity set not null;

alter table public.bot_users
  drop constraint if exists bot_users_phone_number_check;

-- [ + ] avoids ambiguous backslash escaping in standard SQL string literals.
alter table public.bot_users
  add constraint bot_users_phone_number_check
  check (phone_number is null or phone_number ~ '^[+]?[0-9]{6,20}$');

create unique index if not exists bot_users_whatsapp_identity_key
  on public.bot_users (whatsapp_identity);

commit;
