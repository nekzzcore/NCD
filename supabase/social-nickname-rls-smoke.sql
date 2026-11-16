-- Only on an ordinary disposable server with test/public-tags-fixture.sql,
-- social.sql and the new nickname migration. Never run fixtures on production.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
do $$ begin
 if not row_security_active('public.profiles') then raise exception 'RLS_TEST_REQUIRES_NORMAL_SERVER'; end if;
 if (select count(*) from public.profiles)<>1 then raise exception 'ASSERT: profile read leak'; end if;
 begin update public.profiles set social_short_id=999999 where user_id=auth.uid(); raise exception 'ASSERT: ID editable'; exception when insufficient_privilege then null; end;
 begin insert into public.friendships(requester_id,recipient_id) values(auth.uid(),'10000000-0000-4000-8000-000000000002'); raise exception 'ASSERT: direct request bypass'; exception when insufficient_privilege then null; end;
 perform public.social_request_nickname('10000000-0000-4000-8000-000000000002');
end $$;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000003',true);
do $$ begin
 if exists(select 1 from public.friendships) then raise exception 'ASSERT: outsider sees requests'; end if;
end $$;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',true);
do $$ declare request uuid; begin
 if (select count(*) from public.friendships)<>1 then raise exception 'ASSERT: recipient cannot read own request'; end if;
 select id into request from public.friendships where recipient_id=auth.uid();perform public.social_respond(request,true);
end $$;
reset role;
set local role anon;
do $$ begin
 begin perform public.social_search_nickname('Example'); raise exception 'ASSERT: anonymous search'; exception when insufficient_privilege then null; end;
 begin perform * from public.profiles; raise exception 'ASSERT: anonymous profiles'; exception when insufficient_privilege then null; end;
end $$;
rollback;
