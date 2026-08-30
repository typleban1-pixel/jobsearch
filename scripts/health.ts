/** Ingestion health. Reads only; safe to run any time. */
import { getStore } from "../lib/db/index.ts";

const store = getStore();
console.log(`store: ${store.kind}\n`);
const report = await store.healthReport();
await store.close();
for (const [k, v] of Object.entries(report)) {
  if (v && typeof v === "object") {
    console.log(`${k}:`);
    for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
      console.log(`  ${String(k2).padEnd(60)} ${v2}`);
    }
  } else {
    console.log(`${k.padEnd(30)} ${v}`);
  }
}
