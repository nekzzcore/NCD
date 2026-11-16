-- NCD onboarding handles. Apply once in the same Supabase project's SQL Editor.
-- Existing profiles, duplicate legacy names, RLS policies and user data are preserved.
begin;
create schema if not exists ncd_private;
revoke all on schema ncd_private from public, anon, authenticated;
create table if not exists ncd_private.auth_handles (
 user_id uuid primary key references auth.users(id) on delete cascade,
 handle text not null unique check (handle ~ '^[a-z][a-z0-9_]{2,31}$'),
 created_at timestamptz not null default now()
);
alter table ncd_private.auth_handles enable row level security;
revoke all on ncd_private.auth_handles from public, anon, authenticated;

-- Both deployed profile layouts (id/username and user_id/nickname) are supported.
create or replace function public.ncd_handle_available(candidate text)
returns boolean language plpgsql stable security definer
set search_path = pg_catalog, public, ncd_private
as $$
declare wanted text := lower(btrim(candidate));
begin
 if wanted is null or wanted !~ '^[a-z][a-z0-9_]{2,31}$' then return false; end if;
 return not exists(select 1 from ncd_private.auth_handles where handle=wanted)
  and not exists(select 1 from public.profiles p
   where lower(ltrim(btrim(coalesce(to_jsonb(p)->>'username',to_jsonb(p)->>'nickname','')),'@'))=wanted);
end $$;
revoke all on function public.ncd_handle_available(text) from public;
grant execute on function public.ncd_handle_available(text) to anon, authenticated;

-- The reservation and auth.users insert share one transaction. Concurrent signups
-- cannot claim the same case-insensitive handle even if both availability checks pass.
create or replace function ncd_private.claim_auth_handle()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, ncd_private
as $$
declare wanted text := lower(btrim(new.raw_user_meta_data->>'ncd_handle'));
begin
 if wanted is null or wanted='' then return new; end if;
 if wanted !~ '^[a-z][a-z0-9_]{2,31}$' then
  raise exception using errcode='22023', message='ncd_handle_invalid';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('ncd-handle:'||wanted,0));
 if exists(select 1 from public.profiles p
  where lower(ltrim(btrim(coalesce(to_jsonb(p)->>'username',to_jsonb(p)->>'nickname','')),'@'))=wanted
   and coalesce(to_jsonb(p)->>'id',to_jsonb(p)->>'user_id')<>new.id::text) then
  raise exception using errcode='23505', message='ncd_handle_taken';
 end if;
 insert into ncd_private.auth_handles(user_id,handle) values(new.id,wanted);
 return new;
end $$;
revoke all on function ncd_private.claim_auth_handle() from public, anon, authenticated;
drop trigger if exists ncd_claim_auth_handle on auth.users;
create trigger ncd_claim_auth_handle after insert on auth.users
 for each row execute function ncd_private.claim_auth_handle();

-- Legacy profile edits must not take a newly registered handle. Registered handles
-- follow their owner's later profile rename; existing duplicate names are untouched.
create or replace function ncd_private.guard_profile_handle()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, ncd_private
as $$
declare
 wanted text := lower(ltrim(btrim(coalesce(to_jsonb(new)->>'username',to_jsonb(new)->>'nickname','')),'@'));
 uid uuid := coalesce(to_jsonb(new)->>'id',to_jsonb(new)->>'user_id')::uuid;
 previous_name text;
begin
 if tg_op='UPDATE' then
  previous_name := lower(ltrim(btrim(coalesce(to_jsonb(old)->>'username',to_jsonb(old)->>'nickname','')),'@'));
  if wanted=previous_name then return new; end if;
 end if;
 if wanted='' then return new; end if;
 perform pg_advisory_xact_lock(hashtextextended('ncd-handle:'||wanted,0));
 if exists(select 1 from ncd_private.auth_handles where handle=wanted and user_id<>uid) then
  raise exception using errcode='23505', message='ncd_handle_taken';
 end if;
 if exists(select 1 from ncd_private.auth_handles where user_id=uid) then
  if wanted !~ '^[a-z][a-z0-9_]{2,31}$' then
   raise exception using errcode='22023', message='ncd_handle_invalid';
  end if;
  if exists(select 1 from public.profiles p
   where lower(ltrim(btrim(coalesce(to_jsonb(p)->>'username',to_jsonb(p)->>'nickname','')),'@'))=wanted
    and coalesce(to_jsonb(p)->>'id',to_jsonb(p)->>'user_id')<>uid::text) then
   raise exception using errcode='23505', message='ncd_handle_taken';
  end if;
  update ncd_private.auth_handles set handle=wanted where user_id=uid;
 end if;
 return new;
end $$;
revoke all on function ncd_private.guard_profile_handle() from public, anon, authenticated;
drop trigger if exists ncd_guard_profile_handle on public.profiles;
create trigger ncd_guard_profile_handle before insert or update on public.profiles
 for each row execute function ncd_private.guard_profile_handle();
commit;
