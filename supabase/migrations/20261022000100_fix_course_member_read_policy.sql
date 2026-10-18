-- Fix student visibility for courses they are enrolled in.
-- The previous policy used the unqualified `id`, which PostgreSQL resolved to
-- enrolments.id inside the EXISTS subquery instead of courses.id.
-- This policy change preserves all existing records and keeps RLS enabled.
drop policy if exists "course member read" on public.courses;

create policy "course member read" on public.courses
for select to authenticated
using (
  lecturer_id = (select auth.uid())
  or public.current_app_role() = 'administrator'
  or exists (
    select 1
    from public.enrolments e
    where e.course_id = public.courses.id
      and e.student_id = (select auth.uid())
  )
);
