-- Search-only migration. Run manually in the intended Supabase project.
-- No table/data/RLS-policy changes. Supports profiles.user_id or profiles.id.
begin;

do $$ begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles'
      and column_name = 'nickname' and data_type in ('text', 'character varying')
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles'
      and column_name in ('user_id', 'id') and data_type = 'uuid'
  ) then
    raise exception 'Expected public.profiles.nickname and UUID user_id or id. Review the schema; do not rerun schema.sql.';
  end if;
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'profiles' and c.relrowsecurity
  ) then
    raise exception 'profiles RLS must already be enabled. Review existing policies first.';
  end if;
end $$;

create or replace function public.social_search_nickname(
  search_nickname text, after_id bigint default null
) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  cursor_offset bigint := coalesce(after_id, 0);
  owner_column text;
  avatar_join text := '';
  avatar_value text := 'to_jsonb(p)->>''avatar_url''';
  result jsonb;
begin
  if caller is null then
    raise insufficient_privilege using message = 'SOCIAL_AUTH_REQUIRED';
  end if;
  if search_nickname is null
     or length(btrim(search_nickname)) not between 2 and 32
     or search_nickname ~ '[@#[:cntrl:]]'
     or cursor_offset < 0 or cursor_offset > 2147483597 then
    return jsonb_build_object('state', 'invalid_input', 'profiles', '[]'::jsonb);
  end if;

  select column_name into owner_column
  from information_schema.columns
  where table_schema = 'public' and table_name = 'profiles'
    and column_name in ('user_id', 'id') and data_type = 'uuid'
  order by case column_name when 'user_id' then 0 else 1 end
  limit 1;

  -- Optional existing avatar storage; read only, never created or modified.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'user_profile'
      and column_name = 'user_id' and data_type = 'uuid'
  ) and exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'user_profile'
      and column_name = 'data' and data_type = 'jsonb'
  ) then
    avatar_join := format(
      'left join public.user_profile up on up.user_id = p.%I', owner_column
    );
    avatar_value := 'coalesce(up.data->>''customAvatarData'', to_jsonb(p)->>''avatar_url'')';
  end if;

  -- Identifiers/fragments are schema-derived constants. User input is bound.
  execute format($query$
    with matched as (
      select p.%1$I as id, btrim(p.nickname) as nickname,
        case when to_jsonb(p)->>'avatar_public' = 'true'
          then %2$s else null end as avatar
      from public.profiles p
      join auth.users registered on registered.id = p.%1$I
      %3$s
      where p.%1$I <> $3
        and lower(btrim(p.nickname)) = lower(btrim($1))
        and p.nickname !~ '[@[:cntrl:]]'
      order by p.%1$I
      limit 51 offset $2
    ), page as (
      select * from matched order by id limit 50
    )
    select jsonb_build_object(
      'state', case when exists(select 1 from page) then 'found' else 'not_found' end,
      'profiles', coalesce((select jsonb_agg(jsonb_build_object(
        'id', id, 'nickname', nickname, 'avatar', avatar
      ) order by id) from page), '[]'::jsonb),
      'next_cursor', case when (select count(*) from matched) > 50
        then ($2 + 50)::text else null end
    )
  $query$, owner_column, avatar_value, avatar_join)
  into result using search_nickname, cursor_offset, caller;
  return result;
end $$;

alter function public.social_search_nickname(text, bigint) owner to postgres;

revoke all on function public.social_search_nickname(text, bigint)
  from public, anon, authenticated;
grant execute on function public.social_search_nickname(text, bigint)
  to authenticated;

notify pgrst, 'reload schema';
commit;
