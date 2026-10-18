-- Lecturer workflow: notify enrolled students when assignments/grades are published.
create or replace function public.notify_assignment_publication()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.status='published' and (tg_op='INSERT' or old.status is distinct from 'published') then
    insert into public.notifications(user_id,title,body,related_assignment_id)
    select e.student_id,'New assignment',new.title || ' is available.',new.id
    from public.enrolments e where e.course_id=new.course_id;
  end if;
  return new;
end;
$$;
drop trigger if exists assignments_notify_publication on public.assignments;
create trigger assignments_notify_publication
after insert or update of status on public.assignments
for each row execute function public.notify_assignment_publication();

create or replace function public.notify_published_grade()
returns trigger language plpgsql security definer set search_path='' as $$
declare student_id uuid; assignment_id uuid; assignment_title text;
begin
  if new.published_at is not null and (tg_op='INSERT' or old.published_at is null) then
    select s.student_id,s.assignment_id,a.title into student_id,assignment_id,assignment_title
    from public.submissions s join public.assignments a on a.id=s.assignment_id where s.id=new.submission_id;
    insert into public.notifications(user_id,title,body,related_assignment_id,related_grade_id)
    values(student_id,'Grade published','Your grade for ' || assignment_title || ' is available.',assignment_id,new.id);
  end if;
  return new;
end;
$$;
drop trigger if exists grades_notify_student on public.grades;
drop trigger if exists grades_notify_publication on public.grades;
create trigger grades_notify_publication
after insert or update of published_at on public.grades
for each row execute function public.notify_published_grade();

-- Make newly created relations and foreign keys visible to PostgREST immediately.
notify pgrst, 'reload schema';
