-- Rebrand: CodeQuest -> Logikalia
-- Student accounts use a deterministic fake email (`{nisn}@students.codequest.local`)
-- for Supabase Auth sign-in. This migration only rewrites that email domain for
-- EXISTING accounts so they keep working with the new app code, which now builds
-- emails as `{nisn}@students.logikalia.local`. No other data is touched.
--
-- Run this in the Supabase SQL editor (or via `supabase db execute`) against the
-- project's database. Safe to re-run: the WHERE clauses only match rows still on
-- the old domain, so a second run is a no-op.

begin;

-- auth.users.email is the primary sign-in identifier used by signInWithPassword.
update auth.users
set email = replace(email, '@students.codequest.local', '@students.logikalia.local'),
    updated_at = now()
where email like '%@students.codequest.local';

-- auth.identities stores email/password identities separately; identity_data->>'email'
-- must match auth.users.email for password sign-in to resolve the identity.
-- (auth.identities.email is a generated column derived from identity_data, so it
-- updates automatically once identity_data is rewritten below.)
update auth.identities
set identity_data = jsonb_set(
      identity_data,
      '{email}',
      to_jsonb(replace(identity_data ->> 'email', '@students.codequest.local', '@students.logikalia.local'))
    ),
    updated_at = now()
where identity_data ->> 'email' like '%@students.codequest.local';

commit;
