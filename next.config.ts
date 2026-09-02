import type { NextConfig } from "next";

const config: NextConfig = {
  // The lib/ modules are shared with the worker scripts, which run under
  // plain node and therefore import with explicit .ts extensions. Next
  // has to resolve those the same way or the portal and the worker would
  // need two copies of the scoring code.
  // eslint config in next.config is no longer supported in Next 16.
  typescript: { ignoreBuildErrors: false },

  // The root is the public site. It was a static file served through a
  // rewrite; it is now an ordinary route at app/page.tsx, which is what
  // buys next/image, per-page metadata and components. The portal still
  // lives at /jobs and still stays behind the session gate: proxy.ts
  // already treats "/" as public and needed no change for this.
};

export default config;
