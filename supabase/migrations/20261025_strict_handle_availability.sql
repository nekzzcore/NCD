-- No changes to UNIQUE, profile visibility or existing RLS policies.
begin;
create or replace function public.ncd_handle_available(candidate text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare wanted text := lower(regexp_replace(btrim(candidate),'^@',''));
begin
 if wanted is null or wanted !~ '^[a-z][a-z0-9_]{2,31}$' then return false; end if;
 -- Include unconfirmed signups: they may not have a profiles row yet.
 return not exists(select 1 from public.profiles p where lower(p.handle)=wanted)
 and not exists(select 1 from auth.users u where lower(u.raw_user_meta_data->>'ncd_handle')=wanted);
end $$;
revoke all on function public.ncd_handle_available(text) from public;
grant execute on function public.ncd_handle_available(text) to anon,authenticated;
notify pgrst, 'reload schema';
commit;
