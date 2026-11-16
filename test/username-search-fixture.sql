-- Disposable local database; matches the supplied six-column profiles schema.
create role postgres superuser nologin;
create role authenticated nologin;
create role anon nologin;
create schema auth;
grant usage on schema auth to authenticated,anon;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create table auth.users(id uuid primary key);
insert into auth.users values('10000000-0000-4000-8000-000000000001'),('10000000-0000-4000-8000-000000000002'),('10000000-0000-4000-8000-000000000003');
create table public.profiles(id uuid primary key references auth.users(id),updated_at timestamptz,username text,avatar_url text,created_at timestamptz,short_id text);
alter table public.profiles enable row level security;
create policy "Users can manage own profile" on public.profiles for all to authenticated using(id=auth.uid()) with check(id=auth.uid());
grant select,insert,update on public.profiles to authenticated;
insert into public.profiles(id,username,short_id,avatar_url) values
 ('10000000-0000-4000-8000-000000000001','UniqueName','4821','https://private.invalid/avatar-a'),
 ('10000000-0000-4000-8000-000000000002','SameName','#4822','https://private.invalid/avatar-b'),
 ('10000000-0000-4000-8000-000000000003','SameName','AB123','https://private.invalid/avatar-c');
create table public.test_username_snapshot as select * from public.profiles;
