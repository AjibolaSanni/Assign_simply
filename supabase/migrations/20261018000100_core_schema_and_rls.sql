-- AssignSimply core schema and RLS. Roles are provisioned by trusted operators only.
create extension if not exists pgcrypto;
create type public.app_role as enum ('student','lecturer','administrator');

create table public.profiles (
 id uuid primary key references auth.users(id) on delete cascade,
 full_name text not null check (length(trim(full_name)) between 1 and 120),
 role public.app_role not null default 'student',
 created_at timestamptz not null default now()
);
-- Never trust user metadata for privilege assignment.
create function public.handle_new_user() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.profiles(id,full_name,role) values(new.id,coalesce(nullif(trim(new.raw_user_meta_data->>'full_name'),''),split_part(new.email,'@',1)),'student');
 return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

create table public.courses (
 id uuid primary key default gen_random_uuid(), code text not null unique check(length(trim(code)) between 1 and 32),
 title text not null check(length(trim(title)) between 1 and 160), description text,
 lecturer_id uuid not null references public.profiles(id) on delete restrict, created_at timestamptz not null default now()
);
create table public.enrolments (
 id uuid primary key default gen_random_uuid(), course_id uuid not null references public.courses(id) on delete cascade,
 student_id uuid not null references public.profiles(id) on delete cascade, enrolled_at timestamptz not null default now(), unique(course_id,student_id)
);
create table public.assignments (
 id uuid primary key default gen_random_uuid(), course_id uuid not null references public.courses(id) on delete cascade,
 title text not null check(length(trim(title)) between 1 and 200), instructions text not null default '',
 due_at timestamptz, max_points numeric(8,2) not null default 100 check(max_points>0),
 allow_resubmissions boolean not null default false, created_at timestamptz not null default now()
);
create table public.submissions (
 id uuid primary key default gen_random_uuid(), assignment_id uuid not null references public.assignments(id) on delete cascade,
 student_id uuid not null references public.profiles(id) on delete cascade,
 file_path text not null, file_name text not null check(length(trim(file_name)) between 1 and 255),
 submitted_at timestamptz not null default now(), unique(assignment_id,student_id)
);
create table public.grades (
 id uuid primary key default gen_random_uuid(), submission_id uuid not null unique references public.submissions(id) on delete cascade,
 points numeric(8,2) not null check(points>=0), feedback text not null default '', published_at timestamptz,
 graded_by uuid not null references public.profiles(id) on delete restrict, updated_at timestamptz not null default now()
);
create table public.notifications (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id) on delete cascade,
 title text not null check(length(trim(title)) between 1 and 160), body text not null default '',
 read_at timestamptz, created_at timestamptz not null default now()
);
create index enrolments_student_idx on public.enrolments(student_id,course_id);
create index assignments_course_due_idx on public.assignments(course_id,due_at);
create index submissions_student_idx on public.submissions(student_id,assignment_id);
create index notifications_user_created_idx on public.notifications(user_id,created_at desc);

create function public.current_app_role() returns public.app_role language sql stable security definer set search_path='' as $$
 select p.role from public.profiles p where p.id=(select auth.uid())
$$;
create function public.is_course_lecturer(cid uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.courses c where c.id=cid and c.lecturer_id=(select auth.uid()))
$$;
create function public.is_assignment_lecturer(aid uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.assignments a join public.courses c on c.id=a.course_id where a.id=aid and c.lecturer_id=(select auth.uid()))
$$;

-- Keep file ownership, enrolment, and grade bounds consistent even for trusted writers.
create function public.validate_submission() returns trigger language plpgsql set search_path='' as $$
begin
 if split_part(new.file_path,'/',1)<>new.student_id::text or split_part(new.file_path,'/',2)<>new.assignment_id::text then raise exception 'file_path must be student UUID/assignment UUID/filename'; end if;
 if not exists(select 1 from public.assignments a join public.enrolments e on e.course_id=a.course_id where a.id=new.assignment_id and e.student_id=new.student_id) then raise exception 'student must be enrolled in course'; end if;
 return new;
end $$;
create trigger submission_validate before insert or update of assignment_id,student_id,file_path on public.submissions for each row execute function public.validate_submission();
create function public.validate_grade() returns trigger language plpgsql set search_path='' as $$
begin
 if new.points>(select a.max_points from public.submissions s join public.assignments a on a.id=s.assignment_id where s.id=new.submission_id) then raise exception 'grade exceeds assignment maximum'; end if;
 return new;
end $$;
create trigger grade_validate before insert or update of points,submission_id on public.grades for each row execute function public.validate_grade();

revoke all on all tables in schema public from anon,authenticated;
grant usage on schema public to authenticated;
grant select on public.profiles to authenticated;
grant update(full_name) on public.profiles to authenticated;
grant select,insert,update,delete on public.courses,public.enrolments,public.assignments,public.submissions,public.grades,public.notifications to authenticated;
alter table public.profiles enable row level security;
alter table public.courses enable row level security;
alter table public.enrolments enable row level security;
alter table public.assignments enable row level security;
alter table public.submissions enable row level security;
alter table public.grades enable row level security;
alter table public.notifications enable row level security;

create policy "profile self read" on public.profiles for select to authenticated using(id=(select auth.uid()) or public.current_app_role()='administrator');
create policy "profile self update" on public.profiles for update to authenticated using(id=(select auth.uid())) with check(id=(select auth.uid()) and role=public.current_app_role());
create policy "course member read" on public.courses for select to authenticated using(lecturer_id=(select auth.uid()) or public.current_app_role()='administrator' or exists(select 1 from public.enrolments e where e.course_id=id and e.student_id=(select auth.uid())));
create policy "admin create courses" on public.courses for insert to authenticated with check(public.current_app_role()='administrator' and (select role from public.profiles where id=lecturer_id)='lecturer');
create policy "lecturer or admin update courses" on public.courses for update to authenticated using(lecturer_id=(select auth.uid()) or public.current_app_role()='administrator') with check(lecturer_id=(select auth.uid()) or public.current_app_role()='administrator');
create policy "admin delete courses" on public.courses for delete to authenticated using(public.current_app_role()='administrator');
create policy "enrolment member read" on public.enrolments for select to authenticated using(student_id=(select auth.uid()) or public.is_course_lecturer(course_id) or public.current_app_role()='administrator');
create policy "admin manages enrolments" on public.enrolments for all to authenticated using(public.current_app_role()='administrator') with check(public.current_app_role()='administrator' and (select role from public.profiles where id=student_id)='student');
create policy "assignment member read" on public.assignments for select to authenticated using(public.current_app_role()='administrator' or public.is_course_lecturer(course_id) or exists(select 1 from public.enrolments e where e.course_id=assignments.course_id and e.student_id=(select auth.uid())));
create policy "lecturer creates assignments" on public.assignments for insert to authenticated with check(public.is_course_lecturer(course_id));
create policy "lecturer admin updates assignments" on public.assignments for update to authenticated using(public.is_course_lecturer(course_id) or public.current_app_role()='administrator') with check(public.is_course_lecturer(course_id) or public.current_app_role()='administrator');
create policy "lecturer admin deletes assignments" on public.assignments for delete to authenticated using(public.is_course_lecturer(course_id) or public.current_app_role()='administrator');
create policy "submission owner lecturer admin read" on public.submissions for select to authenticated using(student_id=(select auth.uid()) or public.is_assignment_lecturer(assignment_id) or public.current_app_role()='administrator');
create policy "enrolled student submits" on public.submissions for insert to authenticated with check(student_id=(select auth.uid()) and public.current_app_role()='student' and exists(select 1 from public.assignments a join public.enrolments e on e.course_id=a.course_id where a.id=assignment_id and e.student_id=(select auth.uid()) and (a.due_at is null or a.due_at>=now())));
create policy "student resubmits when allowed" on public.submissions for update to authenticated using(student_id=(select auth.uid())) with check(student_id=(select auth.uid()) and exists(select 1 from public.assignments a where a.id=assignment_id and a.allow_resubmissions and (a.due_at is null or a.due_at>=now())));
create policy "lecturer admin deletes submissions" on public.submissions for delete to authenticated using(public.is_assignment_lecturer(assignment_id) or public.current_app_role()='administrator');
create policy "grade student published lecturer admin read" on public.grades for select to authenticated using(public.current_app_role()='administrator' or exists(select 1 from public.submissions s where s.id=submission_id and ((s.student_id=(select auth.uid()) and published_at is not null) or public.is_assignment_lecturer(s.assignment_id))));
create policy "lecturer creates grades" on public.grades for insert to authenticated with check(public.is_assignment_lecturer((select s.assignment_id from public.submissions s where s.id=submission_id)) and graded_by=(select auth.uid()));
create policy "lecturer admin updates grades" on public.grades for update to authenticated using(public.is_assignment_lecturer((select s.assignment_id from public.submissions s where s.id=submission_id)) or public.current_app_role()='administrator') with check((public.is_assignment_lecturer((select s.assignment_id from public.submissions s where s.id=submission_id)) or public.current_app_role()='administrator') and graded_by=(select auth.uid()));
create policy "lecturer admin deletes grades" on public.grades for delete to authenticated using(public.is_assignment_lecturer((select s.assignment_id from public.submissions s where s.id=submission_id)) or public.current_app_role()='administrator');
create policy "user reads notifications" on public.notifications for select to authenticated using(user_id=(select auth.uid()) or public.current_app_role()='administrator');
create policy "user updates notifications" on public.notifications for update to authenticated using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()));
create policy "admin creates notifications" on public.notifications for insert to authenticated with check(public.current_app_role()='administrator');
create policy "admin deletes notifications" on public.notifications for delete to authenticated using(public.current_app_role()='administrator');

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('submission-files','submission-files',false,20971520,array['application/pdf','text/plain','application/zip','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document']) on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
create policy "student uploads own enrolled file" on storage.objects for insert to authenticated with check(bucket_id='submission-files' and (storage.foldername(name))[1]=(select auth.uid())::text and exists(select 1 from public.assignments a join public.enrolments e on e.course_id=a.course_id where a.id=((storage.foldername(name))[2])::uuid and e.student_id=(select auth.uid()) and (a.due_at is null or a.due_at>=now())));
create policy "owner lecturer admin reads submission file" on storage.objects for select to authenticated using(bucket_id='submission-files' and ((storage.foldername(name))[1]=(select auth.uid())::text or public.current_app_role()='administrator' or public.is_assignment_lecturer(((storage.foldername(name))[2])::uuid)));
create policy "student updates own file" on storage.objects for update to authenticated using(bucket_id='submission-files' and (storage.foldername(name))[1]=(select auth.uid())::text and exists(select 1 from public.assignments a where a.id=((storage.foldername(name))[2])::uuid and a.allow_resubmissions and (a.due_at is null or a.due_at>=now()))) with check(bucket_id='submission-files' and (storage.foldername(name))[1]=(select auth.uid())::text);
create policy "owner lecturer admin deletes submission file" on storage.objects for delete to authenticated using(bucket_id='submission-files' and ((storage.foldername(name))[1]=(select auth.uid())::text or public.current_app_role()='administrator' or public.is_assignment_lecturer(((storage.foldername(name))[2])::uuid)));
