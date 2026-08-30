# LLM boundary

Add a provider by implementing `LlmProvider` in this directory. Nothing
outside `lib/llm` may import a vendor SDK.

Tiers are chosen by the caller from the work, not the wallet:

| Tier | Used for | Runs on |
|---|---|---|
| `embedding` | semantic prefilter over the whole corpus | every job, every day |
| `fast` | normalization, extraction, classification | shortlist after deterministic filters |
| `reasoning` | fit judgement, requirement interpretation, drafting | top candidates only |

The funnel is the cost model. Roughly 30–60k live jobs across a few
hundred companies is unaffordable to reason over daily and trivial to
embed. Deterministic filters cut first, embeddings rank, and the
expensive tier only ever sees what survives.
