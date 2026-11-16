-- Read-only. Review in the intended project; no migration is executed here.
select table_name,column_name,data_type,is_nullable from information_schema.columns
 where table_schema='public' and table_name in ('profiles','friendships','user_profile','goals') order by table_name,ordinal_position;
select tablename,policyname,roles,cmd,qual,with_check from pg_policies
 where schemaname='public' and tablename in ('profiles','friendships','messages') order by tablename,policyname;
select c.relname,c.relrowsecurity,c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relname in ('profiles','friendships','messages');
select p.proname,pg_get_function_identity_arguments(p.oid) as arguments from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname like 'social_%' order by p.proname;
