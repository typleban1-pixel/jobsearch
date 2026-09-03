/**
 * The public homepage, minimal edition.
 *
 * One viewport, no scrolling: the headshot with its offset colour
 * block, the opening line, one sentence about the move to Chicago, and
 * LinkedIn. The full curiosity page lives on as the test-site preview
 * (and in _site/FullStory.tsx) until it is deliberately promoted.
 */
import type { Metadata } from "next";
import Image from "next/image";

import { fontVariables } from "./_site/fonts.ts";
import { ArrowNE } from "./_site/Marks.tsx";
import s from "./_site/site.module.css";

import headshot from "../public/photos/ty-headshot.jpg";

const LINKEDIN = "https://www.linkedin.com/in/tylerpleban";

const origin = process.env["VERCEL_PROJECT_PRODUCTION_URL"]
  ? `https://${process.env["VERCEL_PROJECT_PRODUCTION_URL"]}`
  : "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(origin),
  title: "Ty Pleban",
  description: "I like figuring things out. Currently relocating to Chicago.",
  openGraph: {
    title: "Ty Pleban",
    description: "I like figuring things out.",
    images: ["/photos/ty-headshot.jpg"],
    type: "profile",
  },
};

const ACCENT = "#e85d2a";

export default function Home() {
  return (
    <main className={`${s.root} ${fontVariables} ${s.oneScreen}`} style={{ ["--accent" as string]: ACCENT }}>
      <div className={s.oneScreenInner}>
        <div className={s.oneScreenText}>
          <h1 className={s.display}>
            Hi, I&rsquo;m Ty.<br />I like figuring things out.
          </h1>
          <p className={s.lead}>
            I&rsquo;m currently in the process of relocating to Chicago.
          </p>
          <a className={s.bigLink} href={LINKEDIN} target="_blank" rel="noopener noreferrer">
            See me on LinkedIn <ArrowNE size={22} />
          </a>
        </div>

        <div className={s.headshotHolder}>
          <Image
            className={s.headshot}
            src={headshot}
            alt="Ty Pleban, in a black and white portrait, wearing a checked shirt."
            sizes="(max-width: 899px) 60vw, 380px"
            placeholder="blur"
            priority
          />
        </div>
      </div>
    </main>
  );
}
