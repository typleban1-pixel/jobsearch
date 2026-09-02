// Environment access.
//
// Every secret in this system is read here and nowhere else, so there is
// exactly one place to audit. Nothing in this file ever logs a value:
// `describeEnv()` reports whether a variable is set and how long it is,
// which is enough to debug a misconfiguration and useless to anyone who
// gets hold of a log.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

let loaded = false;

/** Minimal .env.local reader. No dependency, no interpolation, no export to argv. */
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  // Next loads .env.local before any of this runs, so inside the portal
  // the file read is redundant work that also makes the bundler warn
  // about a dynamically constructed path and pull the whole project
  // directory into the server bundle. The worker scripts run under plain
  // node, where the read is the only way the variables arrive.
  if (process.env["NEXT_RUNTIME"]) return;
  for (const file of [".env.local", ".env"]) {
    const path = resolve(process.cwd(), file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  }
}

export function optional(name: string): string | undefined {
  loadEnv();
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

export function required(name: string): string {
  const v = optional(name);
  if (!v) {
    throw new Error(
      `Missing ${name}. Put it in .env.local (which is gitignored). Never pass a secret on the command line: argv is visible to every process on the machine.`,
    );
  }
  return v;
}

/** Safe to print. Says whether a secret exists, never what it is. */
export function describeEnv(names: string[]): string {
  loadEnv();
  return names
    .map((n) => {
      const v = process.env[n];
      return `  ${n.padEnd(32)} ${v ? `set (${v.length} chars)` : "not set"}`;
    })
    .join("\n");
}
