-- Run only after schema.sql in a disposable/test Supabase project. Always rolls back.
begin;
insert into auth.users(id,aud,role,email) values
 ('10000000-0000-4000-8000-000000000001','authenticated','authenticated','rls-a@example.invalid'),
 ('10000000-0000-4000-8000-000000000002','authenticated','authenticated','rls-b@example.invalid');
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select public.goaltracker_write_state(0,'{"goals":[{"id":"a","title":"Private A"}],"transactions":[],"safetyFund":{},"profile":{"nickname":"A"},"financeOther":{},"calendar":{}}','20000000-0000-4000-8000-000000000001');
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',true);
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
do $$ begin
 if exists(select 1 from public.goals where user_id='10000000-0000-4000-8000-000000000001') then raise exception 'RLS READ LEAK'; end if;
 update public.goals set data='[]' where user_id='10000000-0000-4000-8000-000000000001';
 if found then raise exception 'RLS UPDATE LEAK'; end if;
 begin
  insert into public.goals(user_id,data) values('10000000-0000-4000-8000-000000000001','[]');
  raise exception 'RLS INSERT LEAK';
 exception when insufficient_privilege then null;
 end;
end; $$;
reset role;
set local role anon;
do $$ begin
 begin
  perform * from public.goals;
  raise exception 'ANON READ LEAK';
 exception when insufficient_privilege then null;
 end;
 begin
  perform public.goaltracker_read_state();
  raise exception 'ANON RPC LEAK';
 exception when insufficient_privilege then null;
 end;
end; $$;
rollback;
