/**
 * ============================ STAGED v17 PROVENANCE ============================
 * NOT LIVE PROFILE TRUTH. Nothing here is persisted to the database. These are
 * the reviewed, finalized-but-unpersisted artifacts for the future v17 profile
 * release (see the v17 release checklist): the new verified capability, the
 * per-bullet capability tags, and the compact metric statements. They are used
 * ONLY by the inert V2 integration harness so V2 can be exercised end-to-end
 * without a text-signature tagger and without touching v16.
 *
 * When v17 is released, these move into the profile (skills + master résumé
 * JSONB) and this file is deleted from the V2 path.
 * ============================================================================
 */

/** The new verified capability to add in v17 (normal skills-row shape). */
export const STAGED_V17_SKILL = {
  name: "Managing concurrent priorities",
  status: "VERIFIED",
  category: "Operations and process",
  related_terms: ["multitasking", "managing multiple priorities", "handling competing priorities", "concurrent workload management"],
} as const;

/** bullet (matched by text prefix) -> verified capability names it demonstrates. */
export const STAGED_BULLET_CAPABILITIES: Record<string, string[]> = {
  "Design and develop physical products": ["Product ideation", "Iterative product development", "FDM 3D printing", "Parametric CAD", "Onshape", "Material selection", "Tolerance testing", "Functional prototyping", "Design for manufacturing"],
  "Products designed in this role have sold": [],
  "Designed marketing emails": ["Email marketing", "Email design", "Marketing funnel design", "Audience segmentation"],
  "Played a substantial hands-on role in developing": ["Launching a new offering"],
  "Executed digital marketing and ecommerce": ["SEO", "Ecommerce", "Website development", "Google Analytics", "Email marketing"],
  "Produced creative work across multiple brands": ["Managing concurrent priorities"],
  "Collaborated cross-functionally with marketing": ["Cross-department collaboration", "Project coordination"],
  "Configured automated workflows in Asana": ["Workflow automation", "Asana", "Workflow design", "Process improvement"],
  "Supported broader marketing initiatives": ["SEO"],
  "Translated client goals into practical production": ["Solution development", "Client needs assessment"],
  "Worked directly with clients to understand business": ["Client needs assessment", "Solution development"],
  "Worked personally on client projects for Cleveland": ["Video production", "Video editing", "Motion graphics", "Graphic design"],
  "Supported client acquisition and sales by speaking": ["Phone sales", "Customer acquisition", "Client needs assessment"],
  "Taught and mentored 250+ students": ["Teaching and mentoring"],
  "Supervised the day-to-day work of three student": ["Staff supervision"],
  "Coordinated a college and industry collaboration": ["External partnership coordination", "Project coordination", "Video editing", "Motion graphics"],
  "Maintained and troubleshot professional production": ["Tool and service evaluation"],
  "Property-compliance monitoring system built": ["Property compliance"],
  "In use by 21 users and generating": [],
  "RentPup collects and normalizes information": ["Third-party service integration", "Property compliance"],
  "Detected changes are connected to delivery": ["Workflow automation"],
  "RentPup generates individualized direct-mail": ["Direct mail marketing", "Workflow automation"],
};

/**
 * Compact, standalone metric statements. Each is a fresh grounded sentence
 * about a single verified number -- NOT a reframe of an experience bullet -- so
 * the summary can cite a number without reusing (and duplicating) a selected
 * bullet. `groundedAgainst` is the metric's verified wording, used to prove the
 * compact phrase adds no unsupported fact.
 */
export const STAGED_METRICS: { phrase: string; capabilities: string[]; groundedAgainst: string }[] = [
  { phrase: "Grew a marketing email audience to approximately 180,000 contacts.", capabilities: ["Email marketing", "Marketing funnel design", "Audience segmentation"], groundedAgainst: "email marketing funnels for an email audience of approximately 180,000 contacts" },
  { phrase: "Helped launch an education offering that reached over $70,000 in annual recurring revenue.", capabilities: ["Launching a new offering"], groundedAgainst: "developing, launching, and operating Genius Academy, an offering that reached more than $70,000 in annual recurring revenue" },
  { phrase: "Taught and mentored 250+ students.", capabilities: ["Teaching and mentoring"], groundedAgainst: "Taught and mentored 250+ students" },
];

export const capabilitiesFor = (text: string): string[] => {
  for (const k of Object.keys(STAGED_BULLET_CAPABILITIES)) if (text.startsWith(k)) return STAGED_BULLET_CAPABILITIES[k]!;
  return [];
};
