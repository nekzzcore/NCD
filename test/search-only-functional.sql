-- RPC semantics checked in standalone PostgreSQL; this is NOT an RLS test.
begin;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
do $$ declare r jsonb; begin
 r:=public.social_search_nickname('SameName');
 if jsonb_array_length(r->'profiles')<>2 then raise exception 'ASSERT: missing duplicate matches'; end if;
 if (select count(*) from jsonb_object_keys(r->'profiles'->0))<>3 then raise exception 'ASSERT: excess search fields'; end if;
 if r->'profiles'->0->>'id'=r->'profiles'->1->>'id' then raise exception 'ASSERT: same ID for duplicate names'; end if;
 if r->'profiles'->0->>'avatar'<>'private-avatar' or r->'profiles'->1->>'avatar' is not null then raise exception 'ASSERT: avatar consent'; end if;
 if public.social_search_nickname('UniqueName')->>'state'<>'not_found' then raise exception 'ASSERT: self not excluded'; end if;
 if public.social_search_nickname('missing')->>'state'<>'not_found' then raise exception 'ASSERT: missing name'; end if;
 if public.social_search_nickname('someone@invalid')->>'state'<>'invalid_input' then raise exception 'ASSERT: email-like search accepted'; end if;
 if public.social_search_nickname('SameName',-1)->>'state'<>'invalid_input' then raise exception 'ASSERT: negative cursor accepted'; end if;
end $$;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000003',true);
do $$ declare r jsonb; begin
 r:=public.social_search_nickname(' uniquename ');
 if r->>'state'<>'found' or r->'profiles'->0->>'id'<>'10000000-0000-4000-8000-000000000001' then raise exception 'ASSERT: exact case-insensitive search'; end if;
end $$;
select set_config('request.jwt.claim.sub','',true);
do $$ begin
 begin perform public.social_search_nickname('SameName'); raise exception 'ASSERT: no-session search'; exception when insufficient_privilege then null; end;
 if exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid='public.social_search_nickname(text,bigint)'::regprocedure and a.privilege_type='EXECUTE' and a.grantee in (0,(select oid from pg_roles where rolname='anon'))) then raise exception 'ASSERT: anonymous EXECUTE granted'; end if;
end $$;
do $$ begin
 if exists(select 1 from public.profiles p join public.search_only_before b on (coalesce(to_jsonb(p)->>'user_id',to_jsonb(p)->>'id'))::uuid=b.user_id where (to_jsonb(p)-'user_id'-'id')<>(b.data-'user_id'-'id')) then raise exception 'ASSERT: migration changed profile data'; end if;
 if not exists(select 1 from pg_policies where tablename='profiles' and policyname='Users can manage own profile') then raise exception 'ASSERT: owner policy removed'; end if;
end $$;
rollback;
