import { requireSupabase } from './supabase'

function unwrap(result) {
  if (result.error) throw result.error
  return result
}

function createUploadId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  return [...bytes].map((byte, index) => `${[4, 6, 8, 10].includes(index) ? '-' : ''}${byte.toString(16).padStart(2, '0')}`).join('')
}

function hasConflictingMime(file, expectedMime) {
  return Boolean(file.type && file.type !== 'application/octet-stream' && file.type !== expectedMime)
}

async function fetchAllRows(query) {
  const pageSize = 1000
  const rows = []
  for (let offset = 0; ; offset += pageSize) {
    const result = unwrap(await query.range(offset, offset + pageSize - 1))
    rows.push(...(result.data ?? []))
    if ((result.data ?? []).length < pageSize) return rows
  }
}

async function getProfile(userId) {
  const client = requireSupabase()
  const { data, error } = await client
    .from('profiles')
    .select('id, full_name, role')
    .eq('id', userId)
    .maybeSingle()
  if (error) throw error
  if (data) return data
  const { data: repairedProfile, error: repairError } = await client.rpc('ensure_my_profile')
  if (repairError) throw new Error(repairError.message || 'Your profile could not be loaded. Apply the latest database migration and try again.')
  const profile = Array.isArray(repairedProfile) ? repairedProfile[0] : repairedProfile
  if (!profile) throw new Error('Your profile could not be restored. Ask an administrator to review your account role.')
  return profile
}

async function getStudentDashboard(userId) {
  const client = requireSupabase()
  const [enrolmentsResult, submissionsResult, gradesResult, notificationsResult, historyResult] = await Promise.all([
    client.from('enrolments').select('course_id,courses(id,code,title,assignments(id,title,instructions,due_at,max_points,status,published_at,allow_late_submissions,allow_resubmissions,allowed_file_extensions,max_submission_file_size))').eq('student_id', userId),
    client.from('submissions').select('id,assignment_id,file_name,submitted_at,is_late').eq('student_id', userId).order('submitted_at', { ascending: false }),
    client.from('grades').select('id,points,feedback,published_at,submission_id,submissions(assignment_id,assignments(title))').not('published_at', 'is', null).order('published_at', { ascending: false }).limit(5),
    client.from('notifications').select('id,title,body,related_assignment_id,related_grade_id,read_at,created_at').order('created_at', { ascending: false }).limit(8),
    client.from('submission_versions').select('id,submission_id,version_number,file_path,file_name,submitted_at,is_late,submissions!inner(assignment_id,student_id)').eq('submissions.student_id', userId).order('submitted_at', { ascending: false }),
  ])
  const enrolments = unwrap(enrolmentsResult).data ?? []
  const submissions = unwrap(submissionsResult).data ?? []
  const grades = unwrap(gradesResult).data ?? []
  const notifications = unwrap(notificationsResult).data ?? []
  const history = unwrap(historyResult).data ?? []
  const courses = enrolments.map(({ courses: course }) => course).filter(Boolean)
  const assignments = courses.flatMap(course => (course.assignments ?? []).map(assignment => ({ ...assignment, course })))
  const assignmentIds = assignments.map(item => item.id)
  if (assignmentIds.length) {
    const { data: attachments, error: attachmentError } = await client.from('assignment_attachments')
      .select('id,assignment_id,file_path,file_name,mime_type,file_size').in('assignment_id', assignmentIds)
    if (attachmentError) throw attachmentError
    const byAssignment = new Map()
    for (const attachment of attachments ?? []) byAssignment.set(attachment.assignment_id, [...(byAssignment.get(attachment.assignment_id) ?? []), attachment])
    for (const assignment of assignments) assignment.assignment_attachments = byAssignment.get(assignment.id) ?? []
  }
  const historyAssignmentIds = [...new Set(history.map(row => row.submissions?.assignment_id).filter(Boolean))]
  if (historyAssignmentIds.length) {
    const [{ data: historyAssignments, error: assignmentError }, { data: historyGrades, error: historyGradeError }] = await Promise.all([
      client.from('assignments').select('id,title,course_id,courses(code,title)').in('id', historyAssignmentIds),
      client.from('grades').select('submission_id,points,feedback,published_at').in('submission_id', history.map(row => row.submission_id)),
    ])
    if (assignmentError) throw assignmentError
    if (historyGradeError) throw historyGradeError
    const assignmentMap = new Map((historyAssignments ?? []).map(item => [item.id, item]))
    const gradeMap = new Map((historyGrades ?? []).map(item => [item.submission_id, item]))
    for (const row of history) {
      const assignment = assignmentMap.get(row.submissions?.assignment_id)
      if (assignment) row.submissions.assignments = assignment
      const grade = gradeMap.get(row.submission_id)
      row.submissions.grades = grade ? [grade] : []
    }
  }
  const submissionByAssignment = new Map(submissions.map(submission => [submission.assignment_id, submission]))
  const now = Date.now()
  const pending = assignments.filter(assignment => !submissionByAssignment.has(assignment.id))
  const upcoming = assignments.filter(assignment => assignment.due_at && new Date(assignment.due_at).getTime() >= now)
    .sort((a, b) => new Date(a.due_at) - new Date(b.due_at)).slice(0, 5)
  return { courses, assignments: assignments.filter(item => item.status === 'published'), submissions, history, grades, notifications, pending, upcoming }
}

async function getLecturerDashboard(userId) {
  const client = requireSupabase()
  const { data: courses, error: coursesError } = await client
    .from('courses')
    .select('id,code,title,description,assignments(id,title,instructions,due_at,max_points,status,published_at,allow_late_submissions,allow_resubmissions,allowed_file_extensions,max_submission_file_size)')
    .eq('lecturer_id', userId)
  if (coursesError) throw coursesError
  const courseList = courses ?? []
  const assignments = courseList.flatMap(course => (course.assignments ?? []).map(assignment => ({ ...assignment, course })))
  const ids = assignments.map(assignment => assignment.id)
  if (!ids.length) return { courses: courseList, assignments, submissions: [], grades: [] }
  const [submissionsResult, gradesResult] = await Promise.all([
    client.from('submissions').select('id,assignment_id,student_id,file_path,file_name,submitted_at,is_late').in('assignment_id', ids).order('submitted_at', { ascending: false }),
    client.from('grades').select('id,submission_id,points,feedback,published_at,graded_by,updated_at').order('updated_at', { ascending: false }),
  ])
  const submissions = unwrap(submissionsResult).data ?? []
  const grades = unwrap(gradesResult).data ?? []
  const studentIds = [...new Set(submissions.map(item => item.student_id))]
  if (studentIds.length) {
    const { data: profiles, error: profileError } = await client.from('profiles').select('id,full_name').in('id', studentIds)
    if (profileError) throw profileError
    const profileMap = new Map((profiles ?? []).map(item => [item.id, item]))
    for (const submission of submissions) submission.student = profileMap.get(submission.student_id)
  }
  const assignmentMap = new Map(assignments.map(item => [item.id, item]))
  for (const course of courseList) for (const assignment of course.assignments ?? []) assignmentMap.set(assignment.id, { ...assignment, course })
  const gradeMap = new Map(grades.map(item => [item.submission_id, item]))
  const { data: attachments, error: attachmentError } = await client.from('assignment_attachments')
    .select('id,assignment_id,file_path,file_name,mime_type,file_size').in('assignment_id', ids)
  if (attachmentError) throw attachmentError
  const attachmentMap = new Map()
  for (const row of attachments ?? []) attachmentMap.set(row.assignment_id, [...(attachmentMap.get(row.assignment_id) ?? []), row])
  const submissionCounts = new Map()
  for (const submission of submissions) {
    submission.grade = gradeMap.get(submission.id) ?? null
    submission.assignment = assignmentMap.get(submission.assignment_id)
    submissionCounts.set(submission.assignment_id, (submissionCounts.get(submission.assignment_id) ?? 0) + 1)
  }
  for (const assignment of assignments) {
    assignment.assignment_attachments = attachmentMap.get(assignment.id) ?? []
    assignment.submission_count = submissionCounts.get(assignment.id) ?? 0
  }
  return {
    courses: courseList,
    assignments,
    submissions,
    grades,
  }
}

export async function saveLecturerAssignment(assignment, userId) {
  const client = requireSupabase()
  const payload = {
    course_id: assignment.course_id,
    title: assignment.title.trim(),
    instructions: assignment.instructions.trim(),
    due_at: assignment.due_at || null,
    max_points: Number(assignment.max_points),
    status: assignment.status,
    published_at: assignment.status === 'published' ? (assignment.published_at || new Date().toISOString()) : null,
    allow_late_submissions: Boolean(assignment.allow_late_submissions),
    allow_resubmissions: Boolean(assignment.allow_resubmissions),
    allowed_file_extensions: assignment.allowed_file_extensions,
    max_submission_file_size: Number(assignment.max_submission_file_size),
  }
  const query = assignment.id
    ? client.from('assignments').update(payload).eq('id', assignment.id).select('id').single()
    : client.from('assignments').insert(payload).select('id').single()
  const { data, error } = await query
  if (error) throw error
  const id = assignment.id ?? data.id
  const files = assignment.files ?? []
  for (const file of files) {
    if (!file || file.size <= 0) throw new Error('Choose a non-empty attachment file.')
    const extension = file.name.split('.').pop()?.toLowerCase()
    if (!extension || !MIME_BY_EXTENSION[extension]) throw new Error('Attachments must be PDF, DOC, DOCX, PPT, PPTX, XLS, or XLSX files.')
    if (file.size > 52428800) throw new Error('Each attachment must be 50 MB or smaller.')
    if (hasConflictingMime(file, MIME_BY_EXTENSION[extension])) throw new Error('An attachment content type does not match its extension.')
    const path = `${id}/${createUploadId()}.${extension}`
    const storage = client.storage.from('assignment-files')
    const { error: uploadError } = await storage.upload(path, file, { contentType: MIME_BY_EXTENSION[extension], upsert: false })
    if (uploadError) throw uploadError
    const { error: rowError } = await client.from('assignment_attachments').insert({
      assignment_id: id, file_path: path, file_name: file.name, mime_type: MIME_BY_EXTENSION[extension], file_size: file.size, uploaded_by: userId,
    })
    if (rowError) {
      await storage.remove([path])
      throw rowError
    }
  }
  return id
}

export async function removeLecturerAttachment(attachment) {
  const client = requireSupabase()
  const { error: storageError } = await client.storage.from('assignment-files').remove([attachment.file_path])
  if (storageError) throw storageError
  const { error } = await client.from('assignment_attachments').delete().eq('id', attachment.id)
  if (error) throw error
}

export async function saveLecturerGrade(submission, points, feedback, publish) {
  const score = Number(points)
  if (!Number.isFinite(score) || score < 0) throw new Error('Enter a valid non-negative score.')
  if (score > Number(submission.assignment?.max_points)) throw new Error(`The score cannot exceed ${submission.assignment.max_points} points.`)
  const { error } = await requireSupabase().from('grades').upsert({
    submission_id: submission.id, points: score, feedback: feedback.trim(), published_at: publish ? new Date().toISOString() : null,
    graded_by: (await requireSupabase().auth.getUser()).data.user?.id,
  }, { onConflict: 'submission_id' })
  if (error) throw error
}

async function getAdministratorDashboard() {
  const client = requireSupabase()
  const [users, students, lecturers, administrators, courses, courseRows, assignments, assignmentRows, submissions, submissionCount] = await Promise.all([
    client.from('profiles').select('id', { count: 'exact', head: true }),
    client.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'student'),
    client.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'lecturer'),
    client.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'administrator'),
    client.from('courses').select('id', { count: 'exact', head: true }),
    client.from('courses').select('id,code,title,description,lecturer_id').order('title'),
    client.from('assignments').select('id', { count: 'exact', head: true }),
    client.from('assignments').select('id,title,course_id,due_at,max_points,courses(id,code,title)').order('due_at'),
    client.from('submissions').select('id,assignment_id,file_name,submitted_at,student_id,is_late').order('submitted_at', { ascending: false }),
    client.from('submissions').select('id', { count: 'exact', head: true }),
  ])
  for (const result of [users, students, lecturers, administrators, courses, courseRows, assignments, assignmentRows, submissions, submissionCount]) unwrap(result)
  const [submissionIds, grades, activityResult] = await Promise.all([
    fetchAllRows(client.from('submissions').select('id')),
    fetchAllRows(client.from('grades').select('submission_id')),
    client.from('activity_logs').select('id,actor_id,action,target_type,target_id,metadata,created_at').order('created_at', { ascending: false }).limit(100),
  ])
  unwrap(activityResult)
  const gradedIds = new Set(grades.map(grade => grade.submission_id))
  const allSubmissions = submissions.data ?? []
  const studentIds = [...new Set(allSubmissions.map(item => item.student_id))]
  const { data: studentProfiles, error: studentError } = studentIds.length
    ? await client.from('profiles').select('id,full_name').in('id', studentIds)
    : { data: [], error: null }
  if (studentError) throw studentError
  const studentMap = new Map((studentProfiles ?? []).map(item => [item.id, item]))
  const assignmentMap = new Map((assignmentRows.data ?? []).map(item => [item.id, { ...item, course: item.courses }]))
  const lecturerIds = [...new Set((courseRows.data ?? []).map(item => item.lecturer_id))]
  const { data: lecturerProfiles, error: lecturerError } = lecturerIds.length
    ? await client.from('profiles').select('id,full_name').in('id', lecturerIds)
    : { data: [], error: null }
  if (lecturerError) throw lecturerError
  const lecturerMap = new Map((lecturerProfiles ?? []).map(item => [item.id, item]))
  for (const item of allSubmissions) {
    item.student = studentMap.get(item.student_id)
    item.assignment = assignmentMap.get(item.assignment_id)
  }
  return {
    counts: { users: users.count ?? 0, students: students.count ?? 0, lecturers: lecturers.count ?? 0, administrators: administrators.count ?? 0, courses: courses.count ?? 0, assignments: assignments.count ?? 0, submissions: submissionCount.count ?? 0, pendingGrading: submissionIds.filter(item => !gradedIds.has(item.id)).length },
    courses: (courseRows.data ?? []).map(item => ({ ...item, lecturer: lecturerMap.get(item.lecturer_id) })),
    assignments: (assignmentRows.data ?? []).map(item => ({ ...item, course: item.courses })),
    submissions: allSubmissions,
    recentSubmissions: allSubmissions.slice(0, 8),
    activity: activityResult.data ?? [],
  }
}

async function callAdminFunction(body) {
  const { data, error } = await requireSupabase().functions.invoke('admin-management', { body })
  if (error) {
    let details = data?.error
    if (!details && error.context?.json) {
      try { details = (await error.context.clone().json())?.error }
      catch { /* The gateway may return a non-JSON error body. */ }
    }
    throw new Error(details || error.message || 'The administration request failed.')
  }
  if (data?.error) throw new Error(data.error)
  return data
}

export async function listAdminUsers() {
  const result = await callAdminFunction({ action: 'list-users' })
  return result.users ?? []
}

export async function changeAdminUserRole(userId, role) {
  return callAdminFunction({ action: 'change-role', user_id: userId, role })
}

export async function saveAdminCourse(course) {
  const payload = { code: course.code.trim(), title: course.title.trim(), description: course.description.trim() || null, lecturer_id: course.lecturer_id }
  const query = course.id
    ? requireSupabase().from('courses').update(payload).eq('id', course.id)
    : requireSupabase().from('courses').insert(payload)
  const { error } = await query
  if (error) throw error
}

export async function listCourseEnrolments(courseId) {
  const client = requireSupabase()
  const { data, error } = await client.from('enrolments').select('id,student_id,enrolled_at').eq('course_id', courseId).order('enrolled_at', { ascending: false })
  if (error) throw error
  const ids = [...new Set((data ?? []).map(item => item.student_id))]
  const { data: profiles, error: profileError } = ids.length
    ? await client.from('profiles').select('id,full_name').in('id', ids)
    : { data: [], error: null }
  if (profileError) throw profileError
  const profileMap = new Map((profiles ?? []).map(item => [item.id, item]))
  return (data ?? []).map(item => ({ ...item, student: profileMap.get(item.student_id) }))
}

export async function addCourseEnrolment(courseId, studentId) {
  const { error } = await requireSupabase().from('enrolments').insert({ course_id: courseId, student_id: studentId })
  if (error) throw error
}

export async function removeCourseEnrolment(enrolmentId) {
  const { error } = await requireSupabase().from('enrolments').delete().eq('id', enrolmentId)
  if (error) throw error
}

export async function loadRoleDashboard(userId) {
  const profile = await getProfile(userId)
  let data
  if (profile.role === 'student') data = await getStudentDashboard(userId)
  else if (profile.role === 'lecturer') data = await getLecturerDashboard(userId)
  else if (profile.role === 'administrator') data = await getAdministratorDashboard()
  else throw new Error('Your account has an unsupported role. Contact a project administrator.')
  if (profile.role !== 'student') {
    const { data: notifications, error } = await requireSupabase().from('notifications')
      .select('id,title,body,related_assignment_id,related_grade_id,read_at,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(8)
    if (error) throw error
    data.notifications = notifications ?? []
  }
  return { profile, data }
}

export async function markNotificationRead(notificationId, userId) {
  const { error } = await requireSupabase().from('notifications').update({ read_at: new Date().toISOString() })
    .eq('id', notificationId).eq('user_id', userId).is('read_at', null)
  if (error) throw error
}

export async function markAllNotificationsRead(userId) {
  const { error } = await requireSupabase().from('notifications').update({ read_at: new Date().toISOString() })
    .eq('user_id', userId).is('read_at', null)
  if (error) throw error
}

const MIME_BY_EXTENSION = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

export async function submitStudentAssignment(userId, assignment, file) {
  if (!file || file.size <= 0) throw new Error('Choose a non-empty file to submit.')
  const extension = file.name.split('.').pop()?.toLowerCase()
  if (!extension || !MIME_BY_EXTENSION[extension]) throw new Error('Choose a PDF, DOC, DOCX, PPT, PPTX, XLS, or XLSX file.')
  if (!(assignment.allowed_file_extensions ?? []).includes(extension)) throw new Error('This file type is not allowed for the assignment.')
  if (file.size > assignment.max_submission_file_size) throw new Error('The selected file exceeds the assignment size limit.')
  const expectedMime = MIME_BY_EXTENSION[extension]
  if (hasConflictingMime(file, expectedMime)) throw new Error('The file content type does not match its extension.')
  const filePath = `${userId}/${assignment.id}/${createUploadId()}.${extension}`
  const storage = requireSupabase().storage.from('submission-files')
  const { error: uploadError } = await storage.upload(filePath, file, { contentType: expectedMime, upsert: false })
  if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`)
  const { data, error } = await requireSupabase().rpc('submit_assignment', {
    p_assignment_id: assignment.id,
    p_file_path: filePath,
    p_file_name: file.name,
  })
  if (error) {
    const { error: cleanupError } = await storage.remove([filePath])
    const cleanupMessage = cleanupError ? ` Temporary file cleanup failed: ${cleanupError.message}` : ''
    throw new Error(`Submission record failed: ${error.message}${cleanupMessage}`)
  }
  return data
}

export async function downloadPrivateFile(bucket, path, fileName) {
  const { data, error } = await requireSupabase().storage.from(bucket).download(path)
  if (error) throw error
  const objectUrl = URL.createObjectURL(data)
  const link = document.createElement('a')
  link.href = objectUrl
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 5000)
}
