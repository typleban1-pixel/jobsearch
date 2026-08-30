/**
 * Seed vocabulary for term_aliases.
 *
 * Many aliases collapse onto one canonical term, never the reverse: a
 * string that expands to several meanings is ambiguity, not a synonym,
 * and resolving it belongs to extraction rather than to a lookup table.
 *
 * This is a starting set, not a claim of completeness. The miss rate
 * measured against real extracted requirements is what tells us where it
 * is thin, and the table is editable so a gap found while reading
 * postings can be fixed without a deploy.
 */

export interface SeedAlias {
  alias: string;
  canonical: string;
  note?: string;
}

export const SEED_ALIASES: SeedAlias[] = [
  { alias: "js", canonical: "javascript" },
  { alias: "nodejs", canonical: "node" },
  { alias: "node js", canonical: "node" },
  { alias: "typescript", canonical: "typescript" },
  { alias: "ts", canonical: "typescript", note: "ambiguous in prose; only safe on an extracted skill term" },
  { alias: "reactjs", canonical: "react" },
  { alias: "react native", canonical: "react-native", note: "distinct from react" },
  // Canonical "next" collided with the English word: the corpus probe
  // reported it in 758 postings, almost all of them "next steps". A
  // canonical term has to be unambiguous in prose, because extraction
  // will surface it from prose.
  { alias: "nextjs", canonical: "nextjs" },
  { alias: "next js", canonical: "nextjs" },
  { alias: "postgres", canonical: "postgresql" },
  { alias: "psql", canonical: "postgresql" },
  { alias: "ms sql", canonical: "sql-server" },
  { alias: "mssql", canonical: "sql-server" },
  { alias: "gcp", canonical: "google-cloud" },
  { alias: "google cloud platform", canonical: "google-cloud" },
  { alias: "amazon web services", canonical: "aws" },
  { alias: "microsoft azure", canonical: "azure" },
  { alias: "k8s", canonical: "kubernetes" },
  { alias: "ci cd", canonical: "ci-cd" },
  { alias: "continuous integration", canonical: "ci-cd" },
  { alias: "infrastructure as code", canonical: "iac" },
  { alias: "rest api", canonical: "rest-api" },
  { alias: "restful", canonical: "rest-api" },
  { alias: "rest apis", canonical: "rest-api" },
  { alias: "graph ql", canonical: "graphql" },
  { alias: "ml", canonical: "machine-learning" },
  { alias: "machine learning", canonical: "machine-learning" },
  { alias: "llm", canonical: "large-language-models" },
  { alias: "llms", canonical: "large-language-models" },
  { alias: "genai", canonical: "generative-ai" },
  { alias: "nlp", canonical: "natural-language-processing" },
  { alias: "power bi", canonical: "powerbi" },
  { alias: "google analytics", canonical: "ga4" },
  { alias: "salesforce crm", canonical: "salesforce" },
  { alias: "sfdc", canonical: "salesforce" },
  { alias: "hubspot crm", canonical: "hubspot" },
  { alias: "ms excel", canonical: "excel" },
  { alias: "microsoft excel", canonical: "excel" },
  { alias: "google sheets", canonical: "sheets" },
  { alias: "figma design", canonical: "figma" },
  { alias: "a b testing", canonical: "ab-testing" },
  { alias: "split testing", canonical: "ab-testing" },
  { alias: "search engine optimization", canonical: "seo" },
  { alias: "search engine optimisation", canonical: "seo" },
  { alias: "sem", canonical: "paid-search" },
  { alias: "ppc", canonical: "paid-search" },
  { alias: "project management", canonical: "project-management" },
  { alias: "product management", canonical: "product-management" },
  { alias: "account management", canonical: "account-management" },
  { alias: "customer success", canonical: "customer-success" },
  { alias: "business development", canonical: "business-development" },
  { alias: "bdr", canonical: "business-development" },
  { alias: "sdr", canonical: "sales-development" },
  { alias: "b2b saas", canonical: "b2b-saas" },
  { alias: "go to market", canonical: "gtm" },
  { alias: "p and l", canonical: "p-and-l" },
  { alias: "profit and loss", canonical: "p-and-l" },
  { alias: "kpis", canonical: "kpi" },
  { alias: "okrs", canonical: "okr" },
];
