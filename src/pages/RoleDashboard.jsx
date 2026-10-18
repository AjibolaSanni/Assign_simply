import { useCallback, useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import {
  Activity, ArrowDownToLine, ArrowRight, Bell, BookOpen, CalendarDays, CheckCheck,
  ClipboardCheck, Download, FileText, GraduationCap, LayoutDashboard, LogOut, Menu, Search, Shield, Upload, Users, X,
} from 'lucide-react'
import Brand from '../components/Brand'
import { useAuth } from '../contexts/AuthContext'
import { signOut } from '../services/authService'
import { addCourseEnrolment, changeAdminUserRole, downloadPrivateFile, listAdminUsers, listCourseEnrolments, loadRoleDashboard, markAllNotificationsRead, markNotificationRead, removeCourseEnrolment, removeLecturerAttachment, saveAdminCourse, saveLecturerAssignment, saveLecturerGrade, submitStudentAssignment } from '../services/dashboardService'
import '../student-workflow.css'

const menuByRole = {
  student: [
    ['overview', 'Dashboard', LayoutDashboard],
    ['courses', 'My courses', BookOpen],
    ['assignments', 'Assignments', ClipboardCheck],
    ['submissions', 'My submissions', FileText],
    ['grades', 'My grades', GraduationCap],
    ['notifications', 'Notifications', Bell],
  ],
  lecturer: [
    ['overview', 'Dashboard', LayoutDashboard],
    ['courses', 'My courses', BookOpen],
    ['assignments', 'Assignments', ClipboardCheck],
    ['submissions', 'Submissions', FileText],
    ['grading', 'Grading', GraduationCap],
    ['notifications', 'Notifications', Bell],
  ],
  administrator: [
    ['overview', 'Overview', LayoutDashboard],
    ['users', 'User management', Users],
    ['roles', 'Role management', Shield],
    ['courses', 'Course management', BookOpen],
    ['assignments', 'Assignment overview', ClipboardCheck],
    ['submissions', 'Submission overview', FileText],
    ['activity', 'Activity logs', Activity],
    ['reports', 'Reports', Download],
  ],
}

const roleNames = { student: 'Student', lecturer: 'Lecturer', administrator: 'Administrator' }
const dateTime = value => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'No deadline'

function dashboardError(cause) {
  const message = cause?.message || ''
  if (['PGRST200','PGRST202','PGRST204','PGRST205','42703','42P01'].includes(cause?.code)
    || /column .* does not exist|relation .* does not exist|could not find the function.*ensure_my_profile/i.test(message)) {
    return 'The Supabase database needs the latest AssignSimply migrations. Run `supabase db push`, then reload this page.'
  }
  return message || 'Unable to load dashboard data.'
}

function StatCard({ icon: Icon, label, value, note, tone = 'pink' }) {
  return <article className="role-stat-card"><span className={`role-stat-icon ${tone}`}><Icon size={18}/></span><span className="role-stat-label">{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</article>
}

function RecordList({ rows, empty, render }) {
  if (!rows?.length) return <div className="role-empty"><BookOpen size={22}/><p>{empty}</p></div>
  return <div className="role-record-list">{rows.map((row, index) => <article className="role-record" key={row.id ?? row.assignment_id ?? row.course_id ?? index}>{render(row)}</article>)}</div>
}

function StudentAssignments({ assignments, submissions, user, onSubmitted, onDownload }) {
  const [search, setSearch] = useState('')
  const [courseId, setCourseId] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [files, setFiles] = useState({})
  const [busyId, setBusyId] = useState(null)
  const [message, setMessage] = useState(null)
  const submissionMap = new Map(submissions.map(row => [row.assignment_id, row]))
  const courses = [...new Map(assignments.map(item => [item.course?.id, item.course]).filter(([id]) => id)).values()]
  const filtered = assignments.filter(item => {
    const submitted = submissionMap.has(item.id)
    return (!search || `${item.title} ${item.course?.title} ${item.course?.code}`.toLowerCase().includes(search.toLowerCase()))
      && (courseId === 'all' || item.course?.id === courseId)
      && (statusFilter === 'all' || (statusFilter === 'submitted' ? submitted : !submitted))
  }).sort((a, b) => (a.due_at ? new Date(a.due_at).getTime() : Infinity) - (b.due_at ? new Date(b.due_at).getTime() : Infinity))

  async function submit(event, assignment) {
    event.preventDefault()
    const form = event.currentTarget
    setMessage(null)
    setBusyId(assignment.id)
    try {
      await submitStudentAssignment(user.id, assignment, files[assignment.id])
      setFiles(current => ({ ...current, [assignment.id]: null }))
      form.reset()
      setMessage({ type: 'success', text: 'Submission received. Your submission history has been updated.' })
      await onSubmitted()
    } catch (error) {
      setMessage({ type: 'error', text: error.message || 'The submission could not be uploaded.' })
    } finally { setBusyId(null) }
  }

  return <div className="student-assignment-page">
    <div className="student-filters">
      <label className="student-search"><Search size={16}/><input aria-label="Search assignments" placeholder="Search assignments" value={search} onChange={event => setSearch(event.target.value)}/></label>
      <select aria-label="Filter by course" value={courseId} onChange={event => setCourseId(event.target.value)}><option value="all">All courses</option>{courses.map(course => <option key={course.id} value={course.id}>{course.code}</option>)}</select>
      <select aria-label="Filter by submission status" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option value="all">All statuses</option><option value="pending">Pending</option><option value="submitted">Submitted</option></select>
    </div>
    {message && <div className={`student-feedback ${message.type}`} role={message.type === 'error' ? 'alert' : 'status'}>{message.text}</div>}
    {!filtered.length ? <div className="role-empty"><ClipboardCheck size={22}/><p>{assignments.length ? 'No assignments match these filters.' : 'No published assignments are available in your enrolled courses.'}</p></div> : filtered.map(assignment => {
      const existing = submissionMap.get(assignment.id)
      const dueTime = assignment.due_at ? new Date(assignment.due_at).getTime() : null
      const isLate = dueTime !== null && dueTime < Date.now()
      const canSubmit = (!existing || assignment.allow_resubmissions) && (!isLate || assignment.allow_late_submissions)
      const attachments = assignment.assignment_attachments ?? []
      return <article className="student-assignment-card" key={assignment.id}>
        <div className="student-assignment-heading"><div><p className="eyebrow">{assignment.course?.code} · {assignment.course?.title}</p><h3>{assignment.title}</h3></div><span className={`student-status ${existing ? 'submitted' : 'pending'}`}>{existing ? 'Submitted' : 'Pending'}</span></div>
        <div className="student-assignment-meta"><span>Published {dateTime(assignment.published_at)}</span><span>Due {dateTime(assignment.due_at)}</span><span>{assignment.max_points} points</span><span>Late work {assignment.allow_late_submissions ? 'accepted' : 'not accepted'}</span><span>{assignment.allow_resubmissions ? 'Resubmissions allowed' : 'No resubmissions'}</span>{isLate && assignment.allow_late_submissions && <span className="late-label">Late submission</span>}</div>
        {assignment.instructions && <p className="student-assignment-instructions">{assignment.instructions}</p>}
        {!!attachments.length && <div className="student-attachments"><b>Assignment files</b>{attachments.map(file => <div className="student-file-row" key={file.id}><span><FileText size={15}/>{file.file_name}<small>{file.mime_type || file.file_name.split('.').pop()?.toUpperCase()}</small></span><button type="button" onClick={() => onDownload('assignment-files', file.file_path, file.file_name)}><ArrowDownToLine size={15}/> Download</button></div>)}</div>}
        {existing && <p className="student-submission-summary">Last submitted {dateTime(existing.submitted_at)}{existing.is_late ? ' · Late' : ''}</p>}
        {canSubmit ? <form className="student-upload-form" onSubmit={event => submit(event, assignment)}>
          <label className="student-file-picker"><Upload size={16}/><span>{files[assignment.id]?.name || (existing ? 'Choose a replacement file' : 'Choose your file')}</span><input data-assignment-file={assignment.id} type="file" accept={(assignment.allowed_file_extensions ?? []).map(ext => `.${ext}`).join(',')} onChange={event => setFiles(current => ({ ...current, [assignment.id]: event.target.files?.[0] ?? null }))}/></label>
          {files[assignment.id] && <button className="student-clear-file" type="button" aria-label="Clear selected file" onClick={() => { setFiles(current => ({ ...current, [assignment.id]: null })); const input = document.querySelector(`[data-assignment-file="${assignment.id}"]`); if (input) input.value = '' }}><X size={15}/></button>}
          <button className="student-submit-button" type="submit" disabled={!files[assignment.id] || busyId === assignment.id}>{busyId === assignment.id ? 'Uploading…' : existing ? 'Resubmit' : 'Submit assignment'}</button>
          <small>Allowed: {(assignment.allowed_file_extensions ?? []).map(ext => ext.toUpperCase()).join(', ')} · Max {(assignment.max_submission_file_size / 1048576).toFixed(0)} MB{assignment.allow_resubmissions ? ' · Resubmissions allowed' : ''}</small>
        </form> : <p className="student-submission-summary">{existing ? 'Resubmissions are disabled for this assignment.' : 'The deadline has passed and late submissions are disabled.'}</p>}
      </article>
    })}
  </div>
}

function StudentSubmissionHistory({ rows, onDownload }) {
  return <RecordList rows={rows} empty="Your submission history will appear here after you submit an assignment." render={row => {
    const assignment = row.submissions?.assignments
    const course = assignment?.courses
    const grade = (row.submissions?.grades ?? []).find(item => item.published_at)
    return <div className="student-history-row"><div><b>{assignment?.title ?? 'Assignment'}</b><small>{course?.code} · {course?.title} · v{row.version_number} · {row.file_name}</small><small>{dateTime(row.submitted_at)}{row.is_late ? ' · Late' : ''}{grade ? ` · ${grade.points} points · ${grade.feedback || 'No feedback'}` : ' · Awaiting grade'}</small></div><button className="role-text-action" onClick={() => onDownload('submission-files', row.file_path, row.file_name)}><ArrowDownToLine size={15}/> Download</button></div>
  }}/> 
}

const allowedExtensions = ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx']

function LecturerAssignments({ courses, assignments, user, onRefresh, onDownload }) {
  const blank = { course_id: courses[0]?.id ?? '', title: '', instructions: '', due_at: '', max_points: '100', status: 'draft', published_at: null, allow_late_submissions: false, allow_resubmissions: false, allowed_file_extensions: allowedExtensions, max_submission_file_size: 20971520, files: [] }
  const [form, setForm] = useState(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [selectedFiles, setSelectedFiles] = useState([])
  const [deleteBusy, setDeleteBusy] = useState(null)
  const start = item => { setForm(item ? { ...blank, ...item, course_id: item.course_id || item.course?.id, due_at: item.due_at ? new Date(item.due_at).toISOString().slice(0, 16) : '', files: [] } : { ...blank, course_id: courses[0]?.id ?? '' }); setSelectedFiles([]); setMessage('') }
  async function save(event) {
    event.preventDefault(); setBusy(true); setMessage('')
    try { await saveLecturerAssignment({ ...form, files: selectedFiles }, user.id); setForm(null); setSelectedFiles([]); await onRefresh() }
    catch (error) { setMessage(error.message || 'The assignment could not be saved.') }
    finally { setBusy(false) }
  }
  async function removeFile(file) {
    setDeleteBusy(file.id); setMessage('')
    try { await removeLecturerAttachment(file); await onRefresh() }
    catch (error) { setMessage(error.message || 'The attachment could not be removed.') }
    finally { setDeleteBusy(null) }
  }
  const update = (key, value) => setForm(current => ({ ...current, [key]: value }))
  return <div className="lecturer-assignments">
    <div className="role-section-heading"><div><p className="eyebrow">ASSIGNMENT MANAGEMENT</p><h2>Assignments</h2></div><button className="student-submit-button" onClick={() => start(null)} disabled={!courses.length}>Create assignment</button></div>
    {message && <div className="student-feedback error" role="alert">{message}</div>}
    {form && <form className="lecturer-form" onSubmit={save}>
      <h3>{form.id ? 'Edit assignment' : 'New assignment'}</h3>
      <label>Course<select required value={form.course_id} onChange={event => update('course_id', event.target.value)}>{courses.map(course => <option value={course.id} key={course.id}>{course.code} · {course.title}</option>)}</select></label>
      <label>Title<input required maxLength={200} value={form.title} onChange={event => update('title', event.target.value)}/></label>
      <label>Instructions<textarea rows="4" value={form.instructions} onChange={event => update('instructions', event.target.value)}/></label>
      <div className="lecturer-form-grid"><label>Deadline<input type="datetime-local" value={form.due_at} onChange={event => update('due_at', event.target.value)}/></label><label>Maximum score<input type="number" min="0.01" step="0.01" required value={form.max_points} onChange={event => update('max_points', event.target.value)}/></label><label>Maximum submission size (MB)<input type="number" min="1" max="50" value={Math.round(form.max_submission_file_size / 1048576)} onChange={event => update('max_submission_file_size', Number(event.target.value) * 1048576)}/></label><label>Publish status<select value={form.status} onChange={event => update('status', event.target.value)}><option value="draft">Save as draft</option><option value="published">Publish now</option><option value="closed">Closed</option></select></label></div>
      <fieldset className="lecturer-checkboxes"><legend>Submission rules</legend><label><input type="checkbox" checked={form.allow_late_submissions} onChange={event => update('allow_late_submissions', event.target.checked)}/> Accept late submissions</label><label><input type="checkbox" checked={form.allow_resubmissions} onChange={event => update('allow_resubmissions', event.target.checked)}/> Allow resubmissions</label><div className="lecturer-extension-list">Allowed file types: {allowedExtensions.map(ext => <label key={ext}><input type="checkbox" checked={form.allowed_file_extensions.includes(ext)} onChange={event => update('allowed_file_extensions', event.target.checked ? [...form.allowed_file_extensions, ext] : form.allowed_file_extensions.filter(value => value !== ext))}/>{ext.toUpperCase()}</label>)}</div></fieldset>
      <label>Question files<input type="file" multiple accept={allowedExtensions.map(ext => `.${ext}`).join(',')} onChange={event => setSelectedFiles([...event.target.files])}/></label>
      {selectedFiles.map((file, index) => <small key={`${file.name}-${index}`}>{file.name} · {(file.size / 1048576).toFixed(1)} MB</small>)}
      {form.assignment_attachments?.length > 0 && <div className="student-attachments"><b>Current attachments</b>{form.assignment_attachments.map(file => <div className="student-file-row" key={file.id}><span>{file.file_name}</span><button type="button" onClick={() => removeFile(file)} disabled={deleteBusy === file.id}>{deleteBusy === file.id ? 'Removing…' : 'Remove'}</button></div>)}</div>}
      <div className="lecturer-form-actions"><button type="submit" className="student-submit-button" disabled={busy || !form.allowed_file_extensions.length}>{busy ? 'Saving…' : 'Save assignment'}</button><button type="button" className="role-text-action" onClick={() => setForm(null)}>Cancel</button></div>
    </form>}
    <RecordList rows={assignments} empty="No assignments yet. Create a draft or publish an assignment for one of your courses." render={item => <div className="lecturer-assignment-row"><div><b>{item.title}</b><small>{item.course?.code} · {item.status || 'published'} · Due {dateTime(item.due_at)}</small><small>{item.submission_count ?? 0} submissions · {item.max_points} points</small></div><span className="lecturer-row-actions"><button className="role-text-action" onClick={() => start(item)}>Edit</button>{item.assignment_attachments?.map(file => <button className="role-text-action" key={file.id} onClick={() => onDownload('assignment-files', file.file_path, file.file_name)}>{file.file_name} ↓</button>)}</span></div>}/>
  </div>
}

function LecturerSubmissions({ submissions, user, onRefresh, onDownload, pendingOnly = false }) {
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(null)
  const [feedback, setFeedback] = useState('')
  const visible = submissions.filter(item => (!pendingOnly || !item.grade) && (!query || `${item.student?.full_name || ''} ${item.assignment?.title || ''}`.toLowerCase().includes(query.toLowerCase())))
  async function grade(event, submission) {
    event.preventDefault(); const form = event.currentTarget; setBusy(submission.id); setFeedback('')
    try { await saveLecturerGrade(submission, form.elements.points.value, form.elements.feedback.value, form.elements.publish.checked); await onRefresh() }
    catch (error) { setFeedback(error.message || 'The grade could not be saved.') }
    finally { setBusy(null) }
  }
  return <div className="lecturer-submissions"><label className="student-search"><Search size={16}/><input placeholder="Search student or assignment" value={query} onChange={event => setQuery(event.target.value)}/></label>{feedback && <div className="student-feedback error" role="alert">{feedback}</div>}
    {!visible.length ? <div className="role-empty"><FileText size={22}/><p>{pendingOnly ? 'No submissions are awaiting grading.' : 'No submissions match this search.'}</p></div> : visible.map(item => <article className="lecturer-submission-card" key={item.id}><div className="lecturer-submission-header"><div><b>{item.student?.full_name || 'Student'}</b><small>{item.assignment?.title} · {item.assignment?.course?.code} · {dateTime(item.submitted_at)}{item.is_late ? ' · Late' : ''}</small></div><button className="role-text-action" onClick={() => onDownload('submission-files', item.file_path, item.file_name)}><ArrowDownToLine size={15}/> {item.file_name}</button></div>
      {item.grade && <div className="lecturer-existing-grade">Saved grade: {item.grade.points}/{item.assignment?.max_points} · {item.grade.published_at ? 'Published' : 'Draft'}</div>}
      <details className="lecturer-grade-details"><summary>{item.grade ? 'Edit grade and feedback' : 'Grade submission'}</summary><form className="lecturer-grade-form" onSubmit={event => grade(event, item)}><label>Score<input name="points" type="number" min="0" max={item.assignment?.max_points} step="0.01" required defaultValue={item.grade?.points ?? ''}/><small>Maximum {item.assignment?.max_points} points</small></label><label>Feedback<textarea name="feedback" rows="3" defaultValue={item.grade?.feedback ?? ''}/></label><label className="lecturer-publish-choice"><input name="publish" type="checkbox" defaultChecked={Boolean(item.grade?.published_at)}/> Publish grade to student</label><button className="student-submit-button" type="submit" disabled={busy === item.id}>{busy === item.id ? 'Saving…' : 'Save grade'}</button></form></details></article>)}</div>
}

function AdminUsers({ user, roleOnly = false }) {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState('all')
  const [error, setError] = useState('')
  const refresh = async () => {
    setLoading(true); setError('')
    try { setUsers(await listAdminUsers()) }
    catch (cause) { setError(cause.message || 'User accounts could not be loaded.') }
    finally { setLoading(false) }
  }
  useEffect(() => { refresh() }, [])
  const visible = users.filter(item => (roleFilter === 'all' || item.role === roleFilter)
    && (!search || `${item.full_name} ${item.email}`.toLowerCase().includes(search.toLowerCase())))
  async function changeRole(item, role) {
    if (!role || role === item.role) return
    if (!window.confirm(`Change ${item.email || item.full_name}'s role from ${item.role} to ${role}?`)) return
    setBusyId(item.id); setError('')
    try { await changeAdminUserRole(item.id, role); await refresh() }
    catch (cause) { setError(cause.message || 'The role could not be changed.') }
    finally { setBusyId(null) }
  }
  return <div className="admin-section">
    <div className="role-section-heading"><div><p className="eyebrow">ACCOUNT DIRECTORY</p><h2>{roleOnly ? 'Role assignments' : 'Registered users'}</h2></div></div>
    <div className="student-filters"><label className="student-search"><Search size={16}/><input placeholder="Search name or email" value={search} onChange={event => setSearch(event.target.value)}/></label><select value={roleFilter} onChange={event => setRoleFilter(event.target.value)}><option value="all">All roles</option><option value="student">Students</option><option value="lecturer">Lecturers</option><option value="administrator">Administrators</option></select></div>
    {error && <div className="student-feedback error" role="alert">{error}</div>}
    {loading ? <div className="role-empty">Loading user accounts…</div> : <RecordList rows={visible} empty="No users match these filters." render={item => {
      const suspended = item.banned_until && new Date(item.banned_until).getTime() > Date.now()
      return <div className="admin-user-row"><div><b>{item.full_name || 'Unnamed user'}</b><small>{item.email || item.id} · Joined {dateTime(item.created_at)}</small><small>Role: {item.role} · {suspended ? 'Suspended' : 'Active'}{item.last_sign_in_at ? ` · Last sign-in ${dateTime(item.last_sign_in_at)}` : ''}</small></div><div className="admin-user-actions">{item.id !== user.id && <><label className="sr-only" htmlFor={`role-${item.id}`}>Change role for {item.email}</label><select id={`role-${item.id}`} value={item.role} disabled={busyId === item.id} onChange={event => changeRole(item, event.target.value)}><option value="student">Student</option><option value="lecturer">Lecturer</option><option value="administrator">Administrator</option></select></>}</div></div>
    }}/>
    }
  </div>
}

function AdminCourses({ courses, onRefresh }) {
  const [users, setUsers] = useState([])
  const [form, setForm] = useState(null)
  const [enrolmentCourse, setEnrolmentCourse] = useState(null)
  const [enrolments, setEnrolments] = useState([])
  const [studentId, setStudentId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { listAdminUsers().then(setUsers).catch(cause => setError(cause.message || 'Lecturers could not be loaded.')) }, [])
  const lecturers = users.filter(item => item.role === 'lecturer')
  const students = users.filter(item => item.role === 'student')
  async function save(event) {
    event.preventDefault(); setBusy(true); setError('')
    try { await saveAdminCourse(form); setForm(null); await onRefresh() }
    catch (cause) { setError(cause.message || 'The course could not be saved.') }
    finally { setBusy(false) }
  }
  async function showEnrolments(course) {
    setError(''); setEnrolmentCourse(course); setStudentId('')
    try { setEnrolments(await listCourseEnrolments(course.id)) }
    catch (cause) { setError(cause.message || 'Course enrolments could not be loaded.') }
  }
  async function addStudent(event) {
    event.preventDefault(); if (!studentId) return
    setBusy(true); setError('')
    try { await addCourseEnrolment(enrolmentCourse.id, studentId); await showEnrolments(enrolmentCourse) }
    catch (cause) { setError(cause.message || 'The student could not be enrolled.') }
    finally { setBusy(false) }
  }
  async function removeStudent(enrolment) {
    if (!window.confirm(`Remove ${enrolment.student?.full_name || 'this student'} from ${enrolmentCourse.title}?`)) return
    setBusy(true); setError('')
    try { await removeCourseEnrolment(enrolment.id); await showEnrolments(enrolmentCourse) }
    catch (cause) { setError(cause.message || 'The enrolment could not be removed.') }
    finally { setBusy(false) }
  }
  const blank = { code: '', title: '', description: '', lecturer_id: lecturers[0]?.id ?? '' }
  return <div className="admin-section"><div className="role-section-heading"><div><p className="eyebrow">COURSES AND ENROLMENTS</p><h2>Course management</h2></div><button className="student-submit-button" onClick={() => setForm({ ...blank, lecturer_id: lecturers[0]?.id ?? '' })} disabled={!lecturers.length}>Create course</button></div>
    {!lecturers.length && <div className="role-schema-note">Promote a trusted account to lecturer before creating or assigning courses.</div>}{error && <div className="student-feedback error" role="alert">{error}</div>}
    {form && <form className="lecturer-form" onSubmit={save}><h3>{form.id ? 'Edit course' : 'New course'}</h3><label>Course code<input required maxLength={32} value={form.code} onChange={event => setForm({ ...form, code: event.target.value })}/></label><label>Title<input required maxLength={160} value={form.title} onChange={event => setForm({ ...form, title: event.target.value })}/></label><label>Description<textarea value={form.description || ''} onChange={event => setForm({ ...form, description: event.target.value })}/></label><label>Lecturer<select required value={form.lecturer_id} onChange={event => setForm({ ...form, lecturer_id: event.target.value })}>{lecturers.map(item => <option key={item.id} value={item.id}>{item.full_name || item.email}</option>)}</select></label><div className="lecturer-form-actions"><button className="student-submit-button" disabled={busy}>{busy ? 'Saving…' : 'Save course'}</button><button type="button" className="role-text-action" onClick={() => setForm(null)}>Cancel</button></div></form>}
    <RecordList rows={courses} empty="No courses have been created." render={course => <div className="admin-course-row"><div><b>{course.code} · {course.title}</b><small>{course.description || 'No description'} · Lecturer: {course.lecturer?.full_name || course.lecturer_id}</small></div><span className="admin-user-actions"><button className="role-text-action" onClick={() => setForm({ ...course, description: course.description ?? '' })}>Edit</button><button className="role-text-action" onClick={() => showEnrolments(course)}>Manage students</button></span></div>}/>
    {enrolmentCourse && <div className="lecturer-form"><div className="role-section-heading"><h3>{enrolmentCourse.title} enrolments</h3><button className="role-text-action" onClick={() => setEnrolmentCourse(null)}>Close</button></div><form className="lecturer-form-actions" onSubmit={addStudent}><select aria-label="Choose student to enrol" required value={studentId} onChange={event => setStudentId(event.target.value)}><option value="">Choose a student</option>{students.filter(item => !enrolments.some(row => row.student_id === item.id)).map(item => <option key={item.id} value={item.id}>{item.full_name || item.email}</option>)}</select><button className="student-submit-button" disabled={busy || !studentId}>Enrol student</button></form><RecordList rows={enrolments} empty="No students are enrolled in this course." render={item => <div className="admin-course-row"><b>{item.student?.full_name || item.student_id}</b><button className="role-text-action" disabled={busy} onClick={() => removeStudent(item)}>Remove enrolment</button></div>}/></div>}
  </div>
}

function ActivityLog({ rows }) {
  return <RecordList rows={rows} empty="No audited platform activity is recorded yet." render={item => <div className="admin-activity-row"><div><b>{item.action.replaceAll('_', ' ')}</b><small>{item.target_type} · {item.target_id || 'No target id'} · Actor {item.actor_id || 'system'}</small></div><time>{dateTime(item.created_at)}</time>{Object.keys(item.metadata ?? {}).length > 0 && <small>{JSON.stringify(item.metadata)}</small>}</div>}/>
}

function exportCsv(name, rows, columns) {
  const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`
  const content = [columns.map(item => quote(item.label)).join(','), ...rows.map(row => columns.map(column => quote(column.value(row))).join(','))].join('\r\n')
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a'); link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function WorkspaceContent({ role, section, data, profile, user, onRead, onReadAll, onSignOut, onDownload, onSubmitted, actionError, onRetry }) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const firstName = profile.full_name?.split(' ')[0] || user.email?.split('@')[0] || 'there'
  const courses = data.courses ?? []
  const assignments = data.assignments ?? []
  const submissions = data.submissions ?? []
  const grades = data.grades ?? []
  const notifications = data.notifications ?? []
  const submittedIds = new Set(submissions.map(item => item.assignment_id))
  const pendingAssignments = assignments.filter(item => !submittedIds.has(item.id))
  const unreadCount = notifications.filter(item => !item.read_at).length
  const isStudent = role === 'student'
  const isLecturer = role === 'lecturer'
  const title = isStudent ? 'Your learning, at a glance' : isLecturer ? 'Your teaching workspace' : 'Platform overview'
  const greeting = isStudent ? `Good to have you here, ${firstName}` : isLecturer ? `Welcome back, ${firstName}` : `Welcome, ${firstName}`
  const menu = menuByRole[role] ?? []

  let stats = []
  if (isStudent) stats = [
    { label: 'Enrolled courses', value: courses.length, icon: BookOpen, tone: 'pink' },
    { label: 'Course assignments', value: assignments.length, icon: ClipboardCheck, tone: 'purple' },
    { label: 'Pending assignments', value: pendingAssignments.length, icon: CalendarDays, tone: 'peach' },
    { label: 'Submitted assignments', value: submissions.length, icon: FileText, tone: 'green' },
  ]
  if (isLecturer) {
    const graded = new Set(grades.map(item => item.submission_id))
    stats = [
      { label: 'Courses managed', value: courses.length, icon: BookOpen, tone: 'pink' },
      { label: 'Assignments', value: assignments.length, icon: ClipboardCheck, tone: 'purple' },
      { label: 'Total submissions', value: submissions.length, icon: FileText, tone: 'peach' },
      { label: 'Pending grading', value: submissions.filter(item => !graded.has(item.id)).length, icon: GraduationCap, tone: 'green' },
    ]
  }
  if (role === 'administrator') stats = [
    { label: 'Registered users', value: data.counts.users, icon: Users, tone: 'pink' },
    { label: 'Students', value: data.counts.students, icon: GraduationCap, tone: 'purple' },
    { label: 'Lecturers', value: data.counts.lecturers, icon: Users, tone: 'peach' },
    { label: 'Administrators', value: data.counts.administrators, icon: Shield, tone: 'green' },
    { label: 'Courses', value: data.counts.courses, icon: BookOpen, tone: 'green' },
    { label: 'Assignments', value: data.counts.assignments, icon: ClipboardCheck, tone: 'purple' },
    { label: 'Submissions', value: data.counts.submissions, icon: FileText, tone: 'peach' },
    { label: 'Pending grading', value: data.counts.pendingGrading, icon: GraduationCap, tone: 'green' },
  ]

  const cards = stats.map(item => <StatCard key={item.label} {...item}/>)
  let sectionTitle = menu.find(item => item[0] === section)?.[1] ?? 'Dashboard'
  let sectionContent

  if (section === 'overview') {
    if (isStudent) sectionContent = <>
      <div className="role-section-heading"><div><p className="eyebrow">YOUR COURSES</p><h2>Enrolled courses</h2></div><button className="role-text-action" onClick={() => onRetry('courses')}>View courses <ArrowRight size={15}/></button></div>
      <RecordList rows={courses.slice(0, 3)} empty="No course enrolments are available on your account yet." render={course => <><div><b>{course.title}</b><small>{course.code}</small></div><span>{course.assignments?.length ?? 0} assignments</span></>}/>
      <div className="role-section-heading"><div><p className="eyebrow">UP NEXT</p><h2>Upcoming deadlines</h2></div><button className="role-text-action" onClick={() => onRetry('assignments')}>All assignments <ArrowRight size={15}/></button></div>
      <RecordList rows={data.upcoming ?? []} empty="There are no upcoming assignment deadlines." render={item => <><div><b>{item.title}</b><small>{item.course?.code} · {item.course?.title}</small></div><time>{dateTime(item.due_at)}</time></>}/>
      <div className="role-section-heading"><div><p className="eyebrow">RECENT RESULTS</p><h2>Published grades</h2></div><button className="role-text-action" onClick={() => onRetry('grades')}>All grades <ArrowRight size={15}/></button></div>
      <RecordList rows={grades.slice(0, 3)} empty="Published grades will appear here when your lecturer releases them." render={grade => <><div><b>{grade.submissions?.assignments?.title ?? 'Assignment'}</b><small>Published {dateTime(grade.published_at)}</small></div><strong>{grade.points} points</strong></>}/>
    </>
    else if (isLecturer) {
      const graded = new Set(grades.map(item => item.submission_id))
      const pendingGrading = submissions.filter(item => !graded.has(item.id))
      sectionContent = <>
        <div className="role-section-heading"><div><p className="eyebrow">YOUR COURSES</p><h2>Courses you manage</h2></div></div>
        <RecordList rows={courses} empty="No courses are assigned to your lecturer account." render={course => <><div><b>{course.title}</b><small>{course.code}</small></div><span>{course.assignments?.length ?? 0} assignments</span></>}/>
        <div className="role-section-heading"><div><p className="eyebrow">NEEDS REVIEW</p><h2>Pending grading</h2></div><button className="role-text-action" onClick={() => onRetry('submissions')}>Review submissions <ArrowRight size={15}/></button></div>
        <RecordList rows={pendingGrading.slice(0, 5)} empty="No submissions are awaiting grading." render={submission => <><div><b>{assignments.find(item => item.id === submission.assignment_id)?.title ?? 'Assignment submission'}</b><small>Received {dateTime(submission.submitted_at)}</small></div><span>{submission.file_name}</span></>}/>
        <div className="role-schema-note">Assignment status and activity data are loaded from the configured Supabase schema.</div>
      </>
    } else sectionContent = <>
      <div className="role-section-heading"><div><p className="eyebrow">PLATFORM ACTIVITY</p><h2>Recent submissions</h2></div><button className="role-text-action" onClick={() => onRetry('submissions')}>View submissions <ArrowRight size={15}/></button></div>
      <RecordList rows={data.recentSubmissions} empty="No submission records are available yet." render={item => <><div><b>{item.file_name}</b><small>Assignment ID {item.assignment_id}</small></div><time>{dateTime(item.submitted_at)}</time></>}/>
      <div className="role-schema-note">Use User Management and Activity Logs to review administrative changes.</div>
    </>
  } else if (section === 'courses' && role === 'administrator') {
    sectionContent = <AdminCourses courses={courses} onRefresh={onSubmitted}/>
  } else if (section === 'courses') {
    sectionContent = <RecordList rows={courses} empty={isStudent ? 'You are not enrolled in any courses yet.' : 'No courses are available for your account.'} render={course => <><div><b>{course.title}</b><small>{course.code}{course.description ? ` · ${course.description}` : ''}</small></div><span>{course.assignments?.length ?? 0} assignments</span></>}/>
  } else if (section === 'assignments' && isStudent) {
    sectionContent = <StudentAssignments assignments={assignments} submissions={submissions} user={user} onSubmitted={onSubmitted} onDownload={onDownload}/>
  } else if (section === 'assignments' && isLecturer) {
    sectionContent = <LecturerAssignments courses={courses} assignments={assignments} user={user} onRefresh={onSubmitted} onDownload={onDownload}/>
  } else if (section === 'assignments') {
    sectionContent = role === 'administrator'
      ? <RecordList rows={assignments} empty="No assignments have been created." render={item => <><div><b>{item.title}</b><small>{item.course?.code} · {item.course?.title} · {item.status || 'published'}</small></div><time>{dateTime(item.due_at)}</time></>}/>
      : <RecordList rows={assignments} empty="No assignments are available in your courses." render={item => <><div><b>{item.title}</b><small>{item.course?.code ?? 'Course'}{item.course?.title ? ` · ${item.course.title}` : ''}</small></div><time>{dateTime(item.due_at)}</time></>}/>
  } else if (section === 'submissions' && isStudent) {
    sectionContent = <StudentSubmissionHistory rows={data.history ?? []} onDownload={onDownload}/>
  } else if (section === 'submissions' && isLecturer) {
    sectionContent = <LecturerSubmissions submissions={submissions} user={user} onRefresh={onSubmitted} onDownload={onDownload}/>
  } else if (section === 'submissions') {
    sectionContent = role === 'administrator'
      ? <RecordList rows={data.submissions} empty="No submissions are available." render={item => <><div><b>{item.student?.full_name || 'Student'} · {item.assignment?.title || 'Assignment'}</b><small>{item.assignment?.course?.code} · {item.file_name} · {dateTime(item.submitted_at)}{item.is_late ? ' · Late' : ''}</small></div><span>{item.assignment?.course?.title}</span></>}/>
      : <RecordList rows={isStudent ? submissions : isLecturer ? submissions : data.recentSubmissions} empty="No submissions are available." render={item => <><div><b>{assignments.find(assignment => assignment.id === item.assignment_id)?.title ?? item.file_name}</b><small>{item.file_name || 'Submission'} · {dateTime(item.submitted_at)}</small></div><span>{isStudent && grades.some(grade => grade.submission_id === item.id) ? 'Graded' : 'Submitted'}</span></>}/>
  } else if (section === 'grades' || section === 'grading') {
    if (isStudent) sectionContent = <RecordList rows={grades} empty="No published grades are available yet." render={grade => <><div><b>{grade.submissions?.assignments?.title ?? 'Assignment'}</b><small>{grade.feedback || 'No feedback provided'}</small></div><strong>{grade.points} points</strong></>}/>
    else {
      sectionContent = <LecturerSubmissions submissions={submissions} user={user} onRefresh={onSubmitted} onDownload={onDownload} pendingOnly/>
    }
  } else if (section === 'notifications') sectionContent = <>
    <div className="role-section-heading"><div><p className="eyebrow">UPDATES</p><h2>Your notifications</h2></div>{unreadCount > 0 && <button className="role-text-action" onClick={onReadAll}><CheckCheck size={15}/> Mark all as read</button>}</div>
    <RecordList rows={notifications} empty="You have no notifications." render={item => <div className="role-notification-row"><div><b>{item.title}</b><small>{item.body || 'Update'} · {dateTime(item.created_at)}</small></div><span className="role-notification-actions">{item.related_assignment_id && <button className="role-text-action" onClick={() => onRetry('assignments')}>Open assignment</button>}{item.related_grade_id && <button className="role-text-action" onClick={() => onRetry(isStudent ? 'grades' : 'grading')}>Open grade</button>}{!item.read_at && <button className="role-text-action" onClick={() => onRead(item.id)}>Mark read</button>}</span></div>}/>
  </>
  else if (section === 'users' || section === 'roles') sectionContent = <AdminUsers user={user} roleOnly={section === 'roles'}/>
  else if (section === 'activity') sectionContent = <ActivityLog rows={data.activity ?? []}/>
  else if (section === 'reports') sectionContent = <div className="admin-reports"><p>Download current platform records as CSV for offline reporting.</p><button className="student-submit-button" onClick={() => exportCsv('assignsimply-courses.csv', courses, [{ label: 'Code', value: row => row.code }, { label: 'Title', value: row => row.title }, { label: 'Lecturer ID', value: row => row.lecturer_id }])}><Download size={16}/> Export courses</button><button className="student-submit-button" onClick={() => exportCsv('assignsimply-assignments.csv', assignments, [{ label: 'Title', value: row => row.title }, { label: 'Course', value: row => row.course?.code }, { label: 'Status', value: row => row.status }, { label: 'Deadline', value: row => row.due_at }, { label: 'Max points', value: row => row.max_points }])}><Download size={16}/> Export assignments</button><button className="student-submit-button" onClick={() => exportCsv('assignsimply-submissions.csv', data.submissions, [{ label: 'Student', value: row => row.student?.full_name }, { label: 'Assignment', value: row => row.assignment?.title }, { label: 'Course', value: row => row.assignment?.course?.code }, { label: 'Filename', value: row => row.file_name }, { label: 'Submitted at', value: row => row.submitted_at }, { label: 'Late', value: row => row.is_late }])}><Download size={16}/> Export submissions</button></div>
  else sectionContent = <div className="role-schema-note">This section is not implemented yet.</div>

  return <main className={`workspace role-workspace role-${role}`}>
    <aside className="workspace-sidebar role-sidebar">
      <div className="role-sidebar-header"><Brand/><button className="role-menu-toggle" type="button" aria-label={mobileNavOpen ? 'Close navigation menu' : 'Open navigation menu'} aria-expanded={mobileNavOpen} aria-controls="role-navigation" onClick={() => setMobileNavOpen(open => !open)}>{mobileNavOpen ? <X size={20}/> : <Menu size={20}/>}</button></div>
      <div className="role-sidebar-caption">{roleNames[role]} workspace</div>
      <nav id="role-navigation" className={`role-navigation ${mobileNavOpen ? 'is-open' : ''}`} aria-label={`${roleNames[role]} navigation`}>
        {menu.map(([key, label, Icon, disabled]) => disabled
          ? <button key={key} className="side-link role-nav-link unavailable" type="button" disabled title="Not available in this stage"><Icon size={18}/><span>{label}</span></button>
          : <button key={key} className={`side-link role-nav-link ${section === key ? 'active' : ''}`} type="button" onClick={() => { onRetry(key); setMobileNavOpen(false) }} aria-current={section === key ? 'page' : undefined}><Icon size={18}/><span>{label}</span>{key === 'notifications' && unreadCount > 0 && <i className="role-unread-count">{unreadCount}</i>}</button>
        )}
      </nav>
      <div className="side-bottom"><div className="profile-chip"><span className="avatar">{firstName[0]?.toUpperCase()}</span><span><b>{firstName}</b><small>{roleNames[role]}</small></span></div></div>
    </aside>
    <section className="workspace-main role-main">
      <header className="workspace-top role-top"><span>{new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date())}</span><div className="role-top-actions">{role === 'student' && <button className="icon-button notification-button" aria-label={`Notifications, ${unreadCount} unread`} onClick={() => onRetry('notifications')}><Bell size={19}/>{unreadCount > 0 && <i/>}</button>}<button className="role-signout" onClick={onSignOut}><LogOut size={16}/> Sign out</button></div></header>
      {actionError && <div className="role-error" role="alert">{actionError}</div>}
      {section === 'overview' && <div className={`role-welcome ${role}`}><p className="eyebrow">{title}</p><h1>{greeting} <span>✦</span></h1><p>{isStudent ? 'Here is what is happening across your courses today.' : isLecturer ? 'Your courses and student work, gathered in one place.' : 'A live snapshot of the records currently in AssignSimply.'}</p></div>}
      {section === 'overview' ? <div className="role-stats-grid">{cards}</div> : <div className="role-page-heading"><p className="eyebrow">{roleNames[role]} workspace</p><h1>{sectionTitle}</h1></div>}
      <section className="role-panel" aria-label={sectionTitle}><div className="role-panel-content">{sectionContent}</div></section>
      {section === 'overview' && isStudent && <div className="role-quick-actions"><button onClick={() => onRetry('assignments')}><ClipboardCheck size={17}/> Browse assignments <ArrowRight size={15}/></button><button onClick={() => onRetry('submissions')}><FileText size={17}/> View submissions <ArrowRight size={15}/></button></div>}
      {section === 'overview' && isLecturer && <div className="role-quick-actions"><button onClick={() => onRetry('assignments')}><ClipboardCheck size={17}/> View assignments <ArrowRight size={15}/></button><button onClick={() => onRetry('submissions')}><GraduationCap size={17}/> Review submissions <ArrowRight size={15}/></button></div>}
      {section === 'overview' && role === 'administrator' && <><div className="role-section-heading"><div><p className="eyebrow">AUDIT TRAIL</p><h2>Recent activity</h2></div><button className="role-text-action" onClick={() => onRetry('activity')}>Open activity log <ArrowRight size={15}/></button></div><ActivityLog rows={(data.activity ?? []).slice(0, 5)}/></>}
    </section>
  </main>
}

export default function RoleDashboard() {
  const { user, loading: authLoading } = useAuth()
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [section, setSection] = useState('overview')
  const [actionError, setActionError] = useState('')

  const refresh = useCallback(async () => {
    if (!user) return
    setLoading(true)
    setError('')
    try {
      setResult(await loadRoleDashboard(user.id))
    } catch (cause) {
      setError(dashboardError(cause))
    } finally {
      setLoading(false)
    }
  }, [user])

  useEffect(() => { refresh() }, [refresh])
  useEffect(() => {
    const refreshWhenVisible = () => {
      if (!document.hidden) refresh()
    }
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => document.removeEventListener('visibilitychange', refreshWhenVisible)
  }, [refresh])
  const navigateSection = useCallback(key => { setSection(key); setActionError('') }, [])

  const readOne = async id => {
    try {
      await markNotificationRead(id, user.id)
      await refresh()
    } catch (cause) { setActionError(cause.message || 'Could not update the notification.') }
  }
  const readAll = async () => {
    try {
      await markAllNotificationsRead(user.id)
      await refresh()
    } catch (cause) { setActionError(cause.message || 'Could not update notifications.') }
  }
  const logout = async () => {
    try { await signOut() }
    catch (cause) { setActionError(cause.message || 'Could not sign out. Please try again.') }
  }
  const download = async (bucket, path, fileName) => {
    try { await downloadPrivateFile(bucket, path, fileName) }
    catch (cause) { setActionError(cause.message || 'The private file could not be downloaded.') }
  }

  if (authLoading) return <div className="loading-screen"><span className="loader"/> Preparing your workspace…</div>
  if (!user) return <Navigate to="/login" replace/>
  if (loading) return <div className="loading-screen"><span className="loader"/> Loading your dashboard…</div>
  if (error) return <main className="role-state"><Brand/><h1>Dashboard unavailable</h1><p>{error}</p><button className="submit-button" onClick={refresh}>Try again</button></main>
  if (!result) return null

  return <WorkspaceContent role={result.profile.role} section={section} data={result.data} profile={result.profile} user={user}
    onRetry={navigateSection} onRead={readOne} onReadAll={readAll} onSignOut={logout} onDownload={download} onSubmitted={refresh} actionError={actionError}/>
}
