import { requireSupabase } from './supabase'

export async function signIn(email, password) {
  const { data, error } = await requireSupabase().auth.signInWithPassword({ email: email.trim(), password })
  if (error) throw error
  return data
}

export async function register({ fullName, email, password }) {
  const { data, error } = await requireSupabase().auth.signUp({
    email: email.trim(), password,
    options: { data: { full_name: fullName.trim(), role: 'student' } },
  })
  if (error) throw error
  return data
}

export async function signOut() {
  const { error } = await requireSupabase().auth.signOut()
  if (error) throw error
}

export async function requestPasswordReset(email) {
  const { error } = await requireSupabase().auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}/reset-password` })
  if (error) throw error
}

export async function updatePassword(password) {
  const { data, error } = await requireSupabase().auth.updateUser({ password })
  if (error) throw error
  return data
}
