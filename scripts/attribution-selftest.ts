/**
 * The token has to be unguessable and say nothing.
 *
 * These are properties, not behaviours, so they are checked over many
 * samples rather than one.
 */
import { generateAttributionToken, isWellFormedToken } from "../lib/applications/attribution.ts";

let pass = 0; const fails: string[] = [];
const check = (name: string, cond: boolean, detail: string) => {
  if (cond) pass++; else fails.push(`  ${name}\n      ${detail}`);
};

const N = 20000;
const tokens = Array.from({ length: N }, generateAttributionToken);

check("every token is well formed", tokens.every(isWellFormedToken), "at least one is not");
check("every token satisfies the database constraint",
  tokens.every((t) => t.length >= 16 && t.length <= 64 && /^[A-Za-z0-9_-]+$/.test(t)), "shape violation");
check("tokens are URL safe with no padding",
  tokens.every((t) => !/[+/=]/.test(t)), "found base64 characters that need escaping");
check(`${N} tokens are all distinct`, new Set(tokens).size === N, `${N - new Set(tokens).size} collisions`);

// Sequence leakage: consecutive tokens must share no prefix beyond chance.
let sharedPrefix = 0;
for (let i = 1; i < 200; i++) if (tokens[i]![0] === tokens[i - 1]![0] && tokens[i]![1] === tokens[i - 1]![1]) sharedPrefix++;
check("consecutive tokens do not share a two-character prefix systematically",
  sharedPrefix < 20, `${sharedPrefix} of 199 shared one, which suggests a counter`);

// Every position should vary. A constant character anywhere is encoded data.
const positions = tokens[0]!.length;
let constant = 0;
for (let i = 0; i < positions; i++) if (new Set(tokens.slice(0, 2000).map((t) => t[i])).size <= 1) constant++;
check("no character position is constant across tokens", constant === 0, `${constant} fixed positions`);

check("tokens are a uniform length", new Set(tokens.map((t) => t.length)).size === 1,
  JSON.stringify([...new Set(tokens.map((t) => t.length))]));

// Nothing derived from the application: the generator takes no input at all.
check("the generator accepts no application data", generateAttributionToken.length === 0,
  `arity ${generateAttributionToken.length}`);

console.log(`${pass + fails.length} cases, ${pass} passed`);
for (const f of fails) console.log(f);
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("all passed");
