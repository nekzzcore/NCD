-- Apply before publishing the Player Tag client. Run as the database owner.
-- Profile visibility, friendship authorization and existing account data are preserved.
begin;
lock table public.profiles in access exclusive mode;
do $$ begin
 if to_regprocedure('public.social_people()') is null
 or to_regprocedure('public.social_friend_profile(uuid)') is null then
  raise exception 'PLAYER_SOCIAL_SCHEMA_REQUIRED: existing friends/profile RPCs must be installed first';
 end if;
end $$;
create schema if not exists ncd_private;
revoke all on schema ncd_private from public, anon, authenticated;
alter table public.profiles add column if not exists short_id text;
alter table public.profiles alter column short_id drop default;

-- The UNIQUE index is authoritative; a per-candidate transaction lock also makes
-- collision retries safe when two registrations happen at the same time.
create or replace function ncd_private.allocate_player_tag(owner_id uuid)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare
 email_address text; existing_tag text; candidate text; attempt integer := 0;
 alphabet constant text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
 special boolean;
begin
 select lower(u.email) into email_address from auth.users u where u.id=owner_id;
 if not found then raise exception 'PLAYER_ACCOUNT_REQUIRED'; end if;
 special := coalesce(email_address in ('sayonarax778@gmail.com','tvinkutub2@gmail.com'),false);
 select '#' || upper(ltrim(btrim(p.short_id),'#')) into existing_tag
 from public.profiles p
 where coalesce(to_jsonb(p)->>'id',to_jsonb(p)->>'user_id')=owner_id::text;
 if existing_tag ~ '^#[A-Z0-9]{6,8}$'
 and (existing_tag not in ('#XXXXXX76','#XXXXX276') or special)
 and (not special or existing_tag in ('#XXXXXX76','#XXXXX276'))
 and not exists(select 1 from public.profiles p
   where '#'||upper(ltrim(btrim(p.short_id),'#'))=existing_tag
   and coalesce(to_jsonb(p)->>'id',to_jsonb(p)->>'user_id')<>owner_id::text) then
  return existing_tag;
 end if;
 loop
  attempt := attempt+1;
  if attempt>100 then raise exception 'PLAYER_TAG_ALLOCATION_FAILED'; end if;
  if special and attempt<=2 then
   candidate := case when attempt=1 then '#XXXXXX76' else '#XXXXX276' end;
  else
   select '#'||string_agg(substr(alphabet,1+floor(random()*36)::integer,1),'')
   into candidate from generate_series(1,8);
   if candidate in ('#XXXXXX76','#XXXXX276') then continue; end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ncd-player-tag:'||candidate,0));
  if not exists(select 1 from public.profiles p
    where '#'||upper(ltrim(btrim(p.short_id),'#'))=candidate
    and coalesce(to_jsonb(p)->>'id',to_jsonb(p)->>'user_id')<>owner_id::text) then
   return candidate;
  end if;
 end loop;
end $$;
revoke all on function ncd_private.allocate_player_tag(uuid) from public,anon,authenticated;

-- Invalid legacy IDs and duplicate IDs are repaired. Valid existing tags stay stable.
-- Ordinary accounts relinquish the two reserved tags before vanity accounts are processed.
-- If both emails already exist, the first listed email receives #XXXXXX76.
-- If registered later, a second account gets #XXXXX276; one UNIQUE ID cannot belong to two accounts.
drop trigger if exists zzz_ncd_player_tag on public.profiles;
do $$ declare account record; begin
 for account in
  select u.id from public.profiles p join auth.users u
   on u.id::text=coalesce(to_jsonb(p)->>'id',to_jsonb(p)->>'user_id')
  order by case lower(u.email) when 'sayonarax778@gmail.com' then 1
   when 'tvinkutub2@gmail.com' then 2 else 0 end,u.id
 loop
  update public.profiles p set short_id=ncd_private.allocate_player_tag(account.id)
   where coalesce(to_jsonb(p)->>'id',to_jsonb(p)->>'user_id')=account.id::text;
 end loop;
end $$;
create unique index if not exists profiles_player_tag_unique on public.profiles(short_id);
alter table public.profiles alter column short_id set not null;
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='public.profiles'::regclass and conname='profiles_player_tag_format') then
  alter table public.profiles add constraint profiles_player_tag_format check(short_id ~ '^#[A-Z0-9]{6,8}$');
 end if;
end $$;

create or replace function ncd_private.assign_player_tag()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
 if tg_op='INSERT' then
  -- Never trust a client-supplied tag, email or vanity flag.
  new.short_id := ncd_private.allocate_player_tag(coalesce(to_jsonb(new)->>'id',to_jsonb(new)->>'user_id')::uuid);
 elsif new.short_id is distinct from old.short_id then
  raise insufficient_privilege using message='PLAYER_TAG_IMMUTABLE';
 end if;
 return new;
end $$;
revoke all on function ncd_private.assign_player_tag() from public,anon,authenticated;
create trigger zzz_ncd_player_tag before insert or update on public.profiles
 for each row execute function ncd_private.assign_player_tag();

-- Cover signups even when the initial profile has not yet been written by an app.
-- Both deployed layouts (id/username and user_id/nickname) are supported.
create or replace function ncd_private.ensure_player_profile()
returns trigger language plpgsql security definer set search_path = '' as $$
declare key_column text; columns_sql text; values_sql text; field text; name text;
begin
 key_column := case when exists(select 1 from information_schema.columns
  where table_schema='public' and table_name='profiles' and column_name='id') then 'id' else 'user_id' end;
 if exists(select 1 from public.profiles p where coalesce(to_jsonb(p)->>'id',to_jsonb(p)->>'user_id')=new.id::text) then return new; end if;
 name := coalesce(nullif(new.raw_user_meta_data->>'ncd_handle',''),nullif(new.raw_user_meta_data->>'username',''),nullif(new.raw_user_meta_data->>'nickname',''),'user_'||substr(replace(new.id::text,'-',''),1,27));
 columns_sql := format('%I',key_column); values_sql := '$1';
 foreach field in array array['email','username','nickname','handle'] loop
  if exists(select 1 from information_schema.columns where table_schema='public'
    and table_name='profiles' and column_name=field and is_generated='NEVER') then
   columns_sql := columns_sql||format(',%I',field);
   values_sql := values_sql||case when field='email' then ',$2' when field='handle' then ',$4' else ',$3' end;
  end if;
 end loop;
 execute format('insert into public.profiles(%s) values(%s) on conflict(%I) do nothing',columns_sql,values_sql,key_column)
 using new.id,coalesce(new.email,''),name,coalesce(nullif(new.raw_user_meta_data->>'ncd_handle',''),'user_'||substr(replace(new.id::text,'-',''),1,27));
 return new;
end $$;
revoke all on function ncd_private.ensure_player_profile() from public,anon,authenticated;
drop trigger if exists zzz_ncd_player_account on auth.users;
create trigger zzz_ncd_player_account after insert on auth.users
 for each row execute function ncd_private.ensure_player_profile();

create or replace function public.social_search_player_tag(search_tag text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare wanted text := '#'||upper(regexp_replace(btrim(search_tag),'^#','')); matches jsonb;
begin
 if auth.uid() is null then raise insufficient_privilege using message='SOCIAL_AUTH_REQUIRED'; end if;
 if wanted is null or wanted !~ '^#[A-Z0-9]{6,8}$' then
  return jsonb_build_object('state','invalid_input','profiles','[]'::jsonb);
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('user_id',u.id,'short_id',p.short_id)),'[]'::jsonb)
 into matches from public.profiles p join auth.users u
 on u.id::text=coalesce(to_jsonb(p)->>'id',to_jsonb(p)->>'user_id')
 where p.short_id=wanted and u.id<>auth.uid();
 return jsonb_build_object('state',case when jsonb_array_length(matches)>0 then 'found' else 'not_found' end,'profiles',matches);
end $$;

-- Keep the original authorization and response fields; replace only the public ID.
create or replace function public.social_people_players()
returns setof jsonb language sql stable security definer set search_path = '' as $$
 select to_jsonb(person)||jsonb_build_object('short_id',p.short_id)
 from public.social_people() person join public.profiles p
 on coalesce(to_jsonb(p)->>'id',to_jsonb(p)->>'user_id')=to_jsonb(person)->>'user_id'
 where auth.uid() is not null;
$$;
create or replace function public.social_friend_player_profile(target_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare profile jsonb; tag text;
begin
 if auth.uid() is null then raise insufficient_privilege using message='SOCIAL_AUTH_REQUIRED'; end if;
 profile := public.social_friend_profile(target_id);
 if profile is null then return null; end if;
 select p.short_id into tag from public.profiles p
 where coalesce(to_jsonb(p)->>'id',to_jsonb(p)->>'user_id')=target_id::text;
 return profile||jsonb_build_object('short_id',tag);
end $$;
revoke all on function public.social_search_player_tag(text),public.social_people_players(),public.social_friend_player_profile(uuid) from public,anon;
grant execute on function public.social_search_player_tag(text),public.social_people_players(),public.social_friend_player_profile(uuid) to authenticated;
-- Stop legacy nickname/handle search endpoints; registration availability is separate.
do $$ declare signature text; begin
 foreach signature in array array['public.social_search_handle(text)','public.social_search_nickname(text,bigint)'] loop
  if to_regprocedure(signature) is not null then
   execute 'revoke all on function '||signature||' from public,anon,authenticated';
  end if;
 end loop;
end $$;
notify pgrst, 'reload schema';
commit;
