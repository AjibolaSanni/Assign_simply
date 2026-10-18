-- Keep randomized Storage object names while preserving the original name in
-- public.submissions.file_name. The earlier RPC incorrectly required these
-- two names to be identical, even though the client intentionally randomizes
-- the Storage filename to prevent collisions.
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
  extension := lower(regexp_replace(p_file_name,'^.*\.',''));
  if lower(regexp_replace(storage.filename(p_file_path),'^.*\.','')) is distinct from extension then
    raise exception 'Uploaded object extension does not match the selected file';
  end if;
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

notify pgrst, 'reload schema';
