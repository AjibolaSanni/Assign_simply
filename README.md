# AssignSimply

AssignSimply is a React and Supabase academic assignment platform. It includes student, lecturer, and administrator workspaces, student assignment submission, and lecturer assignment and grading workflows.

## Run locally

1. Install Node.js (LTS) and the [Supabase CLI](https://supabase.com/docs/guides/cli).
2. Run `npm install`.
3. Initialize Supabase CLI configuration with `supabase init`, then link this folder with `supabase link --project-ref <project-ref>`.
4. Apply all versioned migrations with `supabase db push`. They create the core tables, constraints, indexes, RLS policies, and private Storage buckets.
5. Copy `.env.example` to `.env` and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. Never put a service-role key, database password, or other privileged secret in a `VITE_` variable.
6. Configure Supabase Auth site and redirect URLs for your local origin and `/reset-password`, then run `npm run dev`.

The frontend only uses a Supabase publishable key. Never put a service-role key, database password, or other privileged secret in a `VITE_` variable. When Supabase is not configured, the sign-in and registration controls remain disabled and explain what setup is needed.

## Current routes

- `/login` — email and password sign-in
- `/register` — student registration (role is fixed to `student` in signup metadata; no public lecturer/admin choice)
- `/forgot-password` and `/reset-password` — Supabase password recovery
- `/app` — authenticated workspace entry point

## Database and trusted roles

The core migration is [20261018000100_core_schema_and_rls.sql](supabase/migrations/20261018000100_core_schema_and_rls.sql). Public signup always creates a `student` profile, regardless of submitted auth metadata. The client cannot update profile roles. Before the administration migration and Edge Function have been deployed, lecturer and initial administrator roles must be assigned by a trusted project owner/operator in the Supabase SQL Editor after verifying the person. For example:

```sql
update public.profiles set role = 'lecturer'
where id = (select id from auth.users where email = 'lecturer@example.edu');

update public.profiles set role = 'administrator'
where id = (select id from auth.users where email = 'admin@example.edu');
```

Store submission objects as `<student-uuid>/<assignment-uuid>/<filename>` in the private bucket. The workflow extension allows PDF, Word, PowerPoint, and Excel files, caps bucket objects at 50 MiB, and defaults each assignment's submission limit to 20 MiB.

The student workflow extension is [20261019000100_student_workflow.sql](supabase/migrations/20261019000100_student_workflow.sql). It adds published assignment visibility, supported file metadata, private assignment attachments, submission version history, server-side deadline/resubmission checks, and a safe self-profile repair function. Apply all migrations with `supabase db push`. The student uploader uses private Storage and the `submit_assignment` database function; do not bypass it with direct submission table writes.

The lecturer workflow migration is [20261020000100_lecturer_workflow.sql](supabase/migrations/20261020000100_lecturer_workflow.sql). It sends in-app notifications when an assignment or grade is published and requests a PostgREST schema-cache refresh. Lecturers can create and edit assignments, save drafts, publish or close assignments, attach private question files, review submissions, and save or publish grades. The frontend loads attachments and submission grades with direct table queries to avoid relying on unavailable nested relationship-cache entries.

Supabase's built-in Auth email provider has a low send limit. If signup reports an email rate limit, wait for the limit window; for regular user onboarding, configure a custom SMTP provider in **Authentication → SMTP Settings**. Deadline reminder emails are not automated because no scheduled job has been configured.

The administration migration is [20261021000100_administration.sql](supabase/migrations/20261021000100_administration.sql). It adds an append-only, RLS-protected activity log, records registration/course/enrolment/assignment/submission/grading events, and protects the final administrator and courses assigned to lecturers during role changes. Role changes run through the `admin-management` Edge Function and a service-role-only SQL function; the browser never receives a privileged key. Deploy it after applying the migrations:

```sh
npx supabase functions deploy admin-management --project-ref <your-project-ref>
```

The function reads Supabase's injected `SUPABASE_URL` and server-side secret-key environment variables. Do not add `SUPABASE_SERVICE_ROLE_KEY` as a custom Edge Function secret; the `SUPABASE_` prefix is reserved by Supabase. Keep privileged keys out of browser code and `VITE_` variables. The Edge Function gateway verifies the JWT, and the function independently validates the user and checks the database role. The admin dashboard can search users, change roles with confirmation, manage courses and enrolments, inspect assignments/submissions and audit activity, and export CSV reports. Account status is visible, but suspending accounts is not exposed in-app because existing access tokens require coordinated RLS enforcement to guarantee immediate suspension.

## Next steps

1. Inspect migration state in the linked Supabase project before applying anything. The live schema was previously inspected, but its migration history was not registered, so do not blindly rerun the versioned SQL against that database.
2. Confirm authentication and role assignment with separate student, lecturer, and administrator test accounts. Public signup must remain student-only.
3. Seed disposable course, assignment, and submission records, then test upload and download with student and lecturer sessions. Verify cross-student and cross-course denials without using the service-role key.
4. Link this source folder to its Git repository and Vercel project, configure the two public frontend variables, deploy a preview, and verify routes and role boundaries before production promotion.

## Deployment and production verification

Vercel should build this Vite app with `npm run build` and publish the `dist` directory. The root `vercel.json` rewrites deep links to the SPA entry point so routes still load after a refresh. Set only these frontend variables in the Vercel Production and Preview environments:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

Never set the Supabase service-role key or database password as a `VITE_` variable. After configuring Vercel, deploy a preview first, then verify `/login`, `/register`, `/app`, and a dashboard deep link on refresh before promoting it to production. Supabase Auth Site URL and redirect URLs must include the deployed domain.

This workspace has a local Supabase URL and publishable key configured and is linked to the project reference recorded in `supabase/.temp`. The local checkout has no `.git` metadata, while the Vercel project is connected to `AjibolaSanni/Assign_simply`. The Production environment now has `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`; a redeployment built successfully and is ready. The live sign-in form is enabled, but password authentication still needs verification with an account owner-entered session.

The lecturer assignment attachment and student submission upload flows are implemented, but their live Storage operations still need verification with authenticated lecturer and student accounts. If an upload fails, record the exact on-screen Supabase error and the role, bucket, file extension, and approximate file size. Check that the applied migrations created the private `assignment-files` and `submission-files` buckets and their role-specific Storage policies; do not make either bucket public or disable RLS as a workaround.
# Assign_simply
