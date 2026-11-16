-- REVIEW ONLY until explicitly approved. Existing social module is required.
-- Apply this file alone, before OR after previous tag/alias drafts.
-- No tables/data/policies are removed; RLS remains enabled.
begin;
do $$ begin
 if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='user_id')
 or not exists(select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='nickname')
 or to_regclass('public.friendships') is null or to_regclass('public.user_profile') is null then
  raise exception 'NICKNAME_SCHEMA_MISMATCH: review profiles.user_id/nickname and existing social module; do not rerun schema.sql';
 end if;
 if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('profiles','friendships') and not c.relrowsecurity) then
  raise exception 'NICKNAME_RLS_REQUIRED: review existing RLS first';
 end if;
end $$;
create schema if not exists goaltracker_private;
revoke all on schema goaltracker_private from public,anon,authenticated;
-- Retire only the earlier automatic alias generator, retaining its stored values.
drop trigger if exists goaltracker_assign_public_tag on public.profiles;
do $$ begin
 if exists(select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='public_tag') then
  alter table public.profiles alter column public_tag drop not null;
 end if;
end $$;
alter table public.profiles add column if not exists social_short_id bigint;
alter table public.profiles add column if not exists avatar_public boolean not null default false;
create sequence if not exists goaltracker_private.social_short_ids as bigint minvalue 1000 start 1000;
select setval('goaltracker_private.social_short_ids',greatest((select last_value from goaltracker_private.social_short_ids),coalesce((select max(social_short_id) from public.profiles),1000)),true);
update public.profiles set social_short_id=nextval('goaltracker_private.social_short_ids') where social_short_id is null;
create unique index if not exists profiles_social_short_id_unique on public.profiles(social_short_id);
alter table public.profiles alter column social_short_id set not null;
create or replace function goaltracker_private.assign_social_short_id()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='INSERT' then
  if new.social_short_id is null then new.social_short_id:=nextval('goaltracker_private.social_short_ids'); end if;
 elsif new.social_short_id is distinct from old.social_short_id then
  raise insufficient_privilege using message='SOCIAL_SHORT_ID_IMMUTABLE';
 end if;
 return new;
end $$;
drop trigger if exists goaltracker_social_short_id on public.profiles;
create trigger goaltracker_social_short_id before insert or update on public.profiles for each row execute function goaltracker_private.assign_social_short_id();
create or replace function goaltracker_private.ensure_social_profile()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.profiles(user_id) values(new.id) on conflict(user_id) do nothing;
 return new;
end $$;
drop trigger if exists goaltracker_social_account on auth.users;
create trigger goaltracker_social_account after insert on auth.users for each row execute function goaltracker_private.ensure_social_profile();
-- Account IDs are allocated on the server even before the first app sync.
insert into public.profiles(user_id) select id from auth.users on conflict(user_id) do nothing;
-- Restrictive guards intersect existing policies. Owner policies are preserved.
do $$ begin
 if not exists(select 1 from pg_policies where schemaname='public' and tablename='profiles' and policyname='social_nickname_owner_guard') then
  create policy social_nickname_owner_guard on public.profiles as restrictive for all to authenticated using((select auth.uid())=user_id) with check((select auth.uid())=user_id);
 end if;
 if not exists(select 1 from pg_policies where schemaname='public' and tablename='friendships' and policyname='social_nickname_friend_scope') then
  create policy social_nickname_friend_scope on public.friendships as restrictive for select to authenticated using((select auth.uid()) in(requester_id,recipient_id));
 end if;
end $$;
revoke select on public.profiles from public,anon;
revoke insert,update on public.profiles from public,anon,authenticated;
revoke insert,update,delete on public.friendships from public,anon,authenticated;
do $$ declare fields text; protected_fields text; begin
 select string_agg(quote_ident(column_name),',') into fields from information_schema.columns where table_schema='public' and table_name='profiles'
 and column_name not in('social_short_id','public_tag','public_display_name','avatar_public','public_tag_custom') and is_generated='NEVER';
 execute 'grant insert ('||fields||'),update ('||fields||') on public.profiles to authenticated';
 select string_agg(quote_ident(column_name),',') into protected_fields from information_schema.columns where table_schema='public' and table_name='profiles'
 and column_name in('social_short_id','public_tag','public_display_name','avatar_public','public_tag_custom');
 execute 'revoke insert ('||protected_fields||'),update ('||protected_fields||') on public.profiles from public,anon,authenticated';
 select string_agg(quote_ident(column_name),',') into fields from information_schema.columns where table_schema='public' and table_name='friendships';
 execute 'revoke insert ('||fields||'),update ('||fields||') on public.friendships from public,anon,authenticated';
end $$;
create or replace function goaltracker_private.public_nickname(value text)
returns text language sql immutable set search_path='' as $$
 select case when value is null or length(btrim(value)) not between 2 and 32 or value ~ '[@[:cntrl:]]' then 'Пользователь' else btrim(value) end;
$$;
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


create or replace function public.social_search_nickname(search_nickname text,after_id bigint default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if auth.uid() is null then raise insufficient_privilege using message='SOCIAL_AUTH_REQUIRED'; end if;
 if search_nickname is null or length(btrim(search_nickname)) not between 2 and 32 or search_nickname ~ '[@#[:cntrl:]]' or after_id<0 then return jsonb_build_object('state','invalid_input'); end if;
 if not goaltracker_private.take_social_rate('search') then return jsonb_build_object('state','rate_limited'); end if;
 with matched as (
  select p.user_id,p.social_short_id,goaltracker_private.public_nickname(p.nickname) as nickname,
  case when p.avatar_public then coalesce(up.data->>'customAvatarData','') else '' end as avatar
  from public.profiles p left join public.user_profile up on up.user_id=p.user_id
  where lower(goaltracker_private.public_nickname(p.nickname))=lower(btrim(search_nickname)) and p.social_short_id>coalesce(after_id,0)
  order by p.social_short_id limit 51
 ), page as (select * from matched order by social_short_id limit 50)
 select jsonb_build_object('state',case when exists(select 1 from page) then 'found' else 'not_found' end,
  'profiles',coalesce((select jsonb_agg(jsonb_build_object('user_id',user_id,'short_id','#'||social_short_id::text,'nickname',nickname,'avatar',avatar) order by social_short_id) from page),'[]'::jsonb),
  'next_cursor',case when (select count(*) from matched)>50 then (select max(social_short_id)::text from page) else null end) into result;
 return result;
end $$;
create or replace function public.social_request_nickname(target_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare me uuid:=auth.uid(); friendship public.friendships; inserted_count integer;
begin
 if me is null then raise insufficient_privilege using message='SOCIAL_AUTH_REQUIRED'; end if;
 if target_id is null then return jsonb_build_object('state','invalid_input'); end if;
 if target_id=me then return jsonb_build_object('state','self_request'); end if;
 if not goaltracker_private.take_social_rate('request') then return jsonb_build_object('state','rate_limited'); end if;
 if not exists(select 1 from public.profiles p where p.user_id=target_id) then return jsonb_build_object('state','not_found'); end if;
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

create or replace function public.social_people()
returns table(id uuid,requester_id uuid,recipient_id uuid,status text,user_id uuid,short_id text,nickname text,avatar text)
language sql stable security definer set search_path='' as $$
 select f.id,f.requester_id,f.recipient_id,f.status,p.user_id,'#'||p.social_short_id::text,goaltracker_private.public_nickname(p.nickname),
 case when p.avatar_public then coalesce(up.data->>'customAvatarData','') else '' end
 from public.friendships f join public.profiles p on p.user_id=case when f.requester_id=auth.uid() then f.recipient_id else f.requester_id end
 left join public.user_profile up on up.user_id=p.user_id where auth.uid() in(f.requester_id,f.recipient_id) and f.status<>'rejected' order by f.updated_at desc;
$$;
create or replace function public.social_friend_profile(target_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb; visible_goals jsonb;
begin
 if auth.uid() is null or not exists(select 1 from public.friendships f where f.status='accepted'
  and least(f.requester_id,f.recipient_id)=least(auth.uid(),target_id)
  and greatest(f.requester_id,f.recipient_id)=greatest(auth.uid(),target_id)) then raise exception 'Профиль доступен только друзьям'; end if;
 select jsonb_build_object('user_id',target_id,'nickname',goaltracker_private.public_nickname(p.nickname),'short_id','#'||p.social_short_id::text,
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



-- No old alias editor/search, email search or direct request bypass remains.
do $$ declare signature text; begin
 foreach signature in array array[
  'public.social_identity()','public.social_set_identity(text,text,boolean)',
  'public.social_search(text)','public.social_request(uuid)','public.social_friends()','public.social_profile(uuid)',
  'public.social_search_tag(text)','public.social_request_tag(uuid)','public.social_friends_tag()','public.social_profile_tag(uuid)',
  'public.social_search_alias(text)','public.social_request_alias(uuid)','public.social_friends_alias()','public.social_profile_alias(uuid)'
 ] loop
  if to_regprocedure(signature) is not null then execute 'revoke all on function '||signature||' from public,anon,authenticated'; end if;
 end loop;
end $$;
revoke all on function goaltracker_private.assign_social_short_id(),goaltracker_private.ensure_social_profile(),goaltracker_private.public_nickname(text),goaltracker_private.take_social_rate(text) from public,anon,authenticated;
revoke all on sequence goaltracker_private.social_short_ids from public,anon,authenticated;
revoke all on function public.social_search_nickname(text,bigint),public.social_request_nickname(uuid),public.social_people(),public.social_friend_profile(uuid) from public,anon;
grant execute on function public.social_search_nickname(text,bigint),public.social_request_nickname(uuid),public.social_people(),public.social_friend_profile(uuid) to authenticated;
notify pgrst,'reload schema';
commit;
