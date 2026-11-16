-- REVIEW FIRST. Do not run on production without explicit approval.
-- Public alias @name, reusing public_tag as the single storage field.
-- Works before or after the earlier public-tags draft; no user data is deleted.
-- Incremental migration for the current user_id-based schema + social.sql.
-- Preserves ALL existing profiles/friendships RLS policies, including
-- "Users can manage own profile". Does not run schema.sql or drop any table.
begin;
do $$ begin
 if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='user_id')
 or to_regclass('public.friendships') is null or to_regclass('public.user_profile') is null
 or to_regprocedure('public.social_search(text)') is null
 or to_regprocedure('public.social_respond(uuid,boolean)') is null then
  raise exception 'PUBLIC_TAG_SCHEMA_MISMATCH: expected profiles.user_id and the existing social module. Review schema; do not rerun schema.sql.';
 end if;
 if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('profiles','friendships') and not c.relrowsecurity) then
  raise exception 'PUBLIC_TAG_RLS_REQUIRED: existing profiles/friendships RLS must already be enabled. Review policies first.';
 end if;
end $$;
alter table public.profiles add column if not exists public_tag text;
alter table public.profiles add column if not exists public_display_name text not null default 'Игрок';
alter table public.profiles add column if not exists avatar_public boolean not null default false;
alter table public.profiles add column if not exists public_tag_custom boolean not null default false;
create unique index if not exists profiles_public_tag_unique on public.profiles(lower(public_tag));
-- Restrictive guards intersect existing policies; no existing policy is removed.
do $$ begin
 if not exists(select 1 from pg_policies where schemaname='public' and tablename='profiles' and policyname='public_tags_profiles_owner_guard') then
  create policy public_tags_profiles_owner_guard on public.profiles as restrictive for all to authenticated
   using((select auth.uid())=user_id) with check((select auth.uid())=user_id);
 end if;
 if not exists(select 1 from pg_policies where schemaname='public' and tablename='friendships' and policyname='public_tags_friendships_scope') then
  create policy public_tags_friendships_scope on public.friendships as restrictive for select to authenticated
   using((select auth.uid()) in(requester_id,recipient_id));
 end if;
end $$;
-- All friendship mutations must pass the throttled RPC, even if an earlier
-- installation granted direct table/column writes. Existing SELECT stays intact.
revoke insert,update,delete on public.friendships from public,anon,authenticated;
do $$ declare columns text; begin
 select string_agg(quote_ident(column_name),',') into columns from information_schema.columns
 where table_schema='public' and table_name='friendships';
 execute 'revoke insert ('||columns||'),update ('||columns||') on public.friendships from public,anon,authenticated';
end $$;
revoke select on public.profiles from public,anon;
create schema if not exists goaltracker_private;
revoke all on schema goaltracker_private from public,anon,authenticated;
create or replace function goaltracker_private.normalize_tag(value text)
returns text language sql immutable set search_path='' as $$
 select regexp_replace(lower(btrim(value)), '^@', '');
$$;
-- Stop only the generator introduced by the earlier draft. Existing values stay.
drop trigger if exists goaltracker_assign_public_tag on public.profiles;
alter table public.profiles alter column public_tag drop not null;
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='public.profiles'::regclass and conname='profiles_public_tag_format') then
  alter table public.profiles add constraint profiles_public_tag_format check (public_tag ~ '^[a-z][a-z0-9_]{2,39}$');
 end if;
 if not exists(select 1 from pg_constraint where conrelid='public.profiles'::regclass and conname='profiles_public_display_name_format') then
  alter table public.profiles add constraint profiles_public_display_name_format check (length(btrim(public_display_name)) between 2 and 32 and public_display_name !~ '[@[:cntrl:]]');
 end if;
end $$;
-- Keep existing owner-only RLS. Limit direct writes so RPC validation/rate limits
-- cannot be bypassed by changing the new fields through the REST table endpoint.
revoke insert,update on public.profiles from public,anon,authenticated;
do $$ declare columns text; begin
 select string_agg(quote_ident(column_name),',') into columns from information_schema.columns
 where table_schema='public' and table_name='profiles' and column_name not in ('public_tag','public_display_name','avatar_public','public_tag_custom')
 and is_generated='NEVER';
 execute 'grant insert (' || columns || '),update (' || columns || ') on public.profiles to authenticated';
 -- Remove any pre-existing column-level grants on protected columns as well.
 revoke insert(public_tag,public_display_name,avatar_public,public_tag_custom),update(public_tag,public_display_name,avatar_public,public_tag_custom) on public.profiles from public,anon,authenticated;
end $$;
create table if not exists goaltracker_private.social_rate_limits (
 user_id uuid not null references auth.users(id) on delete cascade,
 action text not null check(action in ('search','request','identity')),
 window_start timestamptz not null, attempts integer not null,
 primary key(user_id,action)
);
alter table goaltracker_private.social_rate_limits enable row level security;
revoke all on goaltracker_private.social_rate_limits from public,anon,authenticated;
create or replace function goaltracker_private.take_social_rate(action_name text)
returns boolean language plpgsql security definer set search_path='' as $$
declare current_count integer; limit_count integer; stamp timestamptz:=clock_timestamp();
begin
 if auth.uid() is null then return false; end if;
 limit_count := case action_name when 'search' then 20 when 'request' then 5 when 'identity' then 5 else 0 end;
 if limit_count=0 then return false; end if;
 insert into goaltracker_private.social_rate_limits as rate(user_id,action,window_start,attempts)
 values(auth.uid(),action_name,stamp,1)
 on conflict(user_id,action) do update set
  attempts=case when rate.window_start <= stamp-interval '1 minute' then 1 else least(rate.attempts+1,1000000) end,
  window_start=case when rate.window_start <= stamp-interval '1 minute' then stamp else rate.window_start end
 returning attempts into current_count;
 return current_count<=limit_count;
end $$;

create or replace function public.social_identity()
returns jsonb language plpgsql security definer set search_path='' as $$
declare me uuid:=auth.uid(); result jsonb;
begin
 if me is null then raise insufficient_privilege using message='SOCIAL_AUTH_REQUIRED'; end if;
 insert into public.profiles(user_id) values(me) on conflict(user_id) do nothing;
 select jsonb_build_object('alias_mode','manual','public_tag',case when p.public_tag_custom then '@'||p.public_tag else null end,'display_name',p.public_display_name,'avatar_public',p.avatar_public,'is_custom',p.public_tag_custom) into result
 from public.profiles p where p.user_id=me;
 return result;
end $$;
create or replace function public.social_set_identity(tag_value text,display_name_value text,avatar_public_value boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare tag text:=goaltracker_private.normalize_tag(tag_value); name text:=btrim(display_name_value);
begin
 if auth.uid() is null then raise insufficient_privilege using message='SOCIAL_AUTH_REQUIRED'; end if;
 if tag_value is null or btrim(tag_value) !~ '^@[a-zA-Z][a-zA-Z0-9_]{2,39}$' or tag is null or tag !~ '^[a-z][a-z0-9_]{2,39}$' or name is null or length(name) not between 2 and 32 or name ~ '[@[:cntrl:]]' or avatar_public_value is null then
  return jsonb_build_object('state','invalid_input');
 end if;
 if not goaltracker_private.take_social_rate('identity') then return jsonb_build_object('state','rate_limited'); end if;
 -- Catch only this update's unique violation. The counter remains committed.
 begin
  insert into public.profiles(user_id) values(auth.uid()) on conflict(user_id) do nothing;
  update public.profiles set public_tag=tag,public_display_name=name,avatar_public=avatar_public_value,public_tag_custom=true where user_id=auth.uid();
 exception when unique_violation then return jsonb_build_object('state','tag_taken'); end;
 return jsonb_build_object('state','saved','identity',public.social_identity());
end $$;

create or replace function public.social_search_alias(search_tag text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare tag text:=goaltracker_private.normalize_tag(search_tag); found_profile jsonb;
begin
 if auth.uid() is null then raise insufficient_privilege using message='SOCIAL_AUTH_REQUIRED'; end if;
 if search_tag is null or btrim(search_tag) !~ '^@[a-zA-Z][a-zA-Z0-9_]{2,39}$' or tag is null or length(search_tag)>80 or tag !~ '^[a-z][a-z0-9_]{2,39}$' then return jsonb_build_object('state','invalid_input'); end if;
 if not exists(select 1 from public.profiles p where p.user_id=auth.uid() and p.public_tag_custom and p.public_tag is not null) then return jsonb_build_object('state','alias_required'); end if;
 if not goaltracker_private.take_social_rate('search') then return jsonb_build_object('state','rate_limited'); end if;
 select jsonb_build_object('user_id',p.user_id,'public_tag',case when p.public_tag_custom then '@'||p.public_tag else null end,'display_name',p.public_display_name,
  'avatar',case when p.avatar_public then coalesce(up.data->>'customAvatarData','') else '' end)
 into found_profile from public.profiles p left join public.user_profile up on up.user_id=p.user_id where p.public_tag=tag and p.public_tag_custom;
 return case when found_profile is null then jsonb_build_object('state','not_found') else jsonb_build_object('state','found','profile',found_profile) end;
end $$;
create or replace function public.social_request_alias(target_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare me uuid:=auth.uid(); friendship public.friendships; inserted_count integer;
begin
 if me is null then raise insufficient_privilege using message='SOCIAL_AUTH_REQUIRED'; end if;
 if target_id is null then return jsonb_build_object('state','invalid_input'); end if;
 if target_id=me then return jsonb_build_object('state','self_request'); end if;
 if not exists(select 1 from public.profiles p where p.user_id=me and p.public_tag_custom and p.public_tag is not null) then return jsonb_build_object('state','alias_required'); end if;
 if not goaltracker_private.take_social_rate('request') then return jsonb_build_object('state','rate_limited'); end if;
 if not exists(select 1 from public.profiles p where p.user_id=target_id and p.public_tag_custom and p.public_tag is not null) then return jsonb_build_object('state','not_found'); end if;
 insert into public.friendships(requester_id,recipient_id) values(me,target_id) on conflict do nothing;
 get diagnostics inserted_count = row_count;
 select * into friendship from public.friendships f where least(f.requester_id,f.recipient_id)=least(me,target_id)
 and greatest(f.requester_id,f.recipient_id)=greatest(me,target_id) for update;
 if friendship.status='accepted' then return jsonb_build_object('state','already_friends','friendship_id',friendship.id); end if;
 if friendship.status='rejected' then
  if friendship.updated_at>clock_timestamp()-interval '24 hours' then return jsonb_build_object('state','request_cooldown'); end if;
  update public.friendships set requester_id=me,recipient_id=target_id,status='pending',updated_at=now() where id=friendship.id;
  return jsonb_build_object('state','request_sent','friendship_id',friendship.id);
 end if;
 -- Existing and newly inserted requests have the same idempotent result.
 return jsonb_build_object('state',case when inserted_count=1 then 'request_sent' else 'request_exists' end,'friendship_id',friendship.id);
end $$;
create or replace function public.social_friends_alias()
returns table(id uuid,requester_id uuid,recipient_id uuid,status text,user_id uuid,public_tag text,display_name text,avatar text)
language sql stable security definer set search_path='' as $$
 select f.id,f.requester_id,f.recipient_id,f.status,p.user_id,case when p.public_tag_custom then '@'||p.public_tag else null end,p.public_display_name,
 case when p.avatar_public then coalesce(up.data->>'customAvatarData','') else '' end
 from public.friendships f join public.profiles p on p.user_id=case when f.requester_id=auth.uid() then f.recipient_id else f.requester_id end
 left join public.user_profile up on up.user_id=p.user_id
 where auth.uid() in(f.requester_id,f.recipient_id) and f.status<>'rejected' order by f.updated_at desc;
$$;

create or replace function public.social_profile_alias(target_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb; visible_goals jsonb;
begin
 if auth.uid() is null or not exists(select 1 from public.friendships f where f.status='accepted'
  and least(f.requester_id,f.recipient_id)=least(auth.uid(),target_id)
  and greatest(f.requester_id,f.recipient_id)=greatest(auth.uid(),target_id)) then raise exception 'Профиль доступен только друзьям'; end if;
 select jsonb_build_object('user_id',target_id,'nickname',p.public_display_name,'display_name',p.public_display_name,'public_tag',case when p.public_tag_custom then '@'||p.public_tag else null end,
  'avatar',case when p.avatar_public then coalesce(up.data->>'customAvatarData','') else '' end) into result
 from auth.users u left join public.profiles p on p.user_id=u.id
 left join public.user_profile up on up.user_id=u.id where u.id=target_id;
 select coalesce(jsonb_agg(jsonb_build_object('id',g->>'id','title',g->>'title','status',g->>'status','progress',progress)), '[]'::jsonb)
 into visible_goals from (
  select g, case
   when jsonb_array_length(case when jsonb_typeof(g->'subgoals')='array' then g->'subgoals' else '[]'::jsonb end)>0 then
    round(100.0 * (select count(*) from jsonb_array_elements(g->'subgoals') s where s->>'completed'='true') / jsonb_array_length(g->'subgoals'))
   when jsonb_typeof(g->'progress')='number' then greatest(0,least(100,(g->>'progress')::numeric))
   when g->>'status'='completed' then 100 else 0 end as progress
  from public.goals owner_goals cross join lateral jsonb_array_elements(owner_goals.data) g where owner_goals.user_id=target_id
 ) filtered where progress>0 or g->>'status'='public';
 return result || jsonb_build_object('goals',visible_goals);
end; $$;


-- Retire legacy discovery endpoints: no alternate email/avatar bypass remains.
revoke all on function public.social_search(text),public.social_friends(),public.social_request(uuid),public.social_profile(uuid) from public,anon,authenticated;
revoke all on function goaltracker_private.normalize_tag(text),goaltracker_private.take_social_rate(text) from public,anon,authenticated;
revoke all on function public.social_identity(),public.social_set_identity(text,text,boolean),public.social_search_alias(text),public.social_request_alias(uuid),public.social_friends_alias(),public.social_profile_alias(uuid) from public,anon;
grant execute on function public.social_identity(),public.social_set_identity(text,text,boolean),public.social_search_alias(text),public.social_request_alias(uuid),public.social_friends_alias(),public.social_profile_alias(uuid) to authenticated;
-- Disable optional previous-draft endpoints as well; no legacy discovery path.
do $$ declare signature text; begin
 foreach signature in array array['public.social_search_tag(text)','public.social_request_tag(uuid)','public.social_friends_tag()','public.social_profile_tag(uuid)'] loop
  if to_regprocedure(signature) is not null then execute 'revoke all on function '||signature||' from public,anon,authenticated'; end if;
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
