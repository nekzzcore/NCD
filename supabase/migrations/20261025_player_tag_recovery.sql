-- Apply after 20261025_player_tags.sql. Exposes only the caller's own ID.
begin;
create or replace function ncd_private.assign_player_tag()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
 if tg_op='INSERT' then
  new.short_id := ncd_private.allocate_player_tag(coalesce(to_jsonb(new)->>'id',to_jsonb(new)->>'user_id')::uuid);
 elsif old.short_id is null or old.short_id !~ '^#[A-Z0-9]{6,8}$' then
  new.short_id := ncd_private.allocate_player_tag(coalesce(to_jsonb(new)->>'id',to_jsonb(new)->>'user_id')::uuid);
 elsif new.short_id is distinct from old.short_id then
  raise insufficient_privilege using message='PLAYER_TAG_IMMUTABLE';
 end if;
 return new;
end $$;
revoke all on function ncd_private.assign_player_tag() from public,anon,authenticated;

create or replace function public.social_generate_player_tag()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare caller uuid := auth.uid(); tag text; account auth.users%rowtype;
 key_column text; columns_sql text; values_sql text; field text; display_name text; profile_exists boolean;
begin
 if caller is null then raise insufficient_privilege using message='SOCIAL_AUTH_REQUIRED'; end if;
 perform pg_advisory_xact_lock(hashtextextended('ncd-player-profile:'||caller::text,0));
 select * into account from auth.users where id=caller;
 if not found then raise insufficient_privilege using message='SOCIAL_AUTH_REQUIRED'; end if;
 select p.short_id into tag from public.profiles p
 where coalesce(to_jsonb(p)->>'id',to_jsonb(p)->>'user_id')=caller::text;
 profile_exists := found;
 if tag ~ '^#[A-Z0-9]{6,8}$' then return jsonb_build_object('short_id',tag); end if;
 key_column := case when exists(select 1 from information_schema.columns
  where table_schema='public' and table_name='profiles' and column_name='id') then 'id' else 'user_id' end;
 if profile_exists then
  -- The recovery trigger allocates the ID, retaining uniqueness and reserved tags.
  execute format('update public.profiles set short_id=short_id where %I=$1 returning short_id',key_column) into tag using caller;
 else
  display_name := coalesce(nullif(account.raw_user_meta_data->>'ncd_handle',''),nullif(account.raw_user_meta_data->>'username',''),nullif(account.raw_user_meta_data->>'nickname',''),'user_'||substr(replace(caller::text,'-',''),1,27));
  columns_sql:=format('%I',key_column); values_sql:='$1';
  foreach field in array array['email','username','nickname','handle'] loop
   if exists(select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name=field and is_generated='NEVER') then
    columns_sql:=columns_sql||format(',%I',field);
    values_sql:=values_sql||case when field='email' then ',$2' when field='handle' then ',$4' else ',$3' end;
   end if;
  end loop;
  execute format('insert into public.profiles(%s) values(%s) on conflict(%I) do update set short_id=profiles.short_id returning short_id',columns_sql,values_sql,key_column)
  into tag using caller,coalesce(account.email,''),display_name,coalesce(nullif(account.raw_user_meta_data->>'ncd_handle',''),'user_'||substr(replace(caller::text,'-',''),1,27));
 end if;
 if tag is null or tag !~ '^#[A-Z0-9]{6,8}$' then raise exception 'PLAYER_TAG_NOT_ASSIGNED'; end if;
 return jsonb_build_object('short_id',tag);
end $$;
revoke all on function public.social_generate_player_tag() from public,anon;
grant execute on function public.social_generate_player_tag() to authenticated;
notify pgrst, 'reload schema';
commit;
