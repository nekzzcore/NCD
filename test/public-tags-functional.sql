-- Function/constraint tests for isolated standalone PostgreSQL; NOT an RLS check.
-- Disposable test database with test/public-tags-fixture.sql + social.sql +
-- migrations/20261021_public_alias.sql. Never run this fixture on production.
begin;
do $$ begin
 if not exists(select 1 from pg_policies where tablename='profiles' and policyname='Users can manage own profile') then raise exception 'ASSERT: existing policy removed'; end if;
 if exists(select 1 from public.profiles where public_tag is not null or public_tag_custom) then raise exception 'ASSERT: alias auto-assigned'; end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000003',true);
do $$ begin
 if public.social_identity()->>'public_tag' is not null then raise exception 'ASSERT: unexpected generated alias'; end if;
 if public.social_search_alias('@sayonara76')->>'state'<>'alias_required' then raise exception 'ASSERT: alias required before search'; end if;
 if public.social_set_identity('@third_user','Игрок В',false)->>'state'<>'saved' then raise exception 'ASSERT: third alias save'; end if;
end $$;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
do $$ declare response jsonb; begin
 if public.social_set_identity(' @SaYoNaRa76 ','Игрок А',false)->>'state'<>'saved' then raise exception 'ASSERT: normalized tag save'; end if;
 if public.social_identity()->>'public_tag'<>'@sayonara76' then raise exception 'ASSERT: normalization'; end if;
 if public.social_set_identity('no_at','Игрок А',false)->>'state'<>'invalid_input' then raise exception 'ASSERT: @ is required'; end if;
 if public.social_set_identity('@has space','Игрок А',false)->>'state'<>'invalid_input' then raise exception 'ASSERT: internal spaces accepted'; end if;
 if public.social_set_identity('@has#1234','Игрок А',false)->>'state'<>'invalid_input' then raise exception 'ASSERT: discriminator accepted'; end if;
 if public.social_set_identity('private@invalid','Игрок А',false)->>'state'<>'invalid_input' then raise exception 'ASSERT: email-like tag accepted'; end if;
 if public.social_set_identity('@player_valid','Private@Name',false)->>'state'<>'invalid_input' then raise exception 'ASSERT: email-like public name accepted'; end if;
 if public.social_request_alias('10000000-0000-4000-8000-000000000001')->>'state'<>'self_request' then raise exception 'ASSERT: self request'; end if;
 update public.profiles set nickname='Local sync still works',revision=revision+1 where user_id=auth.uid();
 if not found then raise exception 'ASSERT: ordinary sync update blocked'; end if;
end $$;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',true);
do $$ declare response jsonb; begin
 if public.social_set_identity('@SAYONARA76','Игрок Б',false)->>'state'<>'tag_taken' then raise exception 'ASSERT: duplicate tag accepted'; end if;
 if public.social_identity()->>'public_tag' is not null then raise exception 'ASSERT: occupied alias auto-suffixed'; end if;
 if public.social_set_identity('@player_b','Игрок Б',false)->>'state'<>'saved' then raise exception 'ASSERT: second tag save'; end if;
 response:=public.social_search_alias(' @SAYONARA76 ');
 if response->>'state'<>'found' or response->'profile'->>'display_name'<>'Игрок А' or response->'profile'->>'avatar'<>'' then raise exception 'ASSERT: search/privacy'; end if;
 if (select count(*) from jsonb_object_keys(response->'profile'))<>4 then raise exception 'ASSERT: excess search fields'; end if;
 if response::text like '%Private%' or response::text like '%email%' then raise exception 'ASSERT: private fields exposed'; end if;
 if public.social_search_alias('@missing_tag')->>'state'<>'not_found' then raise exception 'ASSERT: not-found result'; end if;
 if public.social_search_alias('invalid@tag')->>'state'<>'invalid_input' then raise exception 'ASSERT: invalid tag accepted'; end if;
 response:=public.social_request_alias('10000000-0000-4000-8000-000000000001');
 if response->>'state'<>'request_sent' then raise exception 'ASSERT: request state'; end if;
 if public.social_request_alias('10000000-0000-4000-8000-000000000001')->>'state'<>'request_exists' then raise exception 'ASSERT: duplicate request'; end if;
 if (select count(*) from public.friendships)<>1 then raise exception 'ASSERT: duplicate rows'; end if;
 begin perform public.social_respond((response->>'friendship_id')::uuid,true); raise exception 'ASSERT: sender accepted own request'; exception when raise_exception then if sqlerrm like 'ASSERT:%' then raise; end if; end;
end $$;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
do $$ declare f uuid; begin
 select id into f from public.friendships;
 perform public.social_respond(f,true);
 if public.social_request_alias('10000000-0000-4000-8000-000000000002')->>'state'<>'already_friends' then raise exception 'ASSERT: already friends'; end if;
 if (select avatar from public.social_friends_alias())<>'' then raise exception 'ASSERT: private avatar leaked'; end if;
end $$;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',true);
select public.social_set_identity('@player_b','Игрок Б',true);
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
do $$ begin
 if public.social_search_alias('@player_b')->'profile'->>'avatar'<>'private-avatar' then raise exception 'ASSERT: public avatar consent'; end if;
 perform public.social_request_alias('10000000-0000-4000-8000-000000000003');
end $$;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000003',true);
do $$ declare f uuid; begin
 select id into f from public.friendships where recipient_id=auth.uid(); perform public.social_respond(f,false);
 if (select status from public.friendships where id=f)<>'rejected' then raise exception 'ASSERT: reject failed'; end if;
end $$;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
do $$ begin
 if public.social_request_alias('10000000-0000-4000-8000-000000000003')->>'state'<>'request_cooldown' then raise exception 'ASSERT: rejection cooldown'; end if;
end $$;
reset role;
delete from goaltracker_private.social_rate_limits;
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
do $$ declare i integer; begin
 for i in 1..20 loop
  if public.social_search_alias('@missing_tag')->>'state'<>'not_found' then raise exception 'ASSERT: search limit too early'; end if;
 end loop;
 if public.social_search_alias('@sayonara76')->>'state'<>'rate_limited' then raise exception 'ASSERT: search limit bypass'; end if;
 for i in 1..5 loop perform public.social_request_alias('10000000-0000-4000-8000-000000000002'); end loop;
 if public.social_request_alias('10000000-0000-4000-8000-000000000002')->>'state'<>'rate_limited' then raise exception 'ASSERT: request limit bypass'; end if;
 for i in 1..5 loop perform public.social_set_identity('@player_b','Игрок А',false); end loop;
 if public.social_set_identity('@free_tag','Игрок А',false)->>'state'<>'rate_limited' then raise exception 'ASSERT: rejected unique conflicts rolled back counters'; end if;
end $$;
reset role;
rollback;
