-- Disposable local PostgreSQL only. Never run this fixture in Supabase.
create role authenticated nologin;
create role anon nologin;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$
 select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}'::jsonb);
create table public.profiles(id uuid primary key references auth.users(id),username text,short_id text);
alter table public.profiles enable row level security;
create policy owner_profile on public.profiles for all to authenticated using(id=auth.uid()) with check(id=auth.uid());
grant select,insert,update on public.profiles to authenticated;
insert into auth.users(id,email) values
 ('10000000-0000-4000-8000-000000000001','sayonarax778@gmail.com'),
 ('10000000-0000-4000-8000-000000000002','tvinkutub2@gmail.com'),
 ('10000000-0000-4000-8000-000000000003','ordinary@example.invalid'),
 ('10000000-0000-4000-8000-000000000004','friend@example.invalid'),
 ('10000000-0000-4000-8000-000000000005','duplicate1@example.invalid'),
 ('10000000-0000-4000-8000-000000000006','duplicate2@example.invalid');
insert into public.profiles values
 ('10000000-0000-4000-8000-000000000001','Owner','4821'),
 ('10000000-0000-4000-8000-000000000002','Owner two',null),
 ('10000000-0000-4000-8000-000000000003','Ordinary','#XXXXXX76'),
 ('10000000-0000-4000-8000-000000000004','Friend','#ABC123'),
 ('10000000-0000-4000-8000-000000000005','Duplicate','#DUP123'),
 ('10000000-0000-4000-8000-000000000006','Duplicate','#DUP123');
create function public.social_people()
returns table(user_id uuid,status text,nickname text,short_id text)
language sql stable security definer set search_path='' as $$
 select p.id,'accepted'::text,p.username,'#4822'::text from public.profiles p
 where auth.uid()='10000000-0000-4000-8000-000000000003'::uuid
 and p.id='10000000-0000-4000-8000-000000000004'::uuid
$$;
create function public.social_friend_profile(target_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid()<>'10000000-0000-4000-8000-000000000003'::uuid
 or target_id<>'10000000-0000-4000-8000-000000000004'::uuid then
  raise insufficient_privilege using message='NOT_FRIENDS';
 end if;
 return jsonb_build_object('nickname','Friend','short_id','#4822','goals','[]'::jsonb);
end $$;
