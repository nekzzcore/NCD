-- GoalTracker Pro, dedicated Supabase project. Review before running in SQL Editor.
-- One JSON document per owner/domain preserves nested goals and legacy metadata.
begin;
create table if not exists public.profiles (
 user_id uuid primary key references auth.users(id) on delete cascade,
 nickname text not null default '', revision bigint not null default 0,
 last_request uuid, extra jsonb not null default '{}'::jsonb,
 updated_at timestamptz not null default now()
);
create table if not exists public.goals (
 user_id uuid primary key references auth.users(id) on delete cascade,
 data jsonb not null default '[]'::jsonb check (jsonb_typeof(data) = 'array')
);
create table if not exists public.finance_transactions (
 user_id uuid primary key references auth.users(id) on delete cascade,
 data jsonb not null default '[]'::jsonb check (jsonb_typeof(data) = 'array')
);
create table if not exists public.safety_fund (
 user_id uuid primary key references auth.users(id) on delete cascade,
 data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object')
);
create table if not exists public.user_profile (
 user_id uuid primary key references auth.users(id) on delete cascade,
 data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object')
);
do $$
declare t text;
begin
 foreach t in array array['profiles','goals','finance_transactions','safety_fund','user_profile'] loop
  if exists(select 1 from pg_policies where schemaname='public' and tablename=t and policyname<>'goaltracker_owner') then raise exception 'Existing policies on %: review manually before migration',t; end if;
  execute format('alter table public.%I enable row level security',t);
  execute format('alter table public.%I force row level security',t);
  execute format('revoke all on public.%I from anon',t);
  execute format('revoke all on public.%I from authenticated',t);
  execute format('grant select, insert, update on public.%I to authenticated',t);
  execute format('drop policy if exists goaltracker_owner on public.%I',t);
  execute format('create policy goaltracker_owner on public.%I for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)',t);
 end loop;
end; $$;

create or replace function public.goaltracker_read_state()
returns jsonb language sql stable security invoker set search_path = '' as $$
 select jsonb_build_object('revision',coalesce(p.revision,0),'state',jsonb_build_object(
  'goals',coalesce(g.data,'[]'::jsonb),
  'transactions',coalesce(f.data,'[]'::jsonb),
  'safetyFund',coalesce(s.data,'{}'::jsonb),
  'profile',coalesce(u.data,case when p.user_id is null then '{}'::jsonb else jsonb_build_object('nickname',p.nickname) end),
  'financeOther',coalesce(p.extra->'financeOther','{}'::jsonb),
  'calendar',coalesce(p.extra->'calendar','{}'::jsonb)))
 from (select auth.uid() as uid) a
 left join public.profiles p on p.user_id=a.uid
 left join public.goals g on g.user_id=a.uid
 left join public.finance_transactions f on f.user_id=a.uid
 left join public.safety_fund s on s.user_id=a.uid
 left join public.user_profile u on u.user_id=a.uid
 where a.uid is not null;
$$;

create or replace function public.goaltracker_write_state(expected_revision bigint,next_state jsonb,request_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare owner_id uuid := auth.uid(); current_revision bigint; previous_request uuid;
begin
 if owner_id is null then raise insufficient_privilege using message='Authentication required'; end if;
 if expected_revision is null or expected_revision < 0 or request_id is null or jsonb_typeof(next_state) is distinct from 'object'
  or jsonb_typeof(next_state->'goals') is distinct from 'array'
  or jsonb_typeof(next_state->'transactions') is distinct from 'array'
  or jsonb_typeof(next_state->'safetyFund') is distinct from 'object'
  or jsonb_typeof(next_state->'profile') is distinct from 'object'
  or jsonb_typeof(next_state->'financeOther') is distinct from 'object'
  or jsonb_typeof(next_state->'calendar') is distinct from 'object'
 then raise exception 'Invalid state'; end if;
 insert into public.profiles(user_id) values(owner_id) on conflict(user_id) do nothing;
 select revision,last_request into current_revision,previous_request from public.profiles where user_id=owner_id for update;
 if previous_request=request_id then return jsonb_build_object('revision',current_revision); end if;
 if current_revision<>expected_revision then raise exception using errcode='40001',message='Concurrent update; reread state'; end if;
 insert into public.goals(user_id,data) values(owner_id,next_state->'goals') on conflict(user_id) do update set data=excluded.data;
 insert into public.finance_transactions(user_id,data) values(owner_id,next_state->'transactions') on conflict(user_id) do update set data=excluded.data;
 insert into public.safety_fund(user_id,data) values(owner_id,next_state->'safetyFund') on conflict(user_id) do update set data=excluded.data;
 insert into public.user_profile(user_id,data) values(owner_id,next_state->'profile') on conflict(user_id) do update set data=excluded.data;
 update public.profiles set nickname=coalesce(next_state->'profile'->>'nickname',''),revision=current_revision+1,last_request=request_id,
  extra=jsonb_build_object('financeOther',next_state->'financeOther','calendar',next_state->'calendar'),updated_at=now() where user_id=owner_id;
 return jsonb_build_object('revision',current_revision+1);
end;
$$;
revoke all on function public.goaltracker_read_state() from public,anon;
revoke all on function public.goaltracker_write_state(bigint,jsonb,uuid) from public,anon;
grant execute on function public.goaltracker_read_state() to authenticated;
grant execute on function public.goaltracker_write_state(bigint,jsonb,uuid) to authenticated;
commit;
