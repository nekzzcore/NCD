-- Apply in Supabase SQL Editor after schema.sql.
begin;
insert into storage.buckets(id, name, public)
values ('goal-attachments', 'goal-attachments', true)
on conflict(id) do update set public = true;
drop policy if exists goal_attachments_insert on storage.objects;
create policy goal_attachments_insert on storage.objects for insert to authenticated
with check (bucket_id = 'goal-attachments' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists goal_attachments_select on storage.objects;
create policy goal_attachments_select on storage.objects for select to authenticated
using (bucket_id = 'goal-attachments' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists goal_attachments_delete on storage.objects;
create policy goal_attachments_delete on storage.objects for delete to authenticated
using (bucket_id = 'goal-attachments' and (storage.foldername(name))[1] = auth.uid()::text);
commit;
