/**
 * Sets the password on the existing Supabase Auth user, locally.
 *
 * Run it yourself, in your own terminal:
 *
 *   node scripts/set-owner-password.ts
 *
 * How the password is kept out of everything it should be out of
 * ---------------------------------------------------------------
 * It is TYPED AT A PROMPT, never passed as an argument and never read
 * from the environment. argv is visible to every process on the machine
 * and lands in shell history; an environment variable is inherited by
 * every child process. The script refuses both, rather than merely not
 * documenting them.
 *
 * Terminal echo is off while typing, so it does not appear on screen or
 * in a scrollback buffer. Nothing prints the value, and nothing writes it
 * to a file. It exists only in this process's memory, and only until the
 * process exits.
 *
 * The service-role key is used here and only here: updating another
 * user's credentials is an administrative act, which is exactly what that
 * key is for and exactly what the deployed portal must never be able to
 * do. This script never runs on a server.
 */
import { createInterface } from "node:readline";
import { createClient } from "@supabase/supabase-js";
import { optional, required } from "../lib/env.ts";

const OWNER_EMAIL = "typleban1@gmail.com";
const MIN_LENGTH = 12;

// Refuse the unsafe input channels explicitly.
if (process.argv.length > 2) {
  console.error("Refusing to read a password from the command line: argv is visible to every process");
  console.error("on this machine and is written to your shell history. Run with no arguments and type it.");
  process.exit(2);
}
for (const name of ["OWNER_PASSWORD", "SUPABASE_OWNER_PASSWORD", "PORTAL_TEST_PASSWORD"]) {
  if (optional(name)) {
    console.error(`Refusing to read a password from ${name}: an environment variable is inherited by every`);
    console.error("child process. Remove it and type the password at the prompt instead.");
    process.exit(2);
  }
}

/** Reads a line with terminal echo suppressed. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // readline writes each keystroke back to the terminal. Silencing that
    // is what keeps the password off the screen and out of scrollback.
    let silent = false;
    (rl as any)._writeToOutput = (chunk: string) => {
      if (!silent) (rl as any).output.write(chunk);
    };
    rl.question(question, (answer) => {
      silent = false;
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
    silent = true;
  });
}

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});

// The user must already exist. This script updates one account; it does
// not create accounts and there is no registration path anywhere.
const { data: list, error: listErr } = await db.auth.admin.listUsers({ perPage: 200 });
if (listErr) throw new Error(listErr.message);
const user = list.users.find((u) => u.email?.toLowerCase() === OWNER_EMAIL.toLowerCase());
if (!user) {
  console.error(`No Supabase Auth user with email ${OWNER_EMAIL}. This script updates an existing account`);
  console.error("and will not create one. Check the project reference in .env.local.");
  process.exit(1);
}

const { data: owners, error: ownerErr } = await db.from("app_owner").select("user_id,email");
if (ownerErr) throw new Error(ownerErr.message);
const isOwner = (owners ?? []).some((o: any) => o.user_id === user.id);

console.log(`Supabase project : ${required("SUPABASE_URL").replace(/^https:\/\//, "")}`);
console.log(`Account          : ${user.email}`);
console.log(`User id          : ${user.id}`);
console.log(`In app_owner     : ${isOwner ? "yes, this is the portal owner" : "NO"}`);
if (!isOwner) {
  console.error("\nThat account is not in app_owner, so it would sign in and see nothing. Stopping.");
  process.exit(1);
}
console.log(`\nType the new password. It will not be shown, and nothing here records it.\n`);

const first = await promptHidden("New password: ");
if (first.length < MIN_LENGTH) {
  console.error(`\nToo short: use at least ${MIN_LENGTH} characters. Nothing was changed.`);
  process.exit(1);
}
const second = await promptHidden("Confirm password: ");
if (first !== second) {
  console.error("\nThose did not match. Nothing was changed.");
  process.exit(1);
}

const { error: updErr } = await db.auth.admin.updateUserById(user.id, { password: first });
if (updErr) {
  console.error(`\nSupabase rejected the change: ${updErr.message}`);
  process.exit(1);
}
console.log("\nPassword updated.");

// Prove it works, through the same publishable-key path the portal uses,
// rather than trusting that the write succeeded.
const publishable = optional("SUPABASE_PUBLISHABLE_KEY") ?? optional("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
if (publishable) {
  const asUser = createClient(required("SUPABASE_URL"), publishable, { auth: { persistSession: false } });
  const { error: signInErr } = await asUser.auth.signInWithPassword({ email: OWNER_EMAIL, password: first });
  if (signInErr) {
    console.error(`Verification sign-in FAILED: ${signInErr.message}`);
    process.exit(1);
  }
  const { data: ownerOk } = await asUser.rpc("is_app_owner");
  console.log(`Verified: sign-in succeeds and is_app_owner() returns ${ownerOk}.`);
  await asUser.auth.signOut();
}

console.log(`\nSign in at http://localhost:3000/login with ${OWNER_EMAIL} and the password you just typed.`);
