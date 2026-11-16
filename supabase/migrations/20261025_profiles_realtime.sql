-- Optional: run only if profiles is not already enabled in Supabase Realtime.
-- Existing RLS and access grants are unchanged.
do $$ begin
 if not exists(select 1 from pg_publication where pubname='supabase_realtime') then
  raise exception 'Enable the supabase_realtime publication first';
 end if;
 if not exists(select 1 from pg_publication where pubname='supabase_realtime' and puballtables)
 and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='profiles') then
  alter publication supabase_realtime add table public.profiles;
 end if;
end $$;
