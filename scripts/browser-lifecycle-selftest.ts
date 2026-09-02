/**
 * The browser must be released when a submission ends.
 *
 * A confirmed submission used to leave Node alive holding
 * .browser-profile/SingletonLock, because the success path ran off the
 * end of the module and the persistent context kept the event loop from
 * draining. Every failure path called process.exit and tore the browser
 * down as a side effect, so the one path that mattered most was the one
 * that leaked. The next browser run on the machine then died with
 * "Opening in existing browser session".
 *
 * This drives the real launcher against a real Chrome, twice, using the
 * same profile. The second launch is the assertion: it can only succeed
 * if the first genuinely let go.
 */
import { rmSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { launchApplicationContext } from "../lib/browser/launch.ts";

let pass = 0;
const fails: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}  ${detail}`); }
};

// A throwaway profile. The real .browser-profile holds signed-in employer
// sessions and is never touched by a test.
const profileDir = mkdtempSync(join(tmpdir(), "lifecycle-profile-"));

try {
  const first = await launchApplicationContext({ profileDir });
  const page = await first.newPage();
  await page.setContent("<p>first run</p>");
  check("a context can be launched on a fresh profile", true);
  // Chrome writes SingletonLock as a SYMLINK to "hostname-pid", so
  // existsSync follows it to a target that does not exist and reports
  // false. The directory listing is what actually tells the truth.
  const singletons = () => readdirSync(profileDir).filter((f) => /^Singleton/.test(f));
  check("the profile is locked while it is open", singletons().length > 0, singletons().join(","));

  // What finish() does on a confirmed submission.
  await first.close();

  check("closing removes the lock rather than orphaning it",
    singletons().length === 0, singletons().join(","));

  // The assertion. A profile still held would reject this.
  const second = await launchApplicationContext({ profileDir });
  const page2 = await second.newPage();
  await page2.setContent("<p>second run</p>");
  check("a second run can take the same profile after a clean close", true);
  await second.close();

  check("and the profile can be taken a third time",
    await launchApplicationContext({ profileDir }).then(async (c) => { await c.close(); return true; })
      .catch(() => false));
} catch (e) {
  check("the profile was released between runs", false, (e as Error).message.slice(0, 140));
} finally {
  rmSync(profileDir, { recursive: true, force: true });
}

// The shutdown path exists in the submitter, and the success path uses it.
{
  const src = readFileSync(new URL("./submit-application.ts", import.meta.url), "utf8");
  check("the submitter defines a single-shot release",
    /let released = false;/.test(src) && /async function releaseBrowser/.test(src), "");
  check("a confirmed submission ends through it",
    /SUBMITTED and recorded at[\s\S]{0,400}await finish\(0\)/.test(src), "");
  check("failure paths after the browser opens release it too",
    (src.match(/await finish\(1\)/g) ?? []).length >= 4,
    String((src.match(/await finish\(1\)/g) ?? []).length));
  check("an unhandled throw still releases it",
    /uncaughtException[\s\S]{0,160}releaseBrowser/.test(src), "");
  check("--stay-open is opt-in, never the default",
    /const stayOpen = process\.argv\.includes\("--stay-open"\)/.test(src)
    && /if \(released \|\| stayOpen\) return;/.test(src), "");
}

console.log(`\n${pass + fails.length} cases, ${pass} passed`);
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("all passed");
