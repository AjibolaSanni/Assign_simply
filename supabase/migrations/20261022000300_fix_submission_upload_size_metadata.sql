-- Supabase Storage evaluates the INSERT policy before upload completion with
-- metadata.contentLength. Completed objects use metadata.size. Accept either
-- key so the per-assignment size limit is enforced during both checks.
-- All ownership, enrolment, publication, deadline, extension, and role checks
-- remain unchanged.
drop policy if exists "student uploads own assignment submission" on storage.objects;

create policy "student uploads own assignment submission" on storage.objects
for insert to authenticated
with check (
  bucket_id='submission-files'
  and (storage.foldername(name))[1]=(select auth.uid())::text
  and exists(
    select 1
    from public.assignments a
    join public.enrolments e on e.course_id=a.course_id
    where a.id=((storage.foldername(name))[2])::uuid
      and e.student_id=(select auth.uid())
      and a.status='published'
      and (a.due_at is null or a.due_at>=now() or a.allow_late_submissions)
      and (
        not exists(
          select 1 from public.submissions s
          where s.assignment_id=a.id and s.student_id=(select auth.uid())
        )
        or a.allow_resubmissions
      )
      and storage.filename(name) ~* '\.(pdf|doc|docx|ppt|pptx|xls|xlsx)$'
      and lower(regexp_replace(storage.filename(name),'^.*\.',''))=any(a.allowed_file_extensions)
      and coalesce(
        nullif(storage.objects.metadata->>'size','')::bigint,
        nullif(storage.objects.metadata->>'contentLength','')::bigint,
        0
      ) between 1 and a.max_submission_file_size
      and public.current_app_role()='student'
  )
);
