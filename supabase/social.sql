-- Apply after schema.sql in the same Supabase project.
begin;
create table if not exists public.friendships (
 id uuid primary key default gen_random_uuid(),
 requester_id uuid not null references auth.users(id) on delete cascade,
 recipient_id uuid not null references auth.users(id) on delete cascade,
 status text not null default 'pending' check (status in ('pending','accepted','rejected')),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check (requester_id <> recipient_id)
);
create unique index if not exists friendships_pair on public.friendships
 (least(requester_id,recipient_id), greatest(requester_id,recipient_id));
create index if not exists friendships_recipient on public.friendships(recipient_id,status);
create index if not exists friendships_requester on public.friendships(requester_id,status);
create table if not exists public.messages (
 id uuid primary key default gen_random_uuid(),
 sequence bigint generated always as identity unique,
 sender_id uuid not null references auth.users(id) on delete cascade,
 recipient_id uuid not null references auth.users(id) on delete cascade,
 body text not null check (length(btrim(body)) between 1 and 4000),
 created_at timestamptz not null default now(),
 check (sender_id <> recipient_id)
);
create index if not exists messages_conversation on public.messages
 (least(sender_id,recipient_id), greatest(sender_id,recipient_id), sequence desc);
create index if not exists messages_recipient on public.messages(recipient_id,sequence desc);
create index if not exists messages_sender on public.messages(sender_id,sequence desc);
alter table public.friendships enable row level security;
alter table public.messages enable row level security;
revoke all on public.friendships, public.messages from public, anon, authenticated;
grant select on public.friendships, public.messages to authenticated;
grant insert (id,sender_id,recipient_id,body) on public.messages to authenticated;
grant usage on sequence public.messages_sequence_seq to authenticated;
drop policy if exists social_friendship_read on public.friendships;
create policy social_friendship_read on public.friendships for select to authenticated
 using ((select auth.uid()) in (requester_id,recipient_id));
drop policy if exists social_message_read on public.messages;
create policy social_message_read on public.messages for select to authenticated
 using ((select auth.uid()) in (sender_id,recipient_id) and exists (
  select 1 from public.friendships f where f.status='accepted'
  and least(f.requester_id,f.recipient_id)=least(messages.sender_id,messages.recipient_id)
  and greatest(f.requester_id,f.recipient_id)=greatest(messages.sender_id,messages.recipient_id)));
drop policy if exists social_message_insert on public.messages;
create policy social_message_insert on public.messages for insert to authenticated
 with check (sender_id=(select auth.uid()) and exists (
  select 1 from public.friendships f where f.status='accepted'
  and least(f.requester_id,f.recipient_id)=least(messages.sender_id,messages.recipient_id)
  and greatest(f.requester_id,f.recipient_id)=greatest(messages.sender_id,messages.recipient_id)));

-- Exact match only; never expose auth.users or the private profile document.
create or replace function public.social_search(search_email text)
returns table(user_id uuid,nickname text,avatar text)
language plpgsql stable security definer set search_path = '' as $$
begin
 if auth.uid() is null then raise exception 'Войдите в аккаунт'; end if;
 if length(btrim(search_email)) < 5 or length(search_email)>254 then return; end if;
 return query select u.id,coalesce(nullif(p.nickname,''),'Пользователь'),coalesce(up.data->>'customAvatarData','')
 from auth.users u left join public.profiles p on p.user_id=u.id
 left join public.user_profile up on up.user_id=u.id
 where lower(u.email)=lower(btrim(search_email)) and u.id<>auth.uid() and u.email_confirmed_at is not null limit 1;
end; $$;

create or replace function public.social_friends()
returns table(id uuid,requester_id uuid,recipient_id uuid,status text,user_id uuid,nickname text,avatar text)
language sql stable security definer set search_path = '' as $$
 select f.id,f.requester_id,f.recipient_id,f.status,
 case when f.requester_id=auth.uid() then f.recipient_id else f.requester_id end,
 coalesce(nullif(p.nickname,''),'Пользователь'),coalesce(up.data->>'customAvatarData','')
 from public.friendships f
 left join public.profiles p on p.user_id=case when f.requester_id=auth.uid() then f.recipient_id else f.requester_id end
 left join public.user_profile up on up.user_id=p.user_id
 where auth.uid() in (f.requester_id,f.recipient_id) and f.status<>'rejected'
 order by f.updated_at desc;
$$;

create or replace function public.social_request(target_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); friendship public.friendships;
begin
 if me is null or me=target_id then raise exception 'Недопустимый получатель'; end if;
 if not exists(select 1 from auth.users where id=target_id and email_confirmed_at is not null) then raise exception 'Пользователь не найден'; end if;
 insert into public.friendships(requester_id,recipient_id) values(me,target_id) on conflict do nothing;
 select * into friendship from public.friendships
 where least(requester_id,recipient_id)=least(me,target_id) and greatest(requester_id,recipient_id)=greatest(me,target_id) for update;
 if friendship.status='rejected' then
  update public.friendships set requester_id=me,recipient_id=target_id,status='pending',updated_at=now() where id=friendship.id;
 end if;
 return friendship.id;
end; $$;

create or replace function public.social_respond(friendship_id uuid,accept_request boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
 update public.friendships set status=case when accept_request then 'accepted' else 'rejected' end,updated_at=now()
 where id=friendship_id and recipient_id=auth.uid() and status='pending';
 if not found then raise exception 'Заявка уже обработана или недоступна'; end if;
end; $$;

create or replace function public.social_profile(target_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb; visible_goals jsonb;
begin
 if auth.uid() is null or not exists(select 1 from public.friendships f where f.status='accepted'
  and least(f.requester_id,f.recipient_id)=least(auth.uid(),target_id)
  and greatest(f.requester_id,f.recipient_id)=greatest(auth.uid(),target_id)) then raise exception 'Профиль доступен только друзьям'; end if;
 select jsonb_build_object('user_id',target_id,'nickname',coalesce(nullif(p.nickname,''),'Пользователь'),
  'avatar',coalesce(up.data->>'customAvatarData','')) into result
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

-- Latest message per friend; avoids truncating the dialog list to a global message limit.
create or replace function public.social_dialogs()
returns table(user_id uuid,body text,created_at timestamptz,sequence bigint)
language sql stable security invoker set search_path = '' as $$
 select distinct on (case when m.sender_id=auth.uid() then m.recipient_id else m.sender_id end)
 case when m.sender_id=auth.uid() then m.recipient_id else m.sender_id end,m.body,m.created_at,m.sequence
 from public.messages m where auth.uid() in (m.sender_id,m.recipient_id)
 order by case when m.sender_id=auth.uid() then m.recipient_id else m.sender_id end,m.sequence desc;
$$;
revoke all on function public.social_search(text),public.social_friends(),public.social_request(uuid),public.social_respond(uuid,boolean),public.social_profile(uuid),public.social_dialogs() from public,anon;
grant execute on function public.social_search(text),public.social_friends(),public.social_request(uuid),public.social_respond(uuid,boolean),public.social_profile(uuid),public.social_dialogs() to authenticated;

-- Postgres Changes observes the same RLS restrictions as ordinary SELECT.
do $$ begin
 if not exists(select 1 from pg_publication where pubname='supabase_realtime') then create publication supabase_realtime; end if;
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='messages') then alter publication supabase_realtime add table public.messages; end if;
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='friendships') then alter publication supabase_realtime add table public.friendships; end if;
end; $$;
commit;
