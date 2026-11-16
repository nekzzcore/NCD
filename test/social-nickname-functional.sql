-- Disposable local fixture only. Tests functions/constraints, not RLS enforcement.
begin;
do $$ begin
 if not exists(select 1 from pg_policies where tablename='profiles' and policyname='Users can manage own profile') then raise exception 'ASSERT: owner policy removed'; end if;
 if (select count(distinct social_short_id) from public.profiles)<>3 then raise exception 'ASSERT: unique server IDs'; end if;
 if exists(select 1 from public.profiles where social_short_id<1000) then raise exception 'ASSERT: short ID format'; end if;
end $$;
update public.profiles set nickname=case user_id when '10000000-0000-4000-8000-000000000001' then 'UniqueName' else 'Same Name' end;
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
do $$ declare result jsonb; stable_id bigint; begin
 result:=public.social_search_nickname('uniquename');
 if jsonb_array_length(result->'profiles')<>1 or result->'profiles'->0->>'nickname'<>'UniqueName' then raise exception 'ASSERT: unique nickname search'; end if;
 if result->'profiles'->0->>'short_id' !~ '^#[0-9]{4,}$' then raise exception 'ASSERT: formatted short ID'; end if;
 if (select count(*) from jsonb_object_keys(result->'profiles'->0))<>4 then raise exception 'ASSERT: excess public fields'; end if;
 if public.social_search_nickname('missing')->>'state'<>'not_found' then raise exception 'ASSERT: missing nickname'; end if;
 if public.social_search_nickname('@UniqueName')->>'state'<>'invalid_input' then raise exception 'ASSERT: alias syntax accepted'; end if;
 if public.social_search_nickname('mail@invalid')->>'state'<>'invalid_input' then raise exception 'ASSERT: email-like input accepted'; end if;
 result:=public.social_search_nickname('same name');
 if jsonb_array_length(result->'profiles')<>2 or result->'profiles'->0->>'short_id'=result->'profiles'->1->>'short_id' then raise exception 'ASSERT: duplicate nicknames must have separate IDs'; end if;
 if result::text like '%private-avatar%' or result::text like '%email%' then raise exception 'ASSERT: private fields leaked'; end if;
 select social_short_id into stable_id from public.profiles where user_id=auth.uid();
 update public.profiles set nickname='Renamed' where user_id=auth.uid();
 if (select social_short_id from public.profiles where user_id=auth.uid())<>stable_id then raise exception 'ASSERT: ID changed after rename'; end if;
 begin update public.profiles set social_short_id=social_short_id+100000 where user_id=auth.uid(); raise exception 'ASSERT: ID editable'; exception when insufficient_privilege then null; end;
 if public.social_search_nickname('Renamed')->'profiles'->0->>'short_id'<>'#'||stable_id::text then raise exception 'ASSERT: renamed lookup changed ID'; end if;
 if public.social_request_nickname(auth.uid())->>'state'<>'self_request' then raise exception 'ASSERT: self request'; end if;
 if public.social_request_nickname('10000000-0000-4000-8000-000000000002')->>'state'<>'request_sent' then raise exception 'ASSERT: request send'; end if;
 if public.social_request_nickname('10000000-0000-4000-8000-000000000002')->>'state'<>'request_exists' then raise exception 'ASSERT: duplicate request'; end if;
 if (select count(*) from public.friendships where recipient_id='10000000-0000-4000-8000-000000000002')<>1 or exists(select 1 from public.friendships where recipient_id='10000000-0000-4000-8000-000000000003') then raise exception 'ASSERT: wrong duplicate-name recipient'; end if;
end $$;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',true);
do $$ declare request uuid; begin
 select id into request from public.friendships where recipient_id=auth.uid();perform public.social_respond(request,true);
 if (select nickname from public.social_people() limit 1)<>'Renamed' then raise exception 'ASSERT: friend nickname not ordinary profile name'; end if;
end $$;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
do $$ begin
 if public.social_request_nickname('10000000-0000-4000-8000-000000000002')->>'state'<>'already_friends' then raise exception 'ASSERT: already friends'; end if;
 perform public.social_request_nickname('10000000-0000-4000-8000-000000000003');
end $$;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000003',true);
do $$ declare request uuid; begin
 select id into request from public.friendships where recipient_id=auth.uid();perform public.social_respond(request,false);
 if (select status from public.friendships where id=request)<>'rejected' then raise exception 'ASSERT: reject failed'; end if;
end $$;
reset role;
do $$ declare generated uuid; begin
 insert into auth.users(id,email_confirmed_at) values(gen_random_uuid(),now()) returning id into generated;
 if not exists(select 1 from public.profiles where user_id=generated and social_short_id is not null) then raise exception 'ASSERT: no automatic account ID'; end if;
 for i in 1..55 loop
  insert into auth.users(id,email_confirmed_at) values(gen_random_uuid(),now()) returning id into generated;
  update public.profiles set nickname='Duplicate Page' where user_id=generated;
 end loop;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
do $$ declare first_page jsonb; second_page jsonb; begin
 first_page:=public.social_search_nickname('Duplicate Page');
 if jsonb_array_length(first_page->'profiles')<>50 or first_page->>'next_cursor' is null then raise exception 'ASSERT: first page'; end if;
 second_page:=public.social_search_nickname('Duplicate Page',(first_page->>'next_cursor')::bigint);
 if jsonb_array_length(second_page->'profiles')<>5 or second_page->>'next_cursor' is not null then raise exception 'ASSERT: missing duplicate-name matches'; end if;
 if exists(select 1 from jsonb_array_elements(first_page->'profiles') a cross join jsonb_array_elements(second_page->'profiles') b where a->>'user_id'=b->>'user_id') then raise exception 'ASSERT: duplicate pagination rows'; end if;
end $$;
reset role;
delete from goaltracker_private.social_rate_limits;
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
do $$ begin
 for i in 1..20 loop perform public.social_search_nickname('missing'); end loop;
 if public.social_search_nickname('Renamed')->>'state'<>'rate_limited' then raise exception 'ASSERT: search rate limit'; end if;
 for i in 1..5 loop perform public.social_request_nickname('10000000-0000-4000-8000-000000000002'); end loop;
 if public.social_request_nickname('10000000-0000-4000-8000-000000000002')->>'state'<>'rate_limited' then raise exception 'ASSERT: request rate limit'; end if;
end $$;
rollback;
