-- Apply before publishing the handle-based client. Existing RLS remains intact.
begin;
alter table public.profiles add column if not exists handle text;
-- Registered metadata takes precedence; legacy valid usernames retain their spelling.
update public.profiles p set handle = lower(ltrim(btrim(coalesce(
 nullif(u.raw_user_meta_data->>'ncd_handle',''), to_jsonb(p)->>'username', to_jsonb(p)->>'nickname')),'@'))
from auth.users u where u.id=p.id and p.handle is null
and lower(ltrim(btrim(coalesce(nullif(u.raw_user_meta_data->>'ncd_handle',''),to_jsonb(p)->>'username',to_jsonb(p)->>'nickname')),'@')) ~ '^[a-z][a-z0-9_]{2,31}$';
-- Give older accounts without a usable name a stable, shareable ID.
update public.profiles set handle='user_'||substr(replace(id::text,'-',''),1,27) where handle is null;
-- Legacy duplicate display names must not produce ambiguous handles.
with duplicates as (select id,row_number() over(partition by lower(handle) order by id) n from public.profiles)
update public.profiles p set handle='user_'||substr(replace(p.id::text,'-',''),1,27)
from duplicates d where d.id=p.id and d.n>1;
create unique index if not exists profiles_handle_unique on public.profiles(lower(handle));
create index if not exists profiles_handle_lookup on public.profiles(lower(handle));

-- Provision handles even when another client or the auth signup trigger creates a row.
create or replace function public.ncd_profile_handle_default()
returns trigger language plpgsql security definer set search_path = '' as $$
declare candidate text;
begin
 if new.handle is null then
  select u.raw_user_meta_data->>'ncd_handle' into candidate from auth.users u where u.id=new.id;
  candidate := lower(ltrim(btrim(coalesce(candidate,to_jsonb(new)->>'username',to_jsonb(new)->>'nickname')),'@'));
  if candidate is null or candidate !~ '^[a-z][a-z0-9_]{2,31}$' then
   candidate := 'user_'||substr(replace(new.id::text,'-',''),1,27);
  end if;
  new.handle := candidate;
 end if;
 new.handle := lower(ltrim(btrim(new.handle),'@'));
 if new.handle !~ '^[a-z][a-z0-9_]{2,31}$' then raise exception 'Invalid profile handle'; end if;
 return new;
end $$;
revoke all on function public.ncd_profile_handle_default() from public,anon,authenticated;
drop trigger if exists ncd_profile_handle_default on public.profiles;
create trigger ncd_profile_handle_default before insert or update on public.profiles
for each row execute function public.ncd_profile_handle_default();

create or replace function public.social_search_handle(search_handle text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare wanted text := lower(regexp_replace(btrim(search_handle),'^@','')); result jsonb;
begin
 if auth.uid() is null then raise insufficient_privilege using message='SOCIAL_AUTH_REQUIRED'; end if;
 if wanted is null or wanted !~ '^[a-z][a-z0-9_]{2,31}$' then
  return jsonb_build_object('state','invalid_input','profiles','[]'::jsonb);
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('user_id',id,'handle',handle)), '[]'::jsonb)
 into result from (select p.id,p.handle from public.profiles p
 join auth.users u on u.id=p.id where lower(p.handle)=wanted and p.id<>auth.uid()
 order by p.id limit 50) matches;
 return jsonb_build_object('state',case when jsonb_array_length(result)>0 then 'found' else 'not_found' end,'profiles',result);
end $$;
revoke all on function public.social_search_handle(text) from public,anon;
grant execute on function public.social_search_handle(text) to authenticated;
notify pgrst, 'reload schema';
commit;
