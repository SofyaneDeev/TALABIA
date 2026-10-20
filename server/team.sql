-- Talabia Pro: team access. Paste in Supabase → SQL Editor → Run (once).
-- An owner with an active Pro plan adds helpers by phone number.
-- A helper logs in with that number and works on the owner's shop.

create table public.team_members (
  owner_id uuid not null references auth.users(id) on delete cascade,
  member_phone text not null,
  name text not null default '',
  created_at timestamptz not null default now(),
  primary key (owner_id, member_phone)
);
alter table public.team_members enable row level security;

-- The phone number of the person calling (accounts log in as <phone>@talabia.app).
create or replace function public.my_phone()
returns text language sql stable
as $$ select split_part(coalesce(auth.jwt()->>'email', ''), '@', 1) $$;

-- Is this owner's Pro plan active?
create or replace function public.owner_is_pro(o uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.profiles
                      where id = o and plan = 'pro'
                        and (pro_until is null or pro_until >= current_date)) $$;

-- Owner manages their team (adding needs Pro).
create policy "Owner reads team" on public.team_members
  for select using (owner_id = auth.uid());
create policy "Owner adds helpers" on public.team_members
  for insert with check (owner_id = auth.uid() and public.owner_is_pro(auth.uid()));
create policy "Owner removes helpers" on public.team_members
  for delete using (owner_id = auth.uid());

-- Helper sees their membership and can leave.
create policy "Helper reads membership" on public.team_members
  for select using (member_phone = public.my_phone());
create policy "Helper leaves" on public.team_members
  for delete using (member_phone = public.my_phone());

-- Helpers use the owner's shop while the owner's Pro is active.
create policy "Helpers read the shop" on public.shop_data
  for select using (
    exists (select 1 from public.team_members t
            where t.owner_id = shop_data.user_id and t.member_phone = public.my_phone())
    and public.owner_is_pro(shop_data.user_id));
create policy "Helpers update the shop" on public.shop_data
  for update using (
    exists (select 1 from public.team_members t
            where t.owner_id = shop_data.user_id and t.member_phone = public.my_phone())
    and public.owner_is_pro(shop_data.user_id))
  with check (
    exists (select 1 from public.team_members t
            where t.owner_id = shop_data.user_id and t.member_phone = public.my_phone())
    and public.owner_is_pro(shop_data.user_id));

-- Helpers can read the owner's shop name and plan.
create policy "Helpers read the owner's profile" on public.profiles
  for select using (
    exists (select 1 from public.team_members t
            where t.owner_id = profiles.id and t.member_phone = public.my_phone()));
