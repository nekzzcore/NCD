-- Run after schema.sql + social.sql in a disposable Supabase test project.
-- Verifies authorization with real Postgres roles. Everything rolls back.
begin;
insert into auth.users(id,aud,role,email,email_confirmed_at) values
 ('10000000-0000-4000-8000-000000000001','authenticated','authenticated','social-a@example.invalid',now()),
 ('10000000-0000-4000-8000-000000000002','authenticated','authenticated','social-b@example.invalid',now()),
 ('10000000-0000-4000-8000-000000000003','authenticated','authenticated','social-c@example.invalid',now());
insert into public.friendships(id,requester_id,recipient_id,status) values
 ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','pending');
insert into public.goals(user_id,data) values ('10000000-0000-4000-8000-000000000002',
 '[{"id":"private","title":"Hidden","status":"active","subgoals":[]},{"id":"progress","title":"Half done","subgoals":[{"completed":true},{"completed":false}],"files":[{"url":"private"}]},{"id":"public","title":"Public","status":"public"}]')
 on conflict(user_id) do update set data=excluded.data;
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
do $$ begin
 begin
  perform public.social_respond('20000000-0000-4000-8000-000000000001',true);
  raise exception 'SENDER ACCEPTED OWN REQUEST';
 exception when raise_exception then if sqlerrm='SENDER ACCEPTED OWN REQUEST' then raise; end if; end;
 begin
  perform public.social_profile('10000000-0000-4000-8000-000000000002');
  raise exception 'PENDING FRIEND READ PROFILE';
 exception when raise_exception then if sqlerrm='PENDING FRIEND READ PROFILE' then raise; end if; end;
 begin
  insert into public.messages(sender_id,recipient_id,body) values('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','Not accepted');
  raise exception 'PENDING FRIEND SENT MESSAGE';
 exception when insufficient_privilege then null; end;
end; $$;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',true);
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
select public.social_respond('20000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
insert into public.messages(id,sender_id,recipient_id,body) values ('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','Private conversation');
do $$ declare profile jsonb; begin
 select public.social_profile('10000000-0000-4000-8000-000000000002') into profile;
 if jsonb_array_length(profile->'goals')<>2 or profile::text like '%Hidden%' or profile::text like '%files%' then raise exception 'GOAL PROJECTION LEAK'; end if;
 if exists(select 1 from public.goals where user_id='10000000-0000-4000-8000-000000000002') then raise exception 'RAW GOAL LEAK'; end if;
 begin
  insert into public.messages(sender_id,recipient_id,body) values('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000003','Not my friend');
  raise exception 'SENT TO NONFRIEND';
 exception when insufficient_privilege then null; end;
 begin
  insert into public.messages(sender_id,recipient_id,body) values('10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','Forged sender');
  raise exception 'FORGED SENDER';
 exception when insufficient_privilege then null; end;
end; $$;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000003',true);
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
do $$ begin
 if exists(select 1 from public.messages) then raise exception 'THIRD PARTY READ MESSAGES'; end if;
 if exists(select 1 from public.friendships) then raise exception 'THIRD PARTY READ FRIENDSHIPS'; end if;
 begin
  perform public.social_profile('10000000-0000-4000-8000-000000000002');
  raise exception 'THIRD PARTY READ PROFILE';
 exception when raise_exception then if sqlerrm='THIRD PARTY READ PROFILE' then raise; end if; end;
end; $$;
reset role;
set local role anon;
do $$ begin
 begin perform * from public.messages; raise exception 'ANON READ MESSAGES'; exception when insufficient_privilege then null; end;
 begin perform public.social_search('social-a@example.invalid'); raise exception 'ANON SEARCH'; exception when insufficient_privilege then null; end;
end; $$;
rollback;
