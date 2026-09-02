# Deploying the portal

Verified locally against a production build on 30 Aug 2026. Everything
below has been tested except the two steps that need the deployed URL,
which cannot exist before the first deploy.

## What the deployment needs

**Environment variables, both server-side:**

    SUPABASE_URL                 https://<project>.supabase.co
    SUPABASE_PUBLISHABLE_KEY     the publishable (anon) key

That is the whole list. Neither needs a `NEXT_PUBLIC_` prefix, because no
client code in this app talks to Supabase: the portal is server-rendered
end to end and the session lives in httpOnly cookies.

**Must never be set on Vercel:**

    SUPABASE_SERVICE_ROLE_KEY    ingestion, extraction, scoring, eligibility
    ANTHROPIC_API_KEY            requirement extraction

Those belong to the worker scripts, which run on a trusted machine. The
deployed portal reads and writes as the signed-in user and is constrained
by RLS; it has no privileged path and does not need one.

Verified: a production build started with **only** the two variables above
serves the login page, signs a user in, renders 488 job cards, opens a
detail page, and saves and clears interest. `SUPABASE_SERVICE_ROLE_KEY`
appears in neither `.next/server` nor `.next/static`.

## Supabase settings that change at deploy time

Both are in the Supabase dashboard and both are currently pointed at
localhost, which is correct for local work and wrong once deployed.

1. **Authentication → URL Configuration → Site URL**
   Set to the deployed origin. `{{ .SiteURL }}` is baked into every
   recovery email, so leaving it on localhost means password-reset links
   that only work on the machine that sent them.

2. **Authentication → URL Configuration → Redirect URLs**
   Add `https://<deployed-origin>/auth/confirm`. Needed only for
   app-initiated resets, which name that route explicitly.

Keep localhost in the redirect list so local development keeps working.

## Cookie behaviour

Auth cookies are `Secure; HttpOnly; SameSite=lax`. `Secure` is set
whenever `NODE_ENV === "production"`, which is correct on Vercel and has
one local consequence worth knowing: running `next start` over plain HTTP
on localhost produces cookies a real browser will refuse. Use `next dev`
for local browser work; `next start` is for verifying the build.

## Before the first deploy

- [ ] `.env.local` is gitignored and untracked. Verified.
- [ ] `npm run build` clean, no warnings. Verified.
- [ ] `node scripts/verify-security.ts` passes. Verified.
- [ ] A Vercel scope that is not shared with another business. **See below.**

## The scope constraint

This project must not share infrastructure with any other project or
business. That is a standing instruction from the outset and it applies
to hosting as much as to databases.

The Vercel CLI on this machine is authenticated as `support-8870`, whose
only available scope is the **rentpup** team, containing rentpup.com.
Deploying this portal there would put a personal job-search system holding
employment history, salary expectations and application decisions inside
another business's Vercel team, sharing its billing, member list and
access controls.

Decided 30 Aug 2026: a **brand new Vercel account**, not connected to
rentpup in any way.

That account has to be created by a person; account creation is not
something this system does. Once it exists:

    npx vercel logout
    npx vercel login          # the new account
    bash scripts/deploy-portal.sh

`scripts/deploy-portal.sh` refuses to run if the rentpup scope is visible
on the login, reads the two variables from `.env.local` without printing
them, pipes them to Vercel on stdin so they never enter argv or shell
history, asserts that neither the service-role key nor the Anthropic key
is set on Vercel, and only then deploys.

## After deploying

1. Set Site URL and add the redirect URL, as above.
2. Sign in at `https://<origin>/login`.
3. Confirm an unauthenticated request to `/` redirects to `/login`.
4. Run `node scripts/verify-security.ts` again; it tests the database
   directly and is unaffected by where the portal runs, but it confirms
   nothing drifted during setup.
5. Test the recovery flow once against the deployed origin, since Site
   URL changed.

The worker keeps running locally. It writes to the same Supabase project,
so the deployed portal sees new jobs without the deployment knowing the
worker exists.
