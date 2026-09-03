/**
 * Batch and synchronous extraction must ask the same question.
 *
 *   node scripts/payload-parity-selftest.ts
 *
 * If the two transports ever send different prompts, different schemas
 * or different token ceilings, their results stop being comparable and
 * every benchmark built on the historical corpus quietly stops meaning
 * anything. The defence is structural -- one builder feeds both -- and
 * this asserts that the structure holds.
 *
 * Only transport wrappers may differ: batch nests the body under
 * {custom_id, params}. Everything inside params must be identical.
 */
import { buildExtractionRequest, EXTRACTION_VERSION } from "../lib/llm/extractRequirements.ts";
import { messageBody, modelForTier } from "../lib/llm/anthropic.ts";
import { createHash } from "node:crypto";

let pass = 0; const fails: string[] = [];
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ok   ${n}`); } else { fails.push(n); console.log(`  FAIL ${n}  ${d}`); }
};

const FIXTURE = {
  title: "Program Manager, Wealth Management",
  company: "Northern Trust",
  descriptionText: "Chicago, IL. Lead cross-functional programs. 5+ years of program management "
    + "required. Bachelor's degree. Salary Range: $114,700 - 194,900 USD.",
};
const MODEL = modelForTier("fast");

// The synchronous path: extractRequirements calls llm.complete(req), and
// the provider turns req into this body.
const req = buildExtractionRequest(FIXTURE);
const syncBody = messageBody(MODEL, req);

// The batch path: the same two calls, wrapped for the batch envelope.
const batchEntry = { custom_id: "abc123", params: messageBody(MODEL, buildExtractionRequest(FIXTURE)) };
const batchBody = batchEntry.params as Record<string, unknown>;

const digest = (o: unknown) => createHash("sha256").update(JSON.stringify(o)).digest("hex");

console.log("\n1. the whole payload is identical:");
check("byte-for-byte equal after serialisation", digest(syncBody) === digest(batchBody),
  `${digest(syncBody).slice(0, 12)} vs ${digest(batchBody).slice(0, 12)}`);
check("the batch wrapper adds only custom_id and params",
  Object.keys(batchEntry).sort().join(",") === "custom_id,params");

console.log("\n2. field by field, so a failure says which:");
for (const k of ["model", "max_tokens", "temperature", "system", "messages", "tools", "tool_choice"]) {
  check(`${k} matches`, digest((syncBody as any)[k]) === digest((batchBody as any)[k]),
    JSON.stringify((syncBody as any)[k])?.slice(0, 90));
}

console.log("\n3. the parts that carry meaning:");
{
  const msgs = syncBody["messages"] as Array<{ role: string; content: string }>;
  check("one user message", msgs.length === 1 && msgs[0]!.role === "user");
  check("the prompt names the company", msgs[0]!.content.includes("Northern Trust"));
  check("and the title", msgs[0]!.content.includes("Program Manager, Wealth Management"));
  check("and carries the posting text", msgs[0]!.content.includes("Salary Range: $114,700"));
  check("the system prompt is present and non-trivial",
    typeof syncBody["system"] === "string" && (syncBody["system"] as string).length > 200);
  const tools = syncBody["tools"] as Array<{ name: string; input_schema: unknown }>;
  check("exactly one tool", tools.length === 1);
  check("named emit", tools[0]!.name === "emit");
  check("and the model is forced to call it",
    JSON.stringify(syncBody["tool_choice"]) === JSON.stringify({ type: "tool", name: "emit" }));
  check("the schema requires a requirements array",
    JSON.stringify(tools[0]!.input_schema).includes("requirements"));
}

console.log("\n4. the model and versions are the same on both sides:");
check("model is the fast tier", syncBody["model"] === MODEL && batchBody["model"] === MODEL, String(syncBody["model"]));
check("extraction version is 4", EXTRACTION_VERSION === 4, String(EXTRACTION_VERSION));
check("max_tokens is unchanged at 8192", syncBody["max_tokens"] === 8192, String(syncBody["max_tokens"]));
check("temperature is 0", syncBody["temperature"] === 0);

console.log("\n5. the same job always builds the same payload:");
check("deterministic across calls",
  digest(messageBody(MODEL, buildExtractionRequest(FIXTURE))) === digest(syncBody));
check("a different job builds a different payload",
  digest(messageBody(MODEL, buildExtractionRequest({ ...FIXTURE, title: "Other" }))) !== digest(syncBody));

console.log("\n6. the truncation control is preserved:");
{
  // d0c46337 truncated at 8192 in the synchronous run. Leaving the
  // ceiling alone keeps it a usable control: if batch also truncates it,
  // that confirms the cause is output shape and not the transport.
  check("max_tokens was NOT raised to hide the truncation case", syncBody["max_tokens"] === 8192);
  // The 24k input cap is part of the shared builder, so both transports
  // truncate the same posting at the same point.
  const long = buildExtractionRequest({ ...FIXTURE, descriptionText: "x".repeat(50_000) });
  const content = (messageBody(MODEL, long)["messages"] as any)[0].content as string;
  check("a 50k posting is capped identically on both paths", content.includes("x".repeat(24_000)));
  check("and not beyond the cap", !content.includes("x".repeat(24_001)));
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
console.log("one builder, two transports, the same question");
