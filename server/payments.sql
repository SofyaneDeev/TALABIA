-- Talabia: Pro payments with receipt + admin (already applied to the live project on 2026-10-21).
-- Keep this file as a record; run it only on a NEW Supabase project.
create table if not exists public.app_admins (user_id uuid primary key references auth.users(id) on delete cascade);
alter table public.app_admins enable row level security;
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as
$$ select exists (select 1 from public.app_admins where user_id = auth.uid()) $$;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;
create table if not exists public.pay_requests (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  phone text not null default '', shop text not null default '',
  months int not null check (months between 1 and 12),
  amount int not null check (amount between 0 and 100000),
  method text not null check (method in ('cashplus','bank','wafacash','other')),
  reference text not null default '' check (length(reference) <= 80),
  receipt_path text not null default '' check (length(receipt_path) <= 300),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  admin_note text not null default '' check (length(admin_note) <= 300),
  created_at timestamptz not null default now(), decided_at timestamptz);
alter table public.pay_requests enable row level security;
create policy "Sellers read their payments" on public.pay_requests for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy "Sellers send a payment" on public.pay_requests for insert to authenticated
  with check (user_id = auth.uid() and status = 'pending' and admin_note = '' and decided_at is null
              and not exists (select 1 from public.pay_requests p where p.user_id = auth.uid() and p.status = 'pending'));
create policy "Admin reads all profiles" on public.profiles for select to authenticated using (public.is_admin());
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts','receipts',false,5242880,array['image/jpeg','image/png','image/webp']) on conflict (id) do nothing;
create policy "Sellers upload their receipts" on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "Sellers and admin see receipts" on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));
-- admin_set_pro(phone, months) and admin_decide(id, approve, note): see the live project (Database → Functions).
-- Make yourself admin:  insert into public.app_admins (user_id) select id from public.profiles where phone = '06XXXXXXXX';
