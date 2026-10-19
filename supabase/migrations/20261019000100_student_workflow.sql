-- AssignSimply student workflow extensions. Preserves current assignments and submissions.
alter table public.assignments
  add column if not exists status text not null default 'published'
    check (status in ('draft','published','closed')),
  add column if not exists published_at timestamptz,
  add column if not exists allow_late_submissions boolean not null default false,
  add column if not exists allowed_file_extensions text[] not null default array['pdf','doc','docx','ppt','pptx','xls','xlsx'],
  add column if not exists max_submission_file_size bigint not null default 20971520
    check (max_submission_file_size > 0 and max_submission_file_size <= 52428800);

-- Assignments that existed before publication states existed remain available.
update public.assignments set published_at = created_at
where status = 'published' and published_at is null;

create table if not exists public.assignment_attachments (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.assignments(id) on delete cascade,
  file_path text not null unique,
  file_name text not null check (length(trim(file_name)) between 1 and 255),
  mime_type text not null,
  file_size bigint not null check (file_size > 0 and file_size <= 52428800),
  uploaded_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  check (file_path like (assignment_id::text || '/%'))
);
create index if not exists assignment_attachments_assignment_idx on public.assignment_attachments(assignment_id);

create table if not exists public.submission_versions (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.submissions(id) on delete cascade,
  version_number integer not null check (version_number > 0),
  file_path text not null unique,
  file_name text not null check (length(trim(file_name)) between 1 and 255),
  submitted_at timestamptz not null,
  is_late boolean not null default false,
  unique (submission_id, version_number)
);
create index if not exists submission_versions_submission_idx on public.submission_versions(submission_id, version_number desc);
alter table public.submissions add column if not exists is_late boolean not null default false;
alter table public.notifications add column if not exists related_assignment_id uuid references public.assignments(id) on delete set null;
alter table public.notifications add column if not exists related_grade_id uuid references public.grades(id) on delete set null;

-- Preserve existing submission files as the first history version.
insert into public.submission_versions(submission_id,version_number,file_path,file_name,submitted_at,is_late)
select s.id,1,s.file_path,s.file_name,s.submitted_at,s.is_late
from public.submissions s
where not exists(select 1 from public.submission_versions v where v.submission_id=s.id);

alter table public.assignment_attachments enable row level security;
alter table public.submission_versions enable row level security;
grant select on public.assignment_attachments,public.submission_versions to authenticated;
grant insert,update,delete on public.assignment_attachments to authenticated;

drop policy if exists "assignment member read" on public.assignments;
drop policy if exists "published assignments visible to course members" on public.assignments;
create policy "published assignments visible to course members" on public.assignments for select to authenticated
using (
  public.current_app_role()='administrator'
  or public.is_course_lecturer(course_id)
  or (status='published' and exists(select 1 from public.enrolments e where e.course_id=assignments.course_id and e.student_id=(select auth.uid())))
);
drop policy if exists "lecturer creates assignments" on public.assignments;
create policy "lecturer creates assignments" on public.assignments for insert to authenticated
with check (public.is_course_lecturer(course_id) and status in ('draft','published','closed'));
drop policy if exists "lecturer admin updates assignments" on public.assignments;
create policy "lecturer admin updates assignments" on public.assignments for update to authenticated
using (public.is_course_lecturer(course_id) or public.current_app_role()='administrator')
with check ((public.is_course_lecturer(course_id) or public.current_app_role()='administrator') and status in ('draft','published','closed'));
drop policy if exists "lecturer admin deletes assignments" on public.assignments;
create policy "lecturer admin deletes assignments" on public.assignments for delete to authenticated
using (public.is_course_lecturer(course_id) or public.current_app_role()='administrator');

drop policy if exists "attachments visible to assignment members" on public.assignment_attachments;
create policy "attachments visible to assignment members" on public.assignment_attachments for select to authenticated
using (
  public.current_app_role()='administrator'
  or public.is_assignment_lecturer(assignment_id)
  or exists(select 1 from public.assignments a join public.enrolments e on e.course_id=a.course_id
    where a.id=assignment_attachments.assignment_id and a.status='published' and e.student_id=(select auth.uid()))
);
drop policy if exists "lecturer manages assignment attachments" on public.assignment_attachments;
create policy "lecturer manages assignment attachments" on public.assignment_attachments for all to authenticated
using (public.is_assignment_lecturer(assignment_id) or public.current_app_role()='administrator')
with check (
  (public.is_assignment_lecturer(assignment_id) or public.current_app_role()='administrator')
  and uploaded_by=(select auth.uid())
  and exists(select 1 from public.assignments a where a.id=assignment_id)
);

drop policy if exists "submission version owner lecturer admin read" on public.submission_versions;
create policy "submission version owner lecturer admin read" on public.submission_versions for select to authenticated
using (
  public.current_app_role()='administrator'
  or exists(select 1 from public.submissions s where s.id=submission_versions.submission_id
    and (s.student_id=(select auth.uid()) or public.is_assignment_lecturer(s.assignment_id)))
);

drop policy if exists "enrolled student submits" on public.submissions;
create policy "enrolled student submits" on public.submissions for insert to authenticated
with check (
  student_id=(select auth.uid()) and public.current_app_role()='student'
  and exists(select 1 from public.assignments a join public.enrolments e on e.course_id=a.course_id
    where a.id=assignment_id and e.student_id=(select auth.uid()) and a.status='published'
      and (a.due_at is null or a.due_at>=now() or a.allow_late_submissions))
);
drop policy if exists "student resubmits when allowed" on public.submissions;
create policy "student resubmits when allowed" on public.submissions for update to authenticated
using (student_id=(select auth.uid()))
with check (
  student_id=(select auth.uid()) and exists(select 1 from public.assignments a
    where a.id=assignment_id and a.status='published' and a.allow_resubmissions
      and (a.due_at is null or a.due_at>=now() or a.allow_late_submissions))
);
-- Submissions are changed through submit_assignment(), which verifies the stored object and records a version.
revoke insert,update on public.submissions from authenticated;
grant select,delete on public.submissions to authenticated;

create or replace function public.capture_submission_version()
returns trigger language plpgsql security definer set search_path='' as $$
declare next_version integer;
begin
  if tg_op='INSERT' or new.file_path is distinct from old.file_path then
    select coalesce(max(v.version_number),0)+1 into next_version
      from public.submission_versions v where v.submission_id=new.id;
    insert into public.submission_versions(submission_id,version_number,file_path,file_name,submitted_at,is_late)
    values(new.id,next_version,new.file_path,new.file_name,new.submitted_at,new.is_late)
    on conflict(file_path) do nothing;
  end if;
  return new;
end;
$$;
drop trigger if exists submissions_capture_version on public.submissions;
create trigger submissions_capture_version after insert or update of file_path,file_name,submitted_at,is_late
on public.submissions for each row execute function public.capture_submission_version();

-- The RPC is the single client submission operation: it enforces the deadline,
-- resubmission and extension rules before changing the current submission.
create or replace function public.submit_assignment(p_assignment_id uuid,p_file_path text,p_file_name text)
returns public.submissions language plpgsql security definer set search_path='' as $$
declare
  uid uuid := auth.uid();
  assignment_row public.assignments%rowtype;
  existing_row public.submissions%rowtype;
  saved_row public.submissions%rowtype;
  extension text;
  file_meta jsonb;
  file_size bigint;
  is_late_now boolean;
begin
  if uid is null then raise exception 'Authentication required'; end if;
  if public.current_app_role() is distinct from 'student' then raise exception 'Only student accounts may submit assignments'; end if;
  select * into assignment_row from public.assignments where id=p_assignment_id for update;
  if not found or assignment_row.status<>'published' then raise exception 'Assignment is unavailable'; end if;
  if not exists(select 1 from public.enrolments e where e.course_id=assignment_row.course_id and e.student_id=uid) then raise exception 'You are not enrolled in this course'; end if;
  is_late_now := assignment_row.due_at is not null and assignment_row.due_at<now();
  if is_late_now and not assignment_row.allow_late_submissions then raise exception 'The submission deadline has passed'; end if;
  select * into existing_row from public.submissions where assignment_id=p_assignment_id and student_id=uid for update;
  if found and not assignment_row.allow_resubmissions then raise exception 'Resubmissions are not allowed for this assignment'; end if;
  if split_part(p_file_path,'/',1)<>uid::text or split_part(p_file_path,'/',2)<>p_assignment_id::text then raise exception 'Invalid submission file path'; end if;
  if p_file_name !~* '\.(pdf|doc|docx|ppt|pptx|xls|xlsx)$' then raise exception 'This file type is not supported'; end if;
  if storage.filename(p_file_path) is distinct from p_file_name then raise exception 'The uploaded file name does not match the object path'; end if;
  extension := lower(regexp_replace(p_file_name,'^.*\.',''));
  if not (extension=any(assignment_row.allowed_file_extensions)) then raise exception 'This file type is not allowed for the assignment'; end if;
  select o.metadata into file_meta from storage.objects o
    where o.bucket_id='submission-files' and o.name=p_file_path;
  if file_meta is null then raise exception 'Uploaded submission file was not found'; end if;
  file_size := coalesce((file_meta->>'size')::bigint,0);
  if file_size<=0 then raise exception 'The uploaded file is empty or has invalid metadata'; end if;
  if file_size>assignment_row.max_submission_file_size then raise exception 'The uploaded file exceeds the assignment file-size limit'; end if;
  if not coalesce((
    (extension='pdf' and file_meta->>'mimetype'='application/pdf')
    or (extension='doc' and file_meta->>'mimetype'='application/msword')
    or (extension='docx' and file_meta->>'mimetype'='application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    or (extension='ppt' and file_meta->>'mimetype'='application/vnd.ms-powerpoint')
    or (extension='pptx' and file_meta->>'mimetype'='application/vnd.openxmlformats-officedocument.presentationml.presentation')
    or (extension='xls' and file_meta->>'mimetype'='application/vnd.ms-excel')
    or (extension='xlsx' and file_meta->>'mimetype'='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  ),false) then raise exception 'The file content type does not match its extension'; end if;
  if existing_row.id is null then
    insert into public.submissions(assignment_id,student_id,file_path,file_name,submitted_at,is_late)
      values(p_assignment_id,uid,p_file_path,p_file_name,now(),is_late_now) returning * into saved_row;
  else
    update public.submissions set file_path=p_file_path,file_name=p_file_name,submitted_at=now(),is_late=is_late_now
      where id=existing_row.id returning * into saved_row;
  end if;
  insert into public.notifications(user_id,title,body,related_assignment_id,related_grade_id)
    values(uid,'Submission received',assignment_row.title || ' was submitted successfully.',p_assignment_id,null);
  return saved_row;
end;
$$;
revoke all on function public.submit_assignment(uuid,text,text) from public,anon;
grant execute on function public.submit_assignment(uuid,text,text) to authenticated;

-- Existing files remain in the private bucket. Expand formats for this workflow.
update storage.buckets set public=false,file_size_limit=52428800,
  allowed_mime_types=array[
    'application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
where id='submission-files';
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('assignment-files','assignment-files',false,52428800,array[
  'application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
]) on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

drop policy if exists "student uploads own enrolled file" on storage.objects;
drop policy if exists "student uploads own assignment submission" on storage.objects;
create policy "student uploads own assignment submission" on storage.objects for insert to authenticated
with check (
  bucket_id='submission-files'
  and (storage.foldername(name))[1]=(select auth.uid())::text
  and exists(select 1 from public.assignments a join public.enrolments e on e.course_id=a.course_id
    where a.id=((storage.foldername(name))[2])::uuid and e.student_id=(select auth.uid())
      and a.status='published'
      and (a.due_at is null or a.due_at>=now() or a.allow_late_submissions)
      and (not exists(select 1 from public.submissions s where s.assignment_id=a.id and s.student_id=(select auth.uid())) or a.allow_resubmissions)
      and storage.filename(name) ~* '\.(pdf|doc|docx|ppt|pptx|xls|xlsx)$'
      and lower(regexp_replace(storage.filename(name),'^.*\.',''))=any(a.allowed_file_extensions)
      and coalesce((metadata->>'size')::bigint,0) between 1 and a.max_submission_file_size
      and public.current_app_role()='student'
  )
);
drop policy if exists "owner lecturer admin reads submission file" on storage.objects;
create policy "owner lecturer admin reads submission file" on storage.objects for select to authenticated
using (bucket_id='submission-files' and (
  (storage.foldername(name))[1]=(select auth.uid())::text
  or public.current_app_role()='administrator'
  or public.is_assignment_lecturer(((storage.foldername(name))[2])::uuid)
));
drop policy if exists "student updates own file" on storage.objects;
drop policy if exists "owner lecturer admin deletes submission file" on storage.objects;
drop policy if exists "lecturer admin deletes submission file" on storage.objects;
create policy "lecturer admin deletes submission file" on storage.objects for delete to authenticated
using (bucket_id='submission-files' and (
  public.current_app_role()='administrator'
  or public.is_assignment_lecturer(((storage.foldername(name))[2])::uuid)
));

drop policy if exists "lecturer uploads assignment file" on storage.objects;
create policy "lecturer uploads assignment file" on storage.objects for insert to authenticated
with check (bucket_id='assignment-files' and public.is_assignment_lecturer(((storage.foldername(name))[1])::uuid));
drop policy if exists "course members read published assignment files" on storage.objects;
create policy "course members read published assignment files" on storage.objects for select to authenticated
using (
  bucket_id='assignment-files' and (
    public.current_app_role()='administrator'
    or public.is_assignment_lecturer(((storage.foldername(name))[1])::uuid)
    or exists(select 1 from public.assignments a join public.enrolments e on e.course_id=a.course_id
      where a.id=((storage.foldername(name))[1])::uuid and a.status='published' and e.student_id=(select auth.uid()))
  )
);
drop policy if exists "lecturer admin deletes assignment file" on storage.objects;
create policy "lecturer admin deletes assignment file" on storage.objects for delete to authenticated
using (bucket_id='assignment-files' and (public.current_app_role()='administrator' or public.is_assignment_lecturer(((storage.foldername(name))[1])::uuid)));
drop policy if exists "student deletes uncommitted submission file" on storage.objects;
create policy "student deletes uncommitted submission file" on storage.objects for delete to authenticated
using (bucket_id='submission-files' and (storage.foldername(name))[1]=(select auth.uid())::text
  and not exists(select 1 from public.submission_versions v where v.file_path=storage.objects.name)
  and not exists(select 1 from public.submissions s where s.file_path=storage.objects.name));

create or replace function public.notify_student_when_grade_published()
returns trigger language plpgsql security definer set search_path='' as $$
declare student_id uuid; assignment_title text;
begin
  if new.published_at is not null and (tg_op='INSERT' or old.published_at is distinct from new.published_at) then
    select s.student_id,a.title into student_id,assignment_title
      from public.submissions s join public.assignments a on a.id=s.assignment_id
      where s.id=new.submission_id;
    if student_id is not null then
      insert into public.notifications(user_id,title,body,related_assignment_id,related_grade_id)
      select student_id,'Grade published',assignment_title || ' has a published grade.',s.assignment_id,new.id
      from public.submissions s where s.id=new.submission_id;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists grades_notify_student on public.grades;
create trigger grades_notify_student after insert or update of published_at on public.grades
for each row execute function public.notify_student_when_grade_published();

-- Recover older accounts that existed before the auth.users profile trigger was installed.
-- The caller can create only their own profile and the role is always student.
create or replace function public.ensure_my_profile()
returns public.profiles language plpgsql security definer set search_path='' as $$
declare p public.profiles%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  insert into public.profiles(id,full_name,role)
  select u.id,coalesce(nullif(trim(u.raw_user_meta_data->>'full_name'),''),split_part(u.email,'@',1)),'student'
  from auth.users u where u.id=auth.uid()
  on conflict(id) do nothing;
  select * into p from public.profiles where id=auth.uid();
  return p;
end;
$$;
revoke all on function public.ensure_my_profile() from public,anon;
grant execute on function public.ensure_my_profile() to authenticated;
