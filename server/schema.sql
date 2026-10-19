-- Talabia database. Paste all of this in Supabase → SQL Editor → Run.

-- One row per seller: shop name, phone, plan and AI usage.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  shop text not null default '',
  phone text not null default '',
  plan text not null default 'free',      -- 'free' or 'pro'
  pro_until date,                         -- Pro ends after this date
  ai_month text not null default '',      -- e.g. 2026-10
  ai_used integer not null default 0,     -- AI reads used this month
  created_at timestamptz not null default now()
);

-- One row per seller: all their products and orders.
create table public.shop_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Each seller can only see their own rows.
alter table public.profiles enable row level security;
alter table public.shop_data enable row level security;

create policy "Sellers read their profile" on public.profiles
  for select using (auth.uid() = id);
-- No update policy on profiles: sellers cannot change their own plan.

create policy "Sellers read their data" on public.shop_data
  for select using (auth.uid() = user_id);
create policy "Sellers add their data" on public.shop_data
  for insert with check (auth.uid() = user_id);
create policy "Sellers update their data" on public.shop_data
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- When a seller signs up, create their profile and empty shop.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, shop, phone)
  values (new.id,
          coalesce(new.raw_user_meta_data->>'shop', ''),
          coalesce(new.raw_user_meta_data->>'phone', ''));
  insert into public.shop_data (user_id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
