-- Allow the fourth UI priority on existing deployments. No goal data is changed.
begin;
alter table public.goals drop constraint if exists goals_priority_check;
alter table public.goals add constraint goals_priority_check
    check (priority in ('low', 'medium', 'high', 'critical', 'milestone'));
commit;
