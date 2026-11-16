begin;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
do $$ declare r jsonb; begin
 r:=public.social_search_nickname('samename');
 if jsonb_array_length(r->'profiles')<>2 then raise exception 'ASSERT: duplicate usernames'; end if;
 if r->'profiles'->0->>'user_id'<>'10000000-0000-4000-8000-000000000002' or r->'profiles'->0->>'username'<>'SameName' or r->'profiles'->0->>'short_id'<>'#4822' then raise exception 'ASSERT: account mapping'; end if;
 if r->'profiles'->1->>'short_id'<>'AB123' then raise exception 'ASSERT: short ID omitted'; end if;
 if (select count(*) from jsonb_object_keys(r->'profiles'->0))<>3 or r::text like '%avatar%' or r::text like '%private.invalid%' or r::text like '%email%' then raise exception 'ASSERT: excess/private fields'; end if;
 if public.social_search_nickname('UniqueName')->>'state'<>'not_found' then raise exception 'ASSERT: self exclusion'; end if;
 if public.social_search_nickname('missing')->>'state'<>'not_found' then raise exception 'ASSERT: missing account'; end if;
 if public.social_search_nickname('someone@invalid')->>'state'<>'invalid_input' then raise exception 'ASSERT: invalid input'; end if;
end $$;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000003',true);
do $$ begin
 if public.social_search_nickname(' uniquename ')->'profiles'->0->>'user_id'<>'10000000-0000-4000-8000-000000000001' then raise exception 'ASSERT: unique username'; end if;
end $$;
select set_config('request.jwt.claim.sub','',true);
do $$ begin
 begin perform public.social_search_nickname('SameName'); raise exception 'ASSERT: no-session access'; exception when insufficient_privilege then null; end;
 if exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid='public.social_search_nickname(text,bigint)'::regprocedure and a.privilege_type='EXECUTE' and a.grantee in(0,(select oid from pg_roles where rolname='anon'))) then raise exception 'ASSERT: anonymous execute'; end if;
 if exists(select * from public.profiles except select * from public.test_username_snapshot) then raise exception 'ASSERT: rows changed'; end if;
 if not exists(select 1 from pg_policies where tablename='profiles' and policyname='Users can manage own profile') then raise exception 'ASSERT: policy removed'; end if;
 if (select count(*) from information_schema.columns where table_schema='public' and table_name='profiles')<>6 then raise exception 'ASSERT: schema changed'; end if;
end $$;
rollback;
