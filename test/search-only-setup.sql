-- Disposable local test database only. No real emails/passwords.
create role postgres superuser nologin;
alter table public.profiles add column avatar_public boolean not null default false;
update public.profiles set nickname=case when user_id='10000000-0000-4000-8000-000000000001' then 'UniqueName' else 'SameName' end,
 avatar_public=(user_id='10000000-0000-4000-8000-000000000002');
create table public.search_only_before as select user_id,to_jsonb(p) as data from public.profiles p;
