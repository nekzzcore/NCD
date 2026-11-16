-- Apply in the current Supabase project's SQL Editor before shipping the client.
-- Returns only availability; never exposes auth.users rows or modifies accounts.
begin;
drop function if exists public.ncd_email_available(text);
create function public.ncd_email_available(check_email text)
returns boolean language sql stable security definer
set search_path = ''
as $$
 select case
  when check_email is null or length(btrim(check_email)) > 254
    or btrim(check_email) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  then false
  else not exists (
   select 1 from auth.users u
   where lower(u.email) = lower(btrim(check_email))
  )
 end;
$$;
revoke all on function public.ncd_email_available(text) from public;
grant execute on function public.ncd_email_available(text) to anon, authenticated;
commit;
