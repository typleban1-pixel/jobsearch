/**
 * Resume intake, 30 Aug 2026.
 *
 * Every row here is a PROPOSAL. Nothing becomes VERIFIED without an
 * explicit act by the user.
 *
 * The governing rule is reframe, never create. In practice that meant
 * three things while writing this file:
 *
 *   Levels are argued from evidence, not from how much resume space a
 *   thing occupies. The user said this directly: years of video work is
 *   the most-evidenced thing on the page and the least wanted going
 *   forward, so it is EXPERIENCED and AVOID_SPECIALIST at the same time.
 *   Capability and appetite are separate columns precisely for this.
 *
 *   Anything the resume does not establish is left UNKNOWN and moved to
 *   the question list. Employment type at Holley, the depth behind
 *   Shopify or Webflow, salary expectations: none of these appear, so
 *   none of them are guessed.
 *
 *   Nothing is promoted across categories. RentPup is a project and does
 *   not become employment. Genius Academy is an accomplishment inside a
 *   job and does not become a separate role.
 */

export const PROFILE = {
  legal_first_name: "Tyler",   // QUESTION: resume header says "TY PLEBAN"
  legal_last_name: "Pleban",
  preferred_name: "Ty",
  email_job_search: "typleban1@gmail.com",
  city: "Cleveland",
  state: "OH",
  country: "US",
  // CONFIRMED by the user on 30 Aug 2026. Not on the resume; stated
  // directly. The floor is a deal breaker and excludes before ranking;
  // the other two only rank.
  salary_hard_floor: 85_000,
  salary_target_min: 100_000,
  salary_target_ideal: 115_000,
  // CONFIRMED by the user on 30 Aug 2026. SENSITIVE in the
  // classification registry: stored, never placed in a prompt, a log or
  // an audit trail. Only ever reaches an application form.
  work_authorization: "US citizen",
  requires_sponsorship: false,
  // Deliberately still absent: phone and street address.
  //
  // Explicitly NOT recorded: any prior-compensation benchmark. The user
  // stated that recent history is overlapping contract work and is not a
  // clean single-salary figure, so there is no number to anchor on and
  // none may be invented.
};

/**
 * Employment, corrected by the user on 30 Aug 2026.
 *
 * Two corrections mattered more than the rest.
 *
 * Holley ran 2022 to 2024, not 2021 to 2023 as the resume says. The
 * resume is wrong.
 *
 * The three roles were NOT concurrent. Genius One and Anytime Picture
 * were paused while he relocated to Kentucky for Holley, then resumed
 * afterwards. Storing one row per employer would have claimed continuous
 * engagement across a period he was working full time in another state,
 * so each paused-and-resumed engagement is two stints. Two rows for one
 * employer is correct data here, not a duplicate.
 *
 * Every date is YEAR precision. The user supplied years and asked to be
 * asked rather than have months invented, so the stored day and month are
 * padding and start_precision says so. No generated document may render a
 * month from these.
 */
export const EMPLOYMENT = [
  {
    employer: "Genius One, Inc.", stint: 1,
    actual_title: "Digital Marketing, Product & Operations Specialist (Contract)",
    location: "Highland Heights, OH",
    start_month: "2019-01-01", start_precision: "YEAR",
    end_month: "2022-01-01", end_precision: "YEAR",
    is_current: false, employment_type: "CONTRACT",
    stint_note: "Approximately full-time hours, concurrent with part-time Anytime Picture work. Ended on relocating to Bowling Green, Kentucky for Holley.",
    departure_reason: "Relocated to Bowling Green, Kentucky to take the Holley position.",
    responsibilities: [
      "Execute marketing, product, ecommerce, creative, and operational initiatives based on company priorities, taking loosely defined objectives from idea through implementation",
      "Contribute directly to product ideation and development, including identifying product opportunities and developing original concepts",
      "Design, prototype, test, and refine physical products using FDM 3D printing, parametric CAD/Onshape, slicer configuration, material selection, tolerance testing, and iterative functional testing",
      "Execute digital marketing and ecommerce work across websites, SEO, email, analytics, content, creative production, and online storefronts",
      "Attend industry trade shows to research emerging products, technologies, equipment, competitors, and trends",
      "Coordinate with the owner, a small internal team, partners, instructors, customers, and other stakeholders",
    ],
    accomplishments: ["Built and supported Genius Academy, an education-focused offering"],
    notes: "User states explicitly: did not own Genius One's overall COMPANY marketing strategy. The owner established overall priorities and delegated objectives; the role was heavily execution-oriented, determining how to accomplish them, sometimes requiring research and learning something new. Also contributed original ideas including product ideas. SCOPE: this narrows one company and one level of ownership. It is not evidence of lacking marketing-strategy capability generally.",
  },
  {
    employer: "Genius One, Inc.", stint: 2,
    actual_title: "Digital Marketing, Product & Operations Specialist (Contract)",
    location: "Highland Heights, OH",
    start_month: "2024-01-01", start_precision: "YEAR",
    end_month: null, end_precision: null,
    is_current: true, employment_type: "CONTRACT",
    stint_note: "Resumed after returning to Ohio, initially at approximately full-time hours. CURRENTLY PART-TIME contract work. The user does not currently hold a full-time position.",
    departure_reason: null,
    responsibilities: [
      "Execute marketing, product, ecommerce, creative, and operational initiatives based on company priorities",
      "Contribute to product ideation and development",
      "Execute digital marketing and ecommerce work",
    ],
    accomplishments: [],
    notes: "Same role and employer as stint 1. Currently part-time.",
  },
  {
    employer: "Anytime Picture LLC", stint: 1,
    actual_title: "Video Production & Client Solutions Specialist (Contract)",
    location: "Cleveland, OH",
    start_month: "2019-01-01", start_precision: "YEAR",
    end_month: "2022-01-01", end_precision: "YEAR",
    is_current: false, employment_type: "CONTRACT",
    stint_note: "Generally part-time, concurrent with Genius One. Ended on relocating to Kentucky for Holley.",
    departure_reason: "Relocated to Bowling Green, Kentucky to take the Holley position.",
    responsibilities: [
      "Translated client goals into practical production solutions within budget, timeline, creative, and technical constraints",
      "Worked directly with clients to understand business needs, develop solutions, troubleshoot challenges, and deliver finished projects",
      "Led hands-on production and post-production across video editing, compositing, motion graphics, and graphic design using Adobe Creative Suite",
      "Supported client acquisition and sales by speaking with prospects, assessing needs, recommending solutions, and closing projects over the phone",
      "Helped develop the company website and researched emerging technologies at industry trade shows",
    ],
    accomplishments: ["Worked on projects for clients including Cleveland Clinic and Amazon"],
    notes: "User states the role involved more than camera and edit work: client discovery, feasibility assessment within budget and timeline, approach development, problem solving, plus client acquisition and phone closing, website contribution, technology research, graphics and motion graphics.",
  },
  {
    employer: "Anytime Picture LLC", stint: 2,
    actual_title: "Video Production & Client Solutions Specialist (Contract)",
    location: "Cleveland, OH",
    start_month: "2024-01-01", start_precision: "YEAR",
    end_month: "2025-01-01", end_precision: "YEAR",
    is_current: false, employment_type: "CONTRACT",
    stint_note: "Resumed part-time after returning to Ohio. Work ended in 2025.",
    departure_reason: null,
    responsibilities: ["Part-time video production and client solutions work"],
    accomplishments: [],
    notes: "Same role and employer as stint 1.",
  },
  {
    employer: "Holley Performance", stint: 1,
    actual_title: "Videographer & Editor",
    location: "Bowling Green, KY",
    // Corrected. The resume says 2021 to 2023 and that is wrong.
    start_month: "2022-01-01", start_precision: "YEAR",
    end_month: "2024-01-01", end_precision: "YEAR",
    is_current: false, employment_type: "FULL_TIME",
    stint_note: "Direct W-2 position, NOT work performed through Anytime Picture. Relocated to Bowling Green, Kentucky for it. Genius One and Anytime Picture were both paused for its duration.",
    departure_reason: "Not dissatisfaction with the work, which the user liked. Layoffs were occurring and he was concerned about the company and job outlook, so he proactively decided to leave and move back to Ohio.",
    responsibilities: [
      "Produced creative work across multiple brands, internal teams, and concurrent projects with shifting priorities and deadlines",
      "Collaborated cross-functionally with marketing and other teams to determine creative approaches and execute projects from planning through delivery",
      "Produced automotive documentaries, product launches, interviews, event coverage, promotional content, graphics, and motion graphics using Adobe Creative Suite",
      "Supported broader marketing initiatives through creative production, scripts, content publishing, and SEO-oriented metadata",
    ],
    accomplishments: [],
    notes: "User states the title understates the role: worked across multiple teams and simultaneous fast-paced projects and supported broader marketing initiatives.",
  },
  {
    employer: "Lorain County Community College", stint: 1,
    actual_title: "Video Production Lab Instructor",
    location: "Elyria, OH",
    start_month: "2016-01-01", start_precision: "YEAR",
    end_month: "2019-01-01", end_precision: "YEAR",
    is_current: false, employment_type: null,
    stint_note: null, departure_reason: null,
    responsibilities: [
      "Managed day-to-day lab operations and maintained and troubleshot professional production technology",
      "Supervised three staff members",
      "Taught and mentored students, translating technical concepts and professional workflows into hands-on instruction",
      "Researched and evaluated emerging technology and helped lead a major equipment modernization initiative",
      "Coordinated cross-department projects supporting college programs, marketing, community partnerships, and outreach",
    ],
    accomplishments: [
      "Created the Video Program's internship program from the ground up",
      "Developed real-world student production opportunities, with student work ultimately selected for regional television commercials",
    ],
    notes: "User states the significance extends beyond video: supervision, teaching and mentoring, troubleshooting, program creation, technology evaluation and implementation, cross-department collaboration, and managing a production-lab environment.",
  },
];

export const PROJECTS = [
  {
    name: "RentPup",
    kind: "STARTUP",
    start_month: "2026-01-01", end_month: null,
    description: "A property-compliance monitoring product helping Cleveland rental-property owners identify regulatory issues and upcoming compliance risks.",
    my_contribution: "Identified the business problem, designed the product around it, researched and selected technologies and services, used AI-assisted development, connected and troubleshot systems, developed workflows and data processes, worked on interface and customer experience, and developed acquisition and operational strategies.",
    tools: ["Claude Code","GitHub","Vercel","Supabase","Stripe","Google Analytics","Sentry","Resend"],
    results: null,             // no outcome stated; not invented
    current_status: "Active",
    // Recorded verbatim because it is the single most likely place for a
    // generated document to overreach.
    notes: "User states explicitly: evidence of product building, technical problem solving, rapid learning and systems thinking. It must NOT be converted into a claim of being a professional software engineer or expert programmer. Built independently in spare time: it must never imply employment by RentPup, and must never be used to suggest it replaced or substituted for full-time employment. It is a project and must never be promoted to employment.",
  },
  {
    name: "Genius Academy",
    kind: "BUSINESS",
    start_month: null, end_month: null,
    description: "An education-focused offering built and supported within Genius One.",
    my_contribution: "Built and supported the offering.",
    tools: [],
    results: null,
    current_status: null,
    notes: "Recorded as a project for visibility, and ALSO stays an accomplishment inside the Genius One employment record. It is not separate employment. The revenue figure is held as an unapproved metric pending the user's wording.",
  },
  {
    name: "LCCC Video Program internship program",
    kind: "TECHNICAL_PROJECT",
    start_month: null, end_month: null,
    description: "An internship program for the Video Program at Lorain County Community College, created from the ground up.",
    my_contribution: "Created the program from the ground up and developed real-world student production opportunities.",
    tools: [],
    results: "Student work ultimately selected for regional television commercials.",
    current_status: null,
    notes: "Program creation evidence, distinct from teaching. Sits inside the LCCC role rather than replacing it.",
  },
];

/**
 * Metrics are separate rows and every one defaults to approved_for_use
 * false. None of these may appear in a resume or an answer until the user
 * approves the exact wording, because a number is the most abusable thing
 * on a profile.
 */
export const METRICS = [
  {
    label: "Genius Academy annual recurring revenue",
    // APPROVED by the user on 30 Aug 2026, verbatim. The first approved
    // metric in the profile.
    //
    // Every hedge in it is load bearing: "substantial hands-on role"
    // claims contribution not authorship, "an offering that reached"
    // attributes revenue to the offering, "a peak of" prevents a
    // high-water mark reading as current, and "in 2022" answers the
    // follow-up before it is asked.
    approved_wording: "Played a substantial hands-on role in developing, launching, and operating Genius Academy, an education-focused offering that reached a peak of more than $70,000 in annual recurring revenue in 2022",
    numeric_value: 70000, unit: "USD_ARR",
    period_start: "2022-01-01", period_end: "2022-12-31",
    approved: true,
    employer: "Genius One, Inc.",
    context_note: "CONFIRMED: $70,000+ is Genius Academy's TOTAL annual recurring revenue, peak not current, reached 2022. The owner originated the initial concept; the user developed the direction for turning it into an actual offering and did much of the hands-on implementation. Must never be represented as revenue personally generated by the user, and never as independent ownership of company business strategy.",
  },
  {
    label: "Students taught and mentored",
    approved_wording: "Taught and mentored 250+ students",
    numeric_value: 250, unit: "students",
    employer: "Lorain County Community College",
    context_note: "QUESTION: over the full 2016 to 2019 period, or per year?",
  },
  {
    label: "Staff supervised",
    approved_wording: "Supervised three staff members",
    numeric_value: 3, unit: "people",
    employer: "Lorain County Community College",
    context_note: "QUESTION: direct reports, or student workers? This is the only people-management evidence in the profile, so its exact nature matters.",
  },
  {
    label: "Videos produced in cross-department collaboration",
    approved_wording: "A first-of-its-kind collaboration that produced 10+ videos",
    numeric_value: 10, unit: "videos",
    employer: "Lorain County Community College",
    context_note: "First-of-its-kind is the resume's claim; confirm it is accurate as written.",
  },
];

/**
 * Genius Academy responsibilities, captured as evidence in their own
 * right.
 *
 * The user asked for this specifically, and he was right to: the ARR
 * figure alone is a number with nothing under it. These nineteen lines
 * are what make it credible, and several of them are the strongest
 * evidence in the profile for skills that the resume listed without
 * demonstrating anywhere.
 */
export const GENIUS_ACADEMY_EVIDENCE = [
  "Developed the website and platform for Genius Academy",
  "Set up ecommerce and subscription billing",
  "Helped determine pricing",
  "Designed and implemented the marketing funnels",
  "Ran email marketing",
  "Ran SEO",
  "Ran advertising",
  "Produced graphics and branding",
  "Produced video and content",
  "Drove customer acquisition",
  "Handled customer support",
  "Found and recruited local instructors and talent",
  "Coordinated instructors",
  "Ran analytics",
  "Developed product and course ideas",
  "Handled technical troubleshooting",
  "Improved the website and conversion process over time",
  "Ran day-to-day operations",
  "Developed the overall direction for turning the owner's initial idea into a functioning offering, and produced it from concept to reality",
];

export const EDUCATION = [
  {
    institution: "Western Governors University, Leavitt School of Health",
    credential: "Bachelor of Science", field_of_study: "Health Science",
    end_month: "2025-05-01", completed: true,
    notes: "Coursework included anatomy and physiology, microbiology, pathophysiology, epidemiology, public health, health psychology, health equity, and related health-science subjects.",
  },
  {
    institution: "Lorain County Community College",
    credential: "Associate of Arts", field_of_study: null,
    end_month: "2015-05-01", completed: true, notes: null,
  },
];

/**
 * Skills.
 *
 * Level answers "what has this person actually done", interest answers
 * "what do they want next". They are independent, and the video stack is
 * the case that proves why: it is the most-evidenced thing on the resume
 * and explicitly not the desired direction.
 *
 *   EXPERIENCED  done repeatedly, for money, over years
 *   CAPABLE      done real work with it, not for years or not repeatedly
 *   EXPOSURE     touched it, would not claim more
 *   LEARNING     actively acquiring
 *
 *   AVOID_SPECIALIST  still strengthens candidacy; must never become the
 *                     career the system recommends
 */
export const SKILLS = [
  // Video and creative. Deepest evidence, deliberately capped appetite.
  { name: "Video production", category: "creative", level: "EXPERIENCED", interest: "AVOID_SPECIALIST", importance: "SUPPORTING" , provenance: "STATED" },
  { name: "Video editing", category: "creative", level: "EXPERIENCED", interest: "AVOID_SPECIALIST", importance: "SUPPORTING" , provenance: "STATED" },
  { name: "Adobe Premiere Pro", category: "creative", level: "EXPERIENCED", interest: "AVOID_SPECIALIST", importance: "SUPPORTING", related: ["premiere"] , provenance: "STATED" },
  { name: "Adobe After Effects", category: "creative", level: "EXPERIENCED", interest: "AVOID_SPECIALIST", importance: "SUPPORTING", related: ["after effects"] , provenance: "STATED" },
  { name: "Motion graphics", category: "creative", level: "EXPERIENCED", interest: "AVOID_SPECIALIST", importance: "SUPPORTING" , provenance: "STATED" },
  { name: "Graphic design", category: "creative", level: "EXPERIENCED", interest: "AVOID_SPECIALIST", importance: "SUPPORTING" , provenance: "STATED" },
  { name: "Adobe Photoshop", category: "creative", level: "EXPERIENCED", interest: "AVOID_SPECIALIST", importance: "SUPPORTING", related: ["photoshop"] , provenance: "STATED" },
  { name: "Adobe Illustrator", category: "creative", level: "EXPERIENCED", interest: "AVOID_SPECIALIST", importance: "SUPPORTING", related: ["illustrator"] , provenance: "STATED" },
  { name: "Adobe InDesign", category: "creative", level: "CAPABLE", interest: "AVOID_SPECIALIST", importance: "BACKGROUND", related: ["indesign"] , provenance: "STATED" },
  { name: "Adobe Lightroom", category: "creative", level: "CAPABLE", interest: "AVOID_SPECIALIST", importance: "BACKGROUND", related: ["lightroom"] , provenance: "STATED" },
  { name: "Compositing", category: "creative", level: "CAPABLE", interest: "AVOID_SPECIALIST", importance: "BACKGROUND" , provenance: "STATED" },
  { name: "Photography", category: "creative", level: "CAPABLE", interest: "AVOID_SPECIALIST", importance: "BACKGROUND" , provenance: "STATED" },

  // Marketing and growth. Executed repeatedly across three roles.
  { name: "SEO", category: "marketing", level: "EXPERIENCED", interest: "POSITIVE", importance: "CORE", related: ["search engine optimization"] , provenance: "INFERRED" },
  { name: "Email marketing", category: "marketing", level: "EXPERIENCED", interest: "POSITIVE", importance: "SUPPORTING" , provenance: "INFERRED" },
  { name: "Google Analytics", category: "marketing", level: "EXPERIENCED", interest: "POSITIVE", importance: "SUPPORTING", related: ["ga4","analytics"] , provenance: "INFERRED" },
  { name: "Ecommerce", category: "marketing", level: "EXPERIENCED", interest: "POSITIVE", importance: "CORE", related: ["e-commerce","online storefront"] , provenance: "INFERRED" },
  { name: "Customer acquisition", category: "marketing", level: "EXPERIENCED", interest: "ACTIVELY_SEEK", importance: "CORE", related: ["client acquisition","digital acquisition"] , provenance: "INFERRED" },
  { name: "Direct mail marketing", category: "marketing", level: "CAPABLE", interest: "POSITIVE", importance: "SUPPORTING", related: ["direct-mail"] , provenance: "INFERRED" },
  { name: "Conversion testing", category: "marketing", level: "EXPERIENCED", interest: "POSITIVE", importance: "SUPPORTING", related: ["ab testing","a/b testing"] , provenance: "INFERRED" },
  { name: "Campaign execution", category: "marketing", level: "EXPERIENCED", interest: "POSITIVE", importance: "SUPPORTING" , provenance: "INFERRED" },
  { name: "CMS platforms", category: "marketing", level: "CAPABLE", interest: "NEUTRAL", importance: "BACKGROUND" , provenance: "INFERRED" },
  { name: "Phone sales", category: "sales", level: "CAPABLE", interest: "NEUTRAL", importance: "BACKGROUND", related: ["inside sales","closing"] , provenance: "INFERRED" },

  // Product and prototyping. Repeated professional use at Genius One.
  { name: "Product ideation", category: "product", level: "EXPERIENCED", interest: "ACTIVELY_SEEK", importance: "CORE" , provenance: "INFERRED" },
  { name: "Functional prototyping", category: "product", level: "EXPERIENCED", interest: "ACTIVELY_SEEK", importance: "CORE", related: ["prototyping"] , provenance: "INFERRED" },
  { name: "Iterative product development", category: "product", level: "EXPERIENCED", interest: "ACTIVELY_SEEK", importance: "CORE" , provenance: "INFERRED" },
  { name: "FDM 3D printing", category: "product", level: "EXPERIENCED", interest: "POSITIVE", importance: "SUPPORTING", related: ["3d printing","additive manufacturing"] , provenance: "INFERRED" },
  { name: "Parametric CAD", category: "product", level: "CAPABLE", interest: "POSITIVE", importance: "SUPPORTING", related: ["cad"] , provenance: "INFERRED" },
  { name: "Onshape", category: "product", level: "CAPABLE", interest: "POSITIVE", importance: "BACKGROUND" , provenance: "INFERRED" },
  { name: "Tinkercad", category: "product", level: "EXPOSURE", interest: "NEUTRAL", importance: "BACKGROUND" , provenance: "INFERRED" },
  { name: "Slicer configuration", category: "product", level: "CAPABLE", interest: "NEUTRAL", importance: "BACKGROUND" , provenance: "INFERRED" },
  { name: "Tolerance testing", category: "product", level: "CAPABLE", interest: "NEUTRAL", importance: "BACKGROUND" , provenance: "INFERRED" },
  { name: "Material selection", category: "product", level: "CAPABLE", interest: "NEUTRAL", importance: "BACKGROUND", related: ["polymer knowledge"] , provenance: "INFERRED" },

  // Digital and technical. All from RentPup: one project, 2026 to now.
  // Capped at CAPABLE with an explicit restriction, because the user drew
  // this line himself and it is the easiest place to overreach.
  { name: "Claude Code", category: "technical", level: "CAPABLE", interest: "ACTIVELY_SEEK", importance: "CORE",
    restrictions: ["Used heavily on one project (RentPup) since 2026, not across multiple employers"] , provenance: "STATED" },
  { name: "AI-assisted development", category: "technical", level: "CAPABLE", interest: "ACTIVELY_SEEK", importance: "CORE",
    related: ["ai-assisted","ai enabled"] , provenance: "STATED" },
  { name: "Supabase", category: "technical", level: "CAPABLE", interest: "POSITIVE", importance: "SUPPORTING",
    restrictions: ["Would not want an advanced backend or database engineering interview on this"] , provenance: "INFERRED" },
  { name: "Vercel", category: "technical", level: "CAPABLE", interest: "POSITIVE", importance: "SUPPORTING" , provenance: "INFERRED" },
  { name: "GitHub", category: "technical", level: "CAPABLE", interest: "POSITIVE", importance: "SUPPORTING", related: ["git"] , provenance: "INFERRED" },
  { name: "Stripe", category: "technical", level: "CAPABLE", interest: "POSITIVE", importance: "SUPPORTING",
    restrictions: ["Integration-level use, not payments engineering"] , provenance: "INFERRED" },
  { name: "Sentry", category: "technical", level: "EXPOSURE", interest: "NEUTRAL", importance: "BACKGROUND" , provenance: "INFERRED" },
  { name: "Resend", category: "technical", level: "EXPOSURE", interest: "NEUTRAL", importance: "BACKGROUND" , provenance: "INFERRED" },
  { name: "Third-party service integration", category: "technical", level: "CAPABLE", interest: "ACTIVELY_SEEK", importance: "CORE" , provenance: "INFERRED" },
  { name: "Requirements definition", category: "product", level: "CAPABLE", interest: "ACTIVELY_SEEK", importance: "CORE" , provenance: "INFERRED" },
  { name: "Workflow design", category: "operations", level: "CAPABLE", interest: "ACTIVELY_SEEK", importance: "CORE" , provenance: "INFERRED" },
  { name: "Tool and service evaluation", category: "operations", level: "EXPERIENCED", interest: "ACTIVELY_SEEK", importance: "CORE",
    related: ["technology evaluation","vendor evaluation"] , provenance: "INFERRED" },

  // Tools listed on the resume with no supporting bullet anywhere.
  // UNKNOWN on purpose: listing a tool is not evidence of using it.
  { name: "Shopify", category: "ecommerce", level: "UNKNOWN", interest: "NEUTRAL", importance: "BACKGROUND",
    restrictions: ["QUESTION: depth not established by the resume"] , provenance: "INFERRED" },
  { name: "BigCommerce", category: "ecommerce", level: "UNKNOWN", interest: "NEUTRAL", importance: "BACKGROUND",
    restrictions: ["QUESTION: depth not established by the resume"] , provenance: "INFERRED" },
  { name: "Webflow", category: "ecommerce", level: "UNKNOWN", interest: "NEUTRAL", importance: "BACKGROUND",
    restrictions: ["QUESTION: depth not established by the resume"] , provenance: "INFERRED" },

  // Operations, teaching, supervision.
  { name: "Client needs assessment", category: "operations", level: "EXPERIENCED", interest: "ACTIVELY_SEEK", importance: "CORE" , provenance: "INFERRED" },
  { name: "Solution development", category: "operations", level: "EXPERIENCED", interest: "ACTIVELY_SEEK", importance: "CORE" , provenance: "INFERRED" },
  { name: "Project coordination", category: "operations", level: "EXPERIENCED", interest: "ACTIVELY_SEEK", importance: "CORE", related: ["project management"] , provenance: "INFERRED" },
  { name: "Process improvement", category: "operations", level: "CAPABLE", interest: "ACTIVELY_SEEK", importance: "CORE" , provenance: "INFERRED" },
  { name: "Cross-department collaboration", category: "operations", level: "EXPERIENCED", interest: "POSITIVE", importance: "CORE", related: ["cross-functional collaboration"] , provenance: "INFERRED" },
  { name: "Teaching and mentoring", category: "operations", level: "EXPERIENCED", interest: "POSITIVE", importance: "SUPPORTING" , provenance: "INFERRED" },
  { name: "Staff supervision", category: "operations", level: "CAPABLE", interest: "NEUTRAL", importance: "SUPPORTING",
    restrictions: ["Evidence is three staff at LCCC, 2016 to 2019. Not evidence of managing a large team"] , provenance: "INFERRED" },
  { name: "Program creation", category: "operations", level: "CAPABLE", interest: "POSITIVE", importance: "SUPPORTING" , provenance: "INFERRED" },


  // Added 30 Aug 2026 from the Genius Academy responsibilities. Each has
  // a specific line of evidence behind it rather than a resume listing.
  { name: "Marketing funnel design", category: "marketing", level: "EXPERIENCED", interest: "POSITIVE", importance: "SUPPORTING", related: ["funnel","acquisition funnel"], provenance: "INFERRED" },
  { name: "Paid advertising", category: "marketing", level: "CAPABLE", interest: "NEUTRAL", importance: "BACKGROUND", related: ["advertising","paid media"], provenance: "INFERRED" },
  { name: "Pricing", category: "product", level: "CAPABLE", interest: "POSITIVE", importance: "SUPPORTING",
    restrictions: ["Contributory: helped determine pricing rather than owning it"], provenance: "INFERRED" },
  { name: "Subscription billing", category: "ecommerce", level: "CAPABLE", interest: "POSITIVE", importance: "SUPPORTING", related: ["subscriptions","recurring billing"], provenance: "INFERRED" },
  { name: "Website development", category: "technical", level: "CAPABLE", interest: "POSITIVE", importance: "SUPPORTING",
    restrictions: ["Built and improved sites as an operator, not as a software engineer"], provenance: "INFERRED" },
  { name: "Customer support", category: "operations", level: "CAPABLE", interest: "NEUTRAL", importance: "BACKGROUND", provenance: "INFERRED" },
  { name: "Talent sourcing and recruiting", category: "operations", level: "CAPABLE", interest: "NEUTRAL", importance: "BACKGROUND",
    related: ["recruiting","sourcing"],
    restrictions: ["Evidence is finding and recruiting local instructors for Genius Academy"], provenance: "INFERRED" },
  { name: "Branding", category: "creative", level: "CAPABLE", interest: "NEUTRAL", importance: "BACKGROUND", provenance: "INFERRED" },
  { name: "Launching a new offering", category: "product", level: "EXPERIENCED", interest: "POSITIVE", importance: "SUPPORTING",
    related: ["go to market","gtm","product launch"],
    restrictions: ["Owner originated the concept; the user developed the direction for turning it into an offering and implemented it"], provenance: "INFERRED" },

  // Domains, held separately from skills so a domain is never read as a tool.
  { name: "Health science", category: "domain", level: "CAPABLE", interest: "POSITIVE", importance: "SUPPORTING",
    related: ["healthcare","healthtech"],
    restrictions: ["Academic, from the 2025 BS. Not clinical practice and not healthcare industry employment"] , provenance: "STATED" },
  { name: "Property compliance", category: "domain", level: "CAPABLE", interest: "POSITIVE", importance: "SUPPORTING", related: ["proptech","rental compliance"] , provenance: "INFERRED" },
  { name: "Automotive media", category: "domain", level: "CAPABLE", interest: "NEUTRAL", importance: "BACKGROUND" , provenance: "INFERRED" },
  { name: "Education", category: "domain", level: "CAPABLE", interest: "NEUTRAL", importance: "BACKGROUND" , provenance: "INFERRED" },
];

/**
 * Cross-functional strengths recorded as work preferences rather than
 * skills.
 *
 * "Rapid learning" and "problem solving" are traits. Filed as skills they
 * would inflate the skill count and match nothing, which is the same
 * mistake the job side made before the TRAIT fix. Preferences is where
 * they actually do work: they describe what the user wants a role to be.
 */
export const WORK_PREFERENCES = [
  { kind: "WANT", statement: "Roles where the path from problem to solution is not already defined", weight: 10 },
  { kind: "WANT", statement: "Cross-functional and multidisciplinary work where breadth is an advantage", weight: 10 },
  { kind: "WANT", statement: "Product operations, business operations, growth operations", weight: 9 },
  { kind: "WANT", statement: "Implementation, special projects, innovation roles", weight: 9 },
  { kind: "WANT", statement: "Product marketing and digital product roles", weight: 8 },
  { kind: "WANT", statement: "AI-enabled operations and AI-assisted product work", weight: 9 },
  { kind: "WANT", statement: "Startup and generalist roles", weight: 8 },
  { kind: "WANT", statement: "Healthcare, healthtech, medical technology and healthcare operations, without limiting the search to them", weight: 6 },
  { kind: "AVOID", statement: "Roles where video production is the primary discipline", weight: 8 },
  { kind: "AVOID", statement: "Deep single-specialty roles that do not use breadth", weight: 6 },
];

export const LOCATION_PREFERENCES = [
  // CONFIRMED by the user on 30 Aug 2026.
  { label: "Chicagoland", stance: "PREFERRED", metro: "Chicagoland", state: "IL", country: "US",
    applies_to_remote: false, max_onsite_days_per_week: 5,
    notes: "Onsite, hybrid and remote all acceptable. Treat Greater Chicagoland as the whole target metro: no neighborhood and no commute radius yet." },
  { label: "Fully remote, United States", stance: "PREFERRED", country: "US",
    applies_to_remote: true,
    notes: "Include regardless of where the company is headquartered, provided the role can be worked remotely while living in Chicagoland." },
  { label: "Onsite or hybrid outside Chicagoland", stance: "EXCLUDE", country: "US",
    applies_to_remote: false,
    notes: "Excluded with no exceptions. Cleveland and northeast Ohio get no special treatment: the user is relocating to Chicagoland within roughly two months and is not looking for a Cleveland-based job." },
];

/**
 * Evidence of ABSENCE and of PREFERENCE, which are different things and
 * neither is a gap.
 *
 * VERIFIED_ABSENCE is a real mismatch. PREFERENCE_AGAINST is capability
 * without appetite: it must reduce Opportunity without touching Fit, so
 * that skill still helps the user get hired elsewhere.
 */
export const POLARITY_EVIDENCE = [
  { polarity: "PREFERENCE_AGAINST", summary: "Does not want video production to be the primary discipline of the next role",
    detail: "Stated directly: the volume of video evidence reflects years worked in the field, not desired direction. Capability is real; appetite is not." },
  { polarity: "PREFERENCE_AGAINST", summary: "Does not want to be positioned as a deep specialist",
    detail: "Self-describes as a cross-functional generalist rather than a deep specialist in every field listed. Breadth must not be translated into unsupported expertise." },

  // CORRECTED. This was a broad VERIFIED_ABSENCE saying "not a
  // professional software engineer". That was wrong twice over: it
  // recorded an absence the user never asserted about himself in general,
  // and a blanket absence would suppress real, verifiable technical
  // capability. The intended meaning is a CEILING on what one body of
  // evidence may be stretched to support, so it is stored as positive
  // evidence with the ceiling attached rather than as a missing skill.
  { polarity: "POSITIVE",
    summary: "RentPup supports AI-assisted product building, third-party integration, technical problem solving, and systems thinking",
    detail: "SCOPE GUARDRAIL: this evidence may support AI-assisted product building, integrations, technical problem solving, systems thinking, and the specific tools and capabilities the user verifies individually. It must NOT be inflated into professional software-engineering or expert-programming experience. The guardrail limits how far this evidence reaches; it is not a claim that the user lacks technical ability." },

  // CORRECTED. Narrowed from "did not set overall marketing direction",
  // which read as an absence of marketing-strategy capability in general.
  // The verified fact is specific to one company and one scope.
  // Two scope guardrails on the Genius Academy figure. Stored as POSITIVE
  // evidence with the ceiling attached, the same pattern as the RentPup
  // guardrail: a limit on how far a claim may reach is not a missing
  // skill, and modelling it as an absence would suppress a real
  // accomplishment.
  { polarity: "POSITIVE",
    summary: "Played a substantial hands-on role in building and operating Genius Academy",
    detail: "SCOPE GUARDRAIL: $70,000+ is the OFFERING's total annual recurring revenue. Wording must never imply the user personally generated $70,000 in revenue, and must never imply he independently owned the overall business strategy. The claim is contribution to building and operating, not authorship of the outcome." },

  { polarity: "VERIFIED_ABSENCE",
    summary: "Did not own Genius One's overall company marketing strategy",
    detail: "The owner established overall priorities and delegated objectives; the role was execution-oriented in determining how to accomplish them. SCOPE: this is a fact about ownership of company-level marketing strategy at Genius One only. It is NOT evidence that the user lacks marketing-strategy capability or experience generally, and must never be used to score down a marketing-strategy requirement." },
];

/**
 * Where a proposed interest or importance actually came from.
 *
 *   STATED    the user said it, or said something that maps to it directly
 *   INFERRED  I read it off the evidence
 *
 * The user's instruction: do not infer that a skill is CORE or
 * ACTIVELY_SEEK merely because it is strongly evidenced. Evidence
 * strength says what has been done, not what is wanted next, and those
 * are the two columns this profile keeps separate on purpose.
 *
 * So the rule is enforced in code rather than left to my judgement each
 * time: an INFERRED proposal is capped at POSITIVE interest and
 * SUPPORTING importance. Only a statement from the user can reach
 * ACTIVELY_SEEK or CORE.
 */
export type Provenance = "STATED" | "INFERRED";

export function capInferred<T extends { interest: string; importance: string; provenance?: Provenance }>(s: T): T {
  if ((s.provenance ?? "INFERRED") === "STATED") return s;
  return {
    ...s,
    interest: s.interest === "ACTIVELY_SEEK" ? "POSITIVE" : s.interest,
    importance: s.importance === "CORE" ? "SUPPORTING" : s.importance,
  };
}
