-- After the previous draft, before the alias migration. Synthetic local data only.
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',false);
select public.social_set_identity('keep_me','Nickname',false);
create table public.test_alias_before as select user_id,public_tag,public_tag_custom from public.profiles;
