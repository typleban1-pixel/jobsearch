#!/usr/bin/env bash
#
# Deploys the portal to Vercel.
#
#   bash scripts/deploy-portal.sh
#
# Refuses to run against a scope shared with another business, sets the
# two environment variables the portal needs without printing them, and
# never sends the service-role key or the Anthropic key to Vercel.
set -euo pipefail
cd "$(dirname "$0")/.."

FORBIDDEN_SCOPES="rentpup"

echo "== who the CLI is logged in as =="
WHO=$(npx vercel whoami 2>/dev/null | tail -1 || true)
if [ -z "$WHO" ]; then
  echo "   not logged in. Run: npx vercel login"
  exit 1
fi
echo "   $WHO"

# Fail CLOSED.
#
# The first version of this guard parsed the team table with awk, got
# nothing, and cheerfully reported "personal only" while the rentpup team
# was right there. A guard that silently does not fire is worse than no
# guard, because it is trusted. So: if the raw output mentions a forbidden
# scope, stop; and if the scope list cannot be read at all, also stop.
echo
echo "== scope check =="
TEAMS_RAW=$(npx vercel teams ls 2>&1 || true)
if ! echo "$TEAMS_RAW" | grep -q "Team name"; then
  echo "   could not read the team list. Refusing to guess which account this would deploy to."
  echo "$TEAMS_RAW" | tail -3 | sed 's/^/     /'
  exit 1
fi
for bad in $FORBIDDEN_SCOPES; do
  if echo "$TEAMS_RAW" | grep -qi "$bad"; then
    echo "   FOUND scope '$bad' on this login."
    echo
    echo "   This project must not share infrastructure with another business."
    echo "   Deploying here would put a personal job-search system holding employment"
    echo "   history and salary expectations inside another business's Vercel team."
    echo
    echo "   Log in to the separate account first:"
    echo "     npx vercel logout && npx vercel login"
    exit 1
  fi
done
TEAM_LINES=$(echo "$TEAMS_RAW" | sed -n '/Team name/,$p' | tail -n +2 | grep -c '[A-Za-z]' || true)
echo "   no forbidden scope present ($TEAM_LINES team(s) visible)"

echo
echo "== reading the two deployment variables from .env.local =="
# Read via the same loader the app uses, and never echo the values.
URL=$(node --input-type=module -e 'import{required}from"./lib/env.ts";process.stdout.write(required("SUPABASE_URL"))')
KEY=$(node --input-type=module -e 'import{optional}from"./lib/env.ts";process.stdout.write(optional("SUPABASE_PUBLISHABLE_KEY")??"")')
if [ -z "$KEY" ]; then echo "   SUPABASE_PUBLISHABLE_KEY is not set in .env.local"; exit 1; fi
echo "   SUPABASE_URL              ${#URL} chars"
echo "   SUPABASE_PUBLISHABLE_KEY  ${#KEY} chars"
echo "   (values not printed)"

echo
echo "== linking the project =="
npx vercel link --yes

echo
echo "== setting environment variables =="
# Piped on stdin, so the values never appear in argv or shell history.
for target in production preview development; do
  printf '%s' "$URL" | npx vercel env add SUPABASE_URL "$target" --force >/dev/null 2>&1 || true
  printf '%s' "$KEY" | npx vercel env add SUPABASE_PUBLISHABLE_KEY "$target" --force >/dev/null 2>&1 || true
done
echo "   set for production, preview and development"

echo
echo "== confirming the privileged keys are NOT on Vercel =="
LISTED=$(npx vercel env ls 2>/dev/null || true)
for forbidden in SUPABASE_SERVICE_ROLE_KEY ANTHROPIC_API_KEY; do
  if echo "$LISTED" | grep -q "$forbidden"; then
    echo "   $forbidden IS SET ON VERCEL. Remove it before deploying:"
    echo "     npx vercel env rm $forbidden production"
    exit 1
  fi
  echo "   $forbidden absent"
done

echo
echo "== deploying =="
npx vercel deploy --prod --yes
