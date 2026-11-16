do $$ begin
 if (select count(*) from public.profiles)<>3 then raise exception 'ASSERT: profile lost during upgrade'; end if;
 if exists(select 1 from public.test_alias_before b join public.profiles p using(user_id) where p.public_tag is distinct from b.public_tag or p.public_tag_custom is distinct from b.public_tag_custom) then raise exception 'ASSERT: existing alias values changed'; end if;
 if public.social_identity()->>'public_tag'<>'@keep_me' then raise exception 'ASSERT: chosen alias not preserved'; end if;
end $$;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',false);
do $$ begin
 if public.social_identity()->>'public_tag' is not null then raise exception 'ASSERT: old generated string displayed'; end if;
 if public.social_search_alias('@keep_me')->>'state'<>'alias_required' then raise exception 'ASSERT: alias_required'; end if;
 if public.social_set_identity('@chosen_name','Nickname B',false)->>'state'<>'saved' then raise exception 'ASSERT: manual alias selection'; end if;
 if public.social_identity()->>'public_tag'<>'@chosen_name' then raise exception 'ASSERT: unexpected automatic suffix'; end if;
end $$;
