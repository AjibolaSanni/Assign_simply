import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return reply(405, { error: 'Method not allowed' })

  try {
    const url = Deno.env.get('SUPABASE_URL')
    const secretKeysEnv = Deno.env.get('SUPABASE_SECRET_KEYS')
    let secretKey: string | undefined
    if (secretKeysEnv) {
      try {
        const secretKeys = JSON.parse(secretKeysEnv) as Record<string, unknown>
        if (typeof secretKeys.default === 'string') secretKey = secretKeys.default
      } catch {
        // Fall back to the legacy injected service-role variable below.
      }
    }
    secretKey ||= Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SECRET_KEY')
    if (!url || !secretKey) return reply(500, { error: 'The server is missing its Supabase configuration.' })

    const authorization = request.headers.get('Authorization') || ''
    const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1]
    if (!token) return reply(401, { error: 'Sign in to continue.' })

    const admin = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data: callerData, error: authError } = await admin.auth.getUser(token)
    if (authError || !callerData.user) return reply(401, { error: 'Your session is invalid or expired.' })
    const callerId = callerData.user.id
    const { data: callerProfile, error: profileError } = await admin.from('profiles').select('role').eq('id', callerId).maybeSingle()
    if (profileError) throw profileError
    if (callerProfile?.role !== 'administrator') return reply(403, { error: 'Administrator access is required.' })

    const body = await request.json()
    if (body.action === 'list-users') {
      const authUsers = []
      for (let page = 1; ; page += 1) {
        const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 })
        if (error) throw error
        authUsers.push(...data.users)
        if (data.users.length < 1000) break
      }
      const { data: profiles, error } = await admin.from('profiles').select('id,full_name,role,created_at')
      if (error) throw error
      const profileMap = new Map((profiles ?? []).map(profile => [profile.id, profile]))
      const users = authUsers.map(user => {
        const profile = profileMap.get(user.id)
        return {
          id: user.id,
          email: user.email ?? '',
          full_name: profile?.full_name ?? user.user_metadata?.full_name ?? '',
          role: profile?.role ?? 'student',
          created_at: profile?.created_at ?? user.created_at,
          last_sign_in_at: user.last_sign_in_at,
          banned_until: user.banned_until,
        }
      })
      return reply(200, { users })
    }

    const targetId = typeof body.user_id === 'string' ? body.user_id : ''
    if (!targetId) return reply(400, { error: 'Choose a valid user account.' })
    if (targetId === callerId) return reply(400, { error: 'You cannot change your own role.' })
    const { data: target, error: targetError } = await admin.from('profiles').select('role,full_name').eq('id', targetId).maybeSingle()
    if (targetError) throw targetError
    if (!target) return reply(404, { error: 'The selected user profile was not found.' })

    if (body.action === 'change-role') {
      const nextRole = body.role
      if (!['student', 'lecturer', 'administrator'].includes(nextRole)) return reply(400, { error: 'Choose a supported role.' })
      if (nextRole === target.role) return reply(200, { ok: true, unchanged: true })
      const { error } = await admin.rpc('admin_change_user_role', {
        p_actor_id: callerId,
        p_target_id: targetId,
        p_new_role: nextRole,
      })
      if (error) return reply(409, { error: error.message })
      return reply(200, { ok: true })
    }

    return reply(400, { error: 'Unsupported administration action.' })
  } catch (error) {
    console.error('admin-management failed', error)
    return reply(500, { error: error?.message || 'The administration request failed.' })
  }
})
