/**
 * Seed capability graph.
 *
 * Every row is an argument, not a similarity score. DIRECT means the
 * verified evidence IS the thing asked for under another name.
 * TRANSFERABLE means adjacent evidence partially supports it and earns
 * partial credit, never full.
 *
 * Written conservatively on purpose. A wrong TRANSFERABLE row inflates a
 * profile silently, which is the failure mode this whole system exists to
 * avoid, so anything genuinely doubtful is left out and shows up as
 * ABSENT instead.
 *
 * Only VERIFIED skills appear on the right-hand side. Relations pointing
 * at proposals would resolve to UNKNOWN anyway.
 */
export interface CapabilityRelation {
  requirement_concept: string;
  satisfied_by_skill: string;
  relation: "DIRECT" | "TRANSFERABLE";
  rationale: string;
}

export const CAPABILITY_RELATIONS: CapabilityRelation[] = [
  // --- email and lifecycle ---
  { requirement_concept: "email marketing platform", satisfied_by_skill: "Omnisend", relation: "DIRECT", rationale: "Omnisend is an email marketing platform; he ran it for an audience of about 100,000" },
  { requirement_concept: "esp", satisfied_by_skill: "Omnisend", relation: "DIRECT", rationale: "ESP is the industry abbreviation for email service provider" },
  { requirement_concept: "marketing automation", satisfied_by_skill: "Marketing funnel design", relation: "TRANSFERABLE", rationale: "built and managed automated email funnels, which is the core of marketing automation, but not on a dedicated automation platform" },
  { requirement_concept: "lifecycle marketing", satisfied_by_skill: "Email marketing", relation: "TRANSFERABLE", rationale: "segmented campaigns to different customer groups is lifecycle work; the term itself was never used for his role" },
  { requirement_concept: "crm marketing", satisfied_by_skill: "Email marketing", relation: "TRANSFERABLE", rationale: "adjacent: audience segmentation and campaign execution overlap, but no CRM platform evidence" },
  { requirement_concept: "customer segmentation", satisfied_by_skill: "Audience segmentation", relation: "DIRECT", rationale: "same activity, different noun" },
  { requirement_concept: "list segmentation", satisfied_by_skill: "Audience segmentation", relation: "DIRECT", rationale: "same activity" },
  { requirement_concept: "email campaigns", satisfied_by_skill: "Campaign execution", relation: "DIRECT", rationale: "ran campaigns against segmented lists" },
  { requirement_concept: "email design", satisfied_by_skill: "Email design", relation: "DIRECT", rationale: "designed marketing emails directly" },

  // --- ecommerce ---
  { requirement_concept: "ecommerce platform", satisfied_by_skill: "Shopify", relation: "DIRECT", rationale: "years administering a Shopify store" },
  { requirement_concept: "ecommerce platforms", satisfied_by_skill: "BigCommerce", relation: "DIRECT", rationale: "set up the BigCommerce store from the ground up" },
  { requirement_concept: "online store", satisfied_by_skill: "Ecommerce", relation: "DIRECT", rationale: "operated storefronts on two platforms" },
  { requirement_concept: "shopify", satisfied_by_skill: "Shopify", relation: "DIRECT", rationale: "named platform" },
  { requirement_concept: "bigcommerce", satisfied_by_skill: "BigCommerce", relation: "DIRECT", rationale: "named platform" },
  { requirement_concept: "dtc", satisfied_by_skill: "Ecommerce", relation: "TRANSFERABLE", rationale: "direct-to-consumer operations overlap with running a storefront, though the model may differ" },
  { requirement_concept: "merchandising", satisfied_by_skill: "Ecommerce", relation: "TRANSFERABLE", rationale: "product and page management on a store is adjacent to merchandising, not the same discipline" },
  { requirement_concept: "subscription", satisfied_by_skill: "Subscription billing", relation: "TRANSFERABLE", rationale: "set up subscriptions, but the Vimeo OTT configuration specifics are unestablished" },

  // --- acquisition and growth ---
  { requirement_concept: "demand generation", satisfied_by_skill: "Customer acquisition", relation: "TRANSFERABLE", rationale: "drove acquisition through funnels and campaigns; demand gen usually implies a larger paid apparatus" },
  { requirement_concept: "growth marketing", satisfied_by_skill: "Customer acquisition", relation: "TRANSFERABLE", rationale: "acquisition plus funnel and conversion work is the substance of growth marketing" },
  { requirement_concept: "digital marketing", satisfied_by_skill: "SEO", relation: "TRANSFERABLE", rationale: "SEO, email and advertising together are digital marketing; no single verified skill covers the whole term" },
  { requirement_concept: "performance marketing", satisfied_by_skill: "Paid advertising", relation: "TRANSFERABLE", rationale: "ran advertising, but performance marketing implies sustained paid optimisation" },
  { requirement_concept: "paid media", satisfied_by_skill: "Paid advertising", relation: "DIRECT", rationale: "same activity" },
  { requirement_concept: "search engine optimization", satisfied_by_skill: "SEO", relation: "DIRECT", rationale: "same term expanded" },
  { requirement_concept: "technical seo", satisfied_by_skill: "SEO", relation: "TRANSFERABLE", rationale: "ran SEO; the technical subdiscipline is not separately evidenced" },
  { requirement_concept: "conversion rate optimization", satisfied_by_skill: "Conversion testing", relation: "DIRECT", rationale: "improved the website and conversion process over time" },
  { requirement_concept: "a/b testing", satisfied_by_skill: "Conversion testing", relation: "DIRECT", rationale: "conversion testing is A/B testing" },
  { requirement_concept: "landing pages", satisfied_by_skill: "Website development", relation: "TRANSFERABLE", rationale: "builds pages in Webflow and built the Genius Academy platform" },
  { requirement_concept: "funnel optimization", satisfied_by_skill: "Marketing funnel design", relation: "DIRECT", rationale: "designed and implemented the funnels" },
  { requirement_concept: "gtm", satisfied_by_skill: "Launching a new offering", relation: "TRANSFERABLE", rationale: "took an offering from concept to market; go-to-market usually implies broader commercial ownership" },
  { requirement_concept: "go to market", satisfied_by_skill: "Launching a new offering", relation: "TRANSFERABLE", rationale: "same reasoning" },
  { requirement_concept: "product launch", satisfied_by_skill: "Launching a new offering", relation: "DIRECT", rationale: "launched Genius Academy" },

  // --- product and operations ---
  { requirement_concept: "project management", satisfied_by_skill: "Project coordination", relation: "TRANSFERABLE", rationale: "coordinated projects and instructors; formal project management ownership is not evidenced" },
  { requirement_concept: "program management", satisfied_by_skill: "Project coordination", relation: "TRANSFERABLE", rationale: "coordinated a multi-party collaboration; programme management usually implies larger formal scope" },
  { requirement_concept: "stakeholder management", satisfied_by_skill: "Cross-department collaboration", relation: "TRANSFERABLE", rationale: "coordinated across departments and external partners" },
  { requirement_concept: "cross functional collaboration", satisfied_by_skill: "Cross-department collaboration", relation: "DIRECT", rationale: "same activity" },
  { requirement_concept: "partnerships", satisfied_by_skill: "External partnership coordination", relation: "TRANSFERABLE", rationale: "coordinated a college-industry partnership; commercial partnerships are a different discipline" },
  { requirement_concept: "vendor management", satisfied_by_skill: "Tool and service evaluation", relation: "TRANSFERABLE", rationale: "researched, selected and integrated third-party services" },
  { requirement_concept: "process improvement", satisfied_by_skill: "Conversion testing", relation: "TRANSFERABLE", rationale: "iteratively improved the website and conversion process" },
  { requirement_concept: "pricing strategy", satisfied_by_skill: "Pricing", relation: "TRANSFERABLE", rationale: "helped determine pricing; contributed rather than owned strategy" },
  { requirement_concept: "pricing analysis", satisfied_by_skill: "Pricing", relation: "TRANSFERABLE", rationale: "same reasoning" },
  { requirement_concept: "product ideation", satisfied_by_skill: "Product ideation", relation: "DIRECT", rationale: "developed original product and course ideas" },
  { requirement_concept: "product development", satisfied_by_skill: "Product ideation", relation: "TRANSFERABLE", rationale: "contributed to development; not ownership of a product function" },
  { requirement_concept: "customer support", satisfied_by_skill: "Customer support", relation: "DIRECT", rationale: "handled customer support for Genius Academy" },
  { requirement_concept: "customer success", satisfied_by_skill: "Customer support", relation: "TRANSFERABLE", rationale: "support experience is adjacent to success, which is a retention discipline" },
  { requirement_concept: "recruiting", satisfied_by_skill: "Talent sourcing and recruiting", relation: "TRANSFERABLE", rationale: "found and recruited instructors; not a recruiting function" },
  { requirement_concept: "mentoring", satisfied_by_skill: "Teaching and mentoring", relation: "DIRECT", rationale: "taught and mentored 250+ students over three years" },
  { requirement_concept: "coaching", satisfied_by_skill: "Teaching and mentoring", relation: "TRANSFERABLE", rationale: "teaching and mentoring overlaps with coaching without being identical" },
  { requirement_concept: "training", satisfied_by_skill: "Teaching and mentoring", relation: "TRANSFERABLE", rationale: "instructional experience in a lab environment" },
  { requirement_concept: "people management", satisfied_by_skill: "Staff supervision", relation: "TRANSFERABLE", rationale: "supervised three student employees day to day; not professional-staff management" },

  // --- web and content ---
  { requirement_concept: "cms", satisfied_by_skill: "Webflow", relation: "TRANSFERABLE", rationale: "uses the Webflow CMS; other CMS platforms are not evidenced" },
  { requirement_concept: "content management system", satisfied_by_skill: "Webflow", relation: "TRANSFERABLE", rationale: "same reasoning" },
  { requirement_concept: "webflow", satisfied_by_skill: "Webflow", relation: "DIRECT", rationale: "named platform" },
  { requirement_concept: "web design", satisfied_by_skill: "Website development", relation: "TRANSFERABLE", rationale: "builds and customises sites; visual design of sites is adjacent" },
  { requirement_concept: "content production", satisfied_by_skill: "Video production", relation: "TRANSFERABLE", rationale: "produced video and content at scale, though content marketing is a distinct discipline" },
  { requirement_concept: "video editing", satisfied_by_skill: "Video editing", relation: "DIRECT", rationale: "years of paid editing work" },
  { requirement_concept: "motion graphics", satisfied_by_skill: "Motion graphics", relation: "DIRECT", rationale: "years of paid motion graphics work" },
  { requirement_concept: "graphic design", satisfied_by_skill: "Graphic design", relation: "DIRECT", rationale: "years of paid design work" },
  { requirement_concept: "videography", satisfied_by_skill: "Video production", relation: "DIRECT", rationale: "same discipline" },
  { requirement_concept: "brand", satisfied_by_skill: "Branding", relation: "TRANSFERABLE", rationale: "produced graphics and branding for an offering" },
];
