-- NCD cloud-first calendar storage and restrictive account-owner guards.
-- No user rows are removed or reassigned. Existing calendar data remains readable
-- from user_profile until its first normal sync writes calendar_events.
begin;
create table if not exists public.calendar_events (
 user_id uuid primary key references auth.users(id) on delete cascade,
 data jsonb not null default '{}'::jsonb check(jsonb_typeof(data)='object')
);
alter table public.calendar_events enable row level security;
revoke all on public.calendar_events from public, anon;
grant select,insert,update,delete on public.calendar_events to authenticated;
drop policy if exists ncd_calendar_owner on public.calendar_events;
create policy ncd_calendar_owner on public.calendar_events for all to authenticated
 using((select auth.uid())=user_id) with check((select auth.uid())=user_id);
-- Restrictive policies intersect existing permissive policies. They never grant
-- access to another account even if a legacy permissive policy is too broad.
do $$
declare target_table text; owner_column text;
begin
 foreach target_table in array array['goals','calendar_events','finance_transactions','safety_fund','user_profile','profiles'] loop
  if to_regclass('public.'||target_table) is null then continue; end if;
  owner_column := case when target_table='profiles' and exists(
   select 1 from information_schema.columns where table_schema='public' and information_schema.columns.table_name='profiles' and column_name='id' and data_type='uuid'
  ) then 'id' else 'user_id' end;
  if not exists(select 1 from information_schema.columns c where c.table_schema='public' and c.table_name=target_table and c.column_name=owner_column and c.data_type='uuid') then
   raise exception 'Missing UUID account owner column on public.%',target_table;
  end if;
  execute format('alter table public.%I enable row level security',target_table);
  execute format('drop policy if exists ncd_account_owner_guard on public.%I',target_table);
  execute format('create policy ncd_account_owner_guard on public.%I as restrictive for all to authenticated using((select auth.uid())=%I) with check((select auth.uid())=%I)',target_table,owner_column,owner_column);
 end loop;
end $$;
do $$ begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') and not exists(
  select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='calendar_events'
 ) then alter publication supabase_realtime add table public.calendar_events; end if;
end $$;
commit;
