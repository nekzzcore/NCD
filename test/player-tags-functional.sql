-- Runs only after player-tags-fixture.sql and the migration in a disposable cluster.
do $$ declare tag text; result jsonb; stable_tag text; uid uuid; begin
 if exists(select 1 from public.profiles where short_id !~ '^#[A-Z0-9]{6,8}$' or short_id is null)
 or (select count(*)<>count(distinct short_id) from public.profiles) then raise exception 'ASSERT: format/uniqueness'; end if;
 if (select short_id from public.profiles where id='10000000-0000-4000-8000-000000000001')<>'#XXXXXX76'
 or (select short_id from public.profiles where id='10000000-0000-4000-8000-000000000002')<>'#XXXXX276' then raise exception 'ASSERT: reserved owner tags'; end if;
 if (select short_id from public.profiles where id='10000000-0000-4000-8000-000000000004')<>'#ABC123' then raise exception 'ASSERT: valid legacy tag changed'; end if;
 if exists(select * from public.profiles except select * from public.player_tags_snapshot)
 or exists(select * from public.player_tags_snapshot except select * from public.profiles) then raise exception 'ASSERT: repeated migration changed identities'; end if;
 for i in 1..200 loop
  uid:=gen_random_uuid();
  insert into auth.users(id,email) values(uid,'player-'||uid::text||'@example.invalid');
  if not exists(select 1 from public.profiles where id=uid and short_id ~ '^#[A-Z0-9]{8}$') then raise exception 'ASSERT: automatic signup profile/tag'; end if;
 end loop;
 uid:=gen_random_uuid();insert into auth.users(id,email) values(uid,'client-tag@example.invalid');
 select short_id into stable_tag from public.profiles where id=uid;
 -- Simulate PostgREST upsert: the insert trigger must reuse the existing owner's tag.
 insert into public.profiles(id,username,short_id) values(uid,'New name','#HACKED76')
 on conflict(id) do update set username=excluded.username;
 if (select short_id from public.profiles where id=uid)<>stable_tag then raise exception 'ASSERT: upsert changed tag'; end if;
 begin update public.profiles set short_id='#HACKED76' where id=uid;
  raise exception 'ASSERT: client changed tag'; exception when insufficient_privilege then null; end;
 if (select count(*)<>count(distinct short_id) from public.profiles) then raise exception 'ASSERT: duplicate generated tags'; end if;
 perform set_config('request.jwt.claim.sub','',false);
 begin perform public.social_search_player_tag('#ABC123');raise exception 'ASSERT: anonymous lookup';
  exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000003',false);
 result:=public.social_search_player_tag('abc123');
 if result->>'state'<>'found' or result->'profiles'->0->>'user_id'<>'10000000-0000-4000-8000-000000000004'
 or result->'profiles'->0->>'short_id'<>'#ABC123'
 or result->'profiles'->0 ? 'email' or result->'profiles'->0 ? 'handle' then raise exception 'ASSERT: exact tag lookup/privacy'; end if;
 if public.social_search_player_tag('@friend')->>'state'<>'invalid_input'
 or public.social_search_player_tag('#ABC124')->>'state'<>'not_found' then raise exception 'ASSERT: nickname/fuzzy lookup'; end if;
 if not exists(select 1 from public.social_people_players() person where person->>'short_id'='#ABC123') then raise exception 'ASSERT: old friend tag escaped'; end if;
 if public.social_friend_player_profile('10000000-0000-4000-8000-000000000004')->>'short_id'<>'#ABC123' then raise exception 'ASSERT: profile tag'; end if;
 begin perform public.social_friend_player_profile('10000000-0000-4000-8000-000000000005');raise exception 'ASSERT: nonfriend profile';
 exception when insufficient_privilege then null; end;
 if has_function_privilege('anon','public.social_search_player_tag(text)','execute')
 or has_function_privilege('authenticated','ncd_private.allocate_player_tag(uuid)','execute') then raise exception 'ASSERT: function grants'; end if;
end $$;
