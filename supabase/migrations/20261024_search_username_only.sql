-- Search-only migration for profiles(id, username, short_id).
-- No table, data, or RLS policy changes. Run manually after review.
begin;

do $$ begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles'
      and column_name = 'id' and data_type = 'uuid'
  ) or (
    select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles'
      and column_name in ('username', 'short_id') and data_type = 'text'
  ) <> 2 then
    raise exception 'Expected public.profiles(id uuid, username text, short_id text).';
  end if;
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'profiles' and c.relrowsecurity
  ) then
    raise exception 'profiles RLS must already be enabled. Review existing policies first.';
  end if;
end $$;

-- Keep argument names compatible with the application's existing RPC call.
create or replace function public.social_search_nickname(
  search_nickname text, after_id bigint default null
) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  cursor_offset bigint := coalesce(after_id, 0);
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

  with matched as (
    select p.id as user_id, btrim(p.username) as username, p.short_id
    from public.profiles p
    join auth.users registered on registered.id = p.id
    where p.id <> caller
      and lower(btrim(p.username)) = lower(btrim(search_nickname))
      and p.username !~ '[@[:cntrl:]]'
    order by p.id
    limit 51 offset cursor_offset
  ), page as (
    select * from matched order by user_id limit 50
  )
  select jsonb_build_object(
    'state', case when exists(select 1 from page) then 'found' else 'not_found' end,
    'profiles', coalesce((select jsonb_agg(jsonb_build_object(
      'user_id', user_id, 'username', username, 'short_id', short_id
    ) order by user_id) from page), '[]'::jsonb),
    'next_cursor', case when (select count(*) from matched) > 50
      then (cursor_offset + 50)::text else null end
  ) into result;
  return result;
end $$;

alter function public.social_search_nickname(text, bigint) owner to postgres;
revoke all on function public.social_search_nickname(text, bigint)
  from public, anon, authenticated;
grant execute on function public.social_search_nickname(text, bigint)
  to authenticated;

notify pgrst, 'reload schema';
commit;
