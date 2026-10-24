-- Seller email for password reset (applied 2026-10-24)
alter table public.profiles add column if not exists email text not null default '';
alter table public.profiles add column if not exists reset_sent_at timestamptz;
alter table public.profiles add constraint profiles_email_len check (char_length(email) <= 254);
create unique index if not exists profiles_email_unique on public.profiles (lower(email)) where email <> '';
-- handle_new_user() now also copies raw_user_meta_data->>'email' (lowercased, only if valid and not used by another shop).
