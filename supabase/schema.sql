-- Money Tracker — Supabase schema
-- Run this whole file once in: Supabase Dashboard > SQL Editor > New query > Run

create extension if not exists pgcrypto;

-- ---------- Tables ----------

create table public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  invite_code text not null unique default upper(substr(md5(random()::text), 1, 6)),
  created_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Someone',
  household_id uuid references public.households(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  tx_date date not null,
  merchant text not null,
  total numeric(12,2) not null,
  currency text not null default 'MYR',
  category text not null default 'Other',
  payment_method text,
  source text not null default 'manual', -- receipt | statement | manual
  items jsonb not null default '[]',
  notes text,
  created_at timestamptz not null default now()
);

create index transactions_user_date on public.transactions (user_id, tx_date desc);

create table public.budgets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category text not null,
  monthly_limit numeric(12,2) not null,
  unique (user_id, category)
);

-- ---------- Helper functions (security definer: bypass RLS safely) ----------

create or replace function public.my_household()
returns uuid language sql stable security definer set search_path = public as
$$ select household_id from profiles where id = auth.uid() $$;

create or replace function public.user_household(uid uuid)
returns uuid language sql stable security definer set search_path = public as
$$ select household_id from profiles where id = uid $$;

-- ---------- Row Level Security ----------

alter table public.households enable row level security;
alter table public.profiles enable row level security;
alter table public.transactions enable row level security;
alter table public.budgets enable row level security;

create policy "households: members read" on public.households
  for select using (id = public.my_household());

create policy "profiles: me + my household" on public.profiles
  for select using (
    id = auth.uid()
    or (public.my_household() is not null and household_id = public.my_household())
  );
create policy "profiles: update own" on public.profiles
  for update using (id = auth.uid());

create policy "transactions: mine + household" on public.transactions
  for select using (
    user_id = auth.uid()
    or (public.my_household() is not null
        and public.user_household(user_id) = public.my_household())
  );
create policy "transactions: insert own" on public.transactions
  for insert with check (user_id = auth.uid());
create policy "transactions: update own" on public.transactions
  for update using (user_id = auth.uid());
create policy "transactions: delete own" on public.transactions
  for delete using (user_id = auth.uid());

create policy "budgets: all own" on public.budgets
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------- Auto-create profile on signup ----------

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(nullif(new.raw_user_meta_data->>'display_name', ''), 'Someone'));
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Household RPCs (called from the app) ----------

create or replace function public.create_household(hname text)
returns json language plpgsql security definer set search_path = public as $$
declare h households;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  insert into households (name) values (trim(hname)) returning * into h;
  update profiles set household_id = h.id where id = auth.uid();
  return json_build_object('id', h.id, 'name', h.name, 'invite_code', h.invite_code);
end $$;

create or replace function public.join_household(code text)
returns json language plpgsql security definer set search_path = public as $$
declare h households;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into h from households where invite_code = upper(trim(code));
  if h.id is null then return null; end if;
  update profiles set household_id = h.id where id = auth.uid();
  return json_build_object('id', h.id, 'name', h.name, 'invite_code', h.invite_code);
end $$;

create or replace function public.leave_household()
returns void language sql security definer set search_path = public as
$$ update profiles set household_id = null where id = auth.uid() $$;
