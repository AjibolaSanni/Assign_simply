-- Administration audit trail and server-enforced protection for the last administrator.
create table if not exists public.activity_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null check (length(trim(action)) between 1 and 80),
  target_type text not null check (length(trim(target_type)) between 1 and 80),
  target_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists activity_logs_created_idx on public.activity_logs(created_at desc);
create index if not exists activity_logs_actor_idx on public.activity_logs(actor_id,created_at desc);
alter table public.activity_logs enable row level security;
revoke all on public.activity_logs from anon,authenticated;
grant select on public.activity_logs to authenticated;
drop policy if exists "administrators read activity logs" on public.activity_logs;
create policy "administrators read activity logs" on public.activity_logs
for select to authenticated using (public.current_app_role()='administrator');

create or replace function public.guard_last_administrator()
returns trigger language plpgsql set search_path='' as $$
begin
  perform pg_advisory_xact_lock(hashtext('assignsimply_admin_role_guard'));
  if old.role='administrator' and new.role is distinct from 'administrator'
  then
    if (select count(*) from public.profiles where role='administrator') <= 1 then
      raise exception 'The last administrator account cannot be demoted';
    end if;
  end if;
  if old.role='lecturer' and new.role is distinct from 'lecturer'
    and exists(select 1 from public.courses where lecturer_id=old.id) then
    raise exception 'Reassign this lecturer’s courses before changing their role';
  end if;
  return new;
end;
$$;
drop trigger if exists profiles_guard_last_administrator on public.profiles;
create trigger profiles_guard_last_administrator before update of role on public.profiles
for each row execute function public.guard_last_administrator();
revoke all on function public.guard_last_administrator() from public,anon,authenticated;

create or replace function public.admin_change_user_role(p_actor_id uuid,p_target_id uuid,p_new_role public.app_role)
returns void language plpgsql security definer set search_path='' as $$
declare old_role public.app_role;
begin
  perform pg_advisory_xact_lock(hashtext('assignsimply_admin_role_guard'));
  if not exists(select 1 from public.profiles where id=p_actor_id and role='administrator') then
    raise exception 'Administrator access is required';
  end if;
  if p_actor_id=p_target_id then raise exception 'You cannot change your own role'; end if;
  select role into old_role from public.profiles where id=p_target_id for update;
  if not found then raise exception 'The selected user profile was not found'; end if;
  if old_role=p_new_role then return; end if;
  perform set_config('assignsimply.actor_id',p_actor_id::text,true);
  update public.profiles set role=p_new_role where id=p_target_id;
end;
$$;
revoke all on function public.admin_change_user_role(uuid,uuid,public.app_role) from public,anon,authenticated;
grant execute on function public.admin_change_user_role(uuid,uuid,public.app_role) to service_role;

create or replace function public.capture_activity_log()
returns trigger language plpgsql security definer set search_path='' as $$
declare
  row_data jsonb;
  event_action text;
  event_target uuid;
  event_actor uuid;
  safe_metadata jsonb := '{}'::jsonb;
begin
  event_action := lower(tg_op);
  row_data := case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
  event_target := (row_data->>'id')::uuid;
  event_actor := auth.uid();
  if tg_table_name='profiles' then
    if tg_op='INSERT' then
      event_action := 'user_registered'; event_actor := coalesce(event_actor,event_target);
      safe_metadata := jsonb_build_object('role',row_data->>'role');
    elsif old.role is distinct from new.role then
      event_action := 'role_changed';
      event_actor := coalesce(event_actor,nullif(current_setting('assignsimply.actor_id',true),'')::uuid);
      safe_metadata := jsonb_build_object('old_role',old.role,'new_role',new.role);
    else
      return new;
    end if;
  elsif tg_table_name='courses' then
    safe_metadata := jsonb_build_object('code',row_data->>'code','title',row_data->>'title','lecturer_id',row_data->>'lecturer_id');
  elsif tg_table_name='assignments' then
    if row_data->>'status'='published' and (tg_op='INSERT' or old.status is distinct from 'published') then event_action := 'assignment_published'; end if;
    safe_metadata := jsonb_build_object('title',row_data->>'title','course_id',row_data->>'course_id','status',row_data->>'status');
  elsif tg_table_name='enrolments' then
    safe_metadata := jsonb_build_object('course_id',row_data->>'course_id','student_id',row_data->>'student_id');
  elsif tg_table_name='submissions' then
    if tg_op='UPDATE' and old.file_path is distinct from new.file_path then event_action := 'submission_resubmitted'; end if;
    safe_metadata := jsonb_build_object('assignment_id',row_data->>'assignment_id','student_id',row_data->>'student_id','is_late',row_data->>'is_late');
  elsif tg_table_name='grades' then
    if row_data->>'published_at' is not null and (tg_op='INSERT' or old.published_at is null) then event_action := 'grade_published'; end if;
    safe_metadata := jsonb_build_object('submission_id',row_data->>'submission_id','points',row_data->>'points','published',row_data->>'published_at' is not null);
  end if;
  insert into public.activity_logs(actor_id,action,target_type,target_id,metadata)
  values(event_actor,event_action,tg_table_name,event_target,safe_metadata);
  if tg_op='DELETE' then return old; else return new; end if;
end;
$$;

drop trigger if exists profiles_activity_log on public.profiles;
create trigger profiles_activity_log after insert or update of role on public.profiles
for each row execute function public.capture_activity_log();
drop trigger if exists courses_activity_log on public.courses;
create trigger courses_activity_log after insert or update or delete on public.courses
for each row execute function public.capture_activity_log();
drop trigger if exists enrolments_activity_log on public.enrolments;
create trigger enrolments_activity_log after insert or update or delete on public.enrolments
for each row execute function public.capture_activity_log();
drop trigger if exists assignments_activity_log on public.assignments;
create trigger assignments_activity_log after insert or update or delete on public.assignments
for each row execute function public.capture_activity_log();
drop trigger if exists submissions_activity_log on public.submissions;
create trigger submissions_activity_log after insert or update on public.submissions
for each row execute function public.capture_activity_log();
drop trigger if exists grades_activity_log on public.grades;
create trigger grades_activity_log after insert or update on public.grades
for each row execute function public.capture_activity_log();
revoke all on function public.capture_activity_log() from public,anon,authenticated;

notify pgrst, 'reload schema';
