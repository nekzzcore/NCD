-- Optional fallback if profiles has neither these JSONB columns nor JSONB extra.
-- Review/apply in Supabase SQL Editor; the client never executes DDL.
begin;
do $$
declare column_name_value text; existing_type text; owner_column text;
begin
 if to_regclass('public.profiles') is null then raise exception 'public.profiles does not exist'; end if;
 foreach column_name_value in array array['portfolio','learning_chess','learning_books','learning_topics'] loop
  select data_type into existing_type from information_schema.columns
   where table_schema='public' and table_name='profiles' and column_name=column_name_value;
  if existing_type is null then
   execute format('alter table public.profiles add column %I jsonb not null default ''[]''::jsonb',column_name_value);
  elsif existing_type <> 'jsonb' then
   raise exception 'profiles.% must be jsonb, found %; no type conversion was performed',column_name_value,existing_type;
  end if;
 end loop;
 -- Preserve previously shipped Case/Learning data from the legacy profile document.
 select column_name into owner_column from information_schema.columns
  where table_schema='public' and table_name='profiles' and column_name in ('id','user_id')
  order by case column_name when 'id' then 0 else 1 end limit 1;
 if owner_column is null then raise exception 'profiles owner key was not found'; end if;
 if exists(select 1 from information_schema.columns where table_schema='public' and table_name='user_profile' and column_name='data' and data_type='jsonb')
 and exists(select 1 from information_schema.columns where table_schema='public' and table_name='user_profile' and column_name='user_id') then
  execute format($sql$
   update public.profiles p set
    portfolio=coalesce(u.data #> '{workspace,portfolio}','[]'::jsonb),
    learning_chess=coalesce(u.data #> '{workspace,eloHistory}','[]'::jsonb),
    learning_books=coalesce(u.data #> '{workspace,books}','[]'::jsonb),
    learning_topics=coalesce(u.data #> '{workspace,topics}','[]'::jsonb)
   from public.user_profile u where p.%I=u.user_id
    and jsonb_typeof(u.data->'workspace')='object'
    and coalesce(p.portfolio,'[]'::jsonb)='[]'::jsonb
    and coalesce(p.learning_chess,'[]'::jsonb)='[]'::jsonb
    and coalesce(p.learning_books,'[]'::jsonb)='[]'::jsonb
    and coalesce(p.learning_topics,'[]'::jsonb)='[]'::jsonb
    and jsonb_typeof(coalesce(u.data #> '{workspace,portfolio}','[]'::jsonb))='array'
    and jsonb_typeof(coalesce(u.data #> '{workspace,eloHistory}','[]'::jsonb))='array'
    and jsonb_typeof(coalesce(u.data #> '{workspace,books}','[]'::jsonb))='array'
    and jsonb_typeof(coalesce(u.data #> '{workspace,topics}','[]'::jsonb))='array'
  $sql$,owner_column);
 end if;
end $$;
notify pgrst, 'reload schema';
commit;
