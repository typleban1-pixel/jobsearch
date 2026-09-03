/**
 * The public homepage.
 *
 * The premise is curiosity, and the page never says so. It opens with a
 * person who likes figuring things out, walks through what following
 * that has produced, and lets the visitor assemble the conclusion
 * themselves. One continuous thought: every beat answers a question the
 * previous beat raised.
 *
 * The thread down the left is the only structural device and is never
 * explained. It changes colour at every subject and does not break.
 *
 * Rules this file is held to, and which the accompanying checks enforce:
 * no em dash anywhere, no label that categorises the breadth, no
 * mention of anything behind the public page, and no figure that is not
 * on the confirmed list.
 */
import type { Metadata } from "next";
import Image from "next/image";

import { fontVariables } from "./_site/fonts.ts";
import { Section } from "./_site/Section.tsx";
import { Figure } from "./_site/Figure.tsx";
import { Reveal } from "./_site/Reveal.tsx";
import { WordStorm } from "./_site/WordStorm.tsx";
import { Paw } from "./_site/Paw.tsx";
import { MadeBy } from "./_site/MadeBy.tsx";
import { Metrics } from "./_site/Metrics.tsx";
import {
  Annotation, ArrowDown, ArrowRight, ArrowUp, ArrowNE, ArrowTo,
  Underline, RouteLine,
} from "./_site/Marks.tsx";
import s from "./_site/site.module.css";

import headshot from "../public/photos/ty-headshot.jpg";
import studio from "../public/photos/studio-photography.jpg";
import productionSet from "../public/photos/production-set.jpg";
import vapePackage from "../public/photos/genius-vape-package.jpg";
import vapeDieline from "../public/photos/genius-vape-dieline.jpg";
import onshape from "../public/photos/onshape-slide-box.jpg";
import printedPart from "../public/photos/printed-slide-box.jpg";
import printer from "../public/photos/elegoo-printer.jpg";
import repair from "../public/photos/printer-repair.jpg";
import bo from "../public/photos/bo.jpg";
import sniezka from "../public/photos/sniezka-summit.jpg";
import rentpupUi from "../public/rentpup/theme-preview-light.png";
import rentpupLogo from "../public/rentpup/rentpup-logo.png";

const LINKEDIN = "https://www.linkedin.com/in/tylerpleban";

const origin = process.env["VERCEL_PROJECT_PRODUCTION_URL"]
  ? `https://${process.env["VERCEL_PROJECT_PRODUCTION_URL"]}`
  : "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(origin),
  title: "Ty Pleban",
  description:
    "I like figuring things out. Usually because I got curious about something I knew nothing about.",
  openGraph: {
    title: "Ty Pleban",
    description: "I like figuring things out.",
    images: ["/photos/ty-headshot.jpg"],
    type: "profile",
  },
};

/* Each beat takes its colour from the photograph in it. */
const C = {
  open: "#e85d2a",
  set: "#e2611f",
  clients: "#7c5fa8",
  print: "#f1553f",
  turn: "#171512",
  cad: "#2e7cc4",
  part: "#e01b22",
  repair: "#1f7a4d",
  teach: "#1f3a5f",
  pup: "#2f6f5e",
  loose: "#e4572e",
  garden: "#3e6b3a",
  poland: "#2a7fc1",
  music: "#7c5fa8",
  bo: "#e0a94f",
  ink: "#171512",
};

export default function Home() {
  return (
    <main className={`${s.root} ${fontVariables}`}>

      {/* ---------------------------------------------------- opening */}
      <Section accent={C.open} size="tight">
        <div className={s.heroTop}>
          <span className={s.metaLine}>CLEVELAND, OH <ArrowTo /> CHICAGO, IL</span>
          <a href={LINKEDIN} target="_blank" rel="noopener noreferrer">LINKEDIN <ArrowNE /></a>
        </div>

        <div className={s.hero}>
          <div>
            <h1 className={`${s.display} ${s.huge}`}>
              Hi, I&rsquo;m Ty.<br />I like figuring things out.
            </h1>
            <p className={s.lead}>
              Usually because I got curious about something I knew nothing about.
            </p>
            <p className={s.scrollCue}>
              SEE WHAT I MEAN <ArrowDown />
            </p>
          </div>

          <div className={s.headshotHolder}>
            <Image
              className={s.headshot}
              src={headshot}
              alt="Ty Pleban, in a black and white portrait, wearing a checked shirt."
              sizes="(max-width: 899px) 70vw, 420px"
              placeholder="blur"
              priority
            />
          </div>
        </div>
      </Section>

      {/* ----------------------------------------------------- the set */}
      <Section accent={C.set}>
        <Reveal>
          <h2 className={`${s.display} ${s.mid}`}>Here&rsquo;s what that looks like.</h2>
          <Figure
            src={productionSet}
            alt="A multi camera interview set: two people talking on a couch, surrounded by lights, monitors and cameras on tripods."
            bleed
            offset={{ color: C.set, side: "right", reach: 18 }}
          />
          <Annotation mark={<ArrowRight />}>
            GENIUS ACADEMY<br />SET, CAMERA, EDIT, PRODUCTION
          </Annotation>
          <p className={s.lead}>
            This is a set I designed for Genius Academy. I also filmed what happened on it,
            edited it, and produced the thing people were watching.
          </p>
          <p className={s.note}>
            An idea became a set, became a course, became something people paid for.
          </p>
          <p className={s.bigNumber}>&gt;$70K ARR</p>
          <p className={s.kicker}>GENIUS ACADEMY AT ITS PEAK</p>
        </Reveal>
      </Section>

      {/* ------------------------------------------------ the audience */}
      <Section accent={C.set}>
        <Reveal>
          <h2 className={`${s.display} ${s.small}`}>
            The course needed people to find it. So I learned that side too.
          </h2>
          <p className={s.bigNumber}>70K <ArrowTo /> 180K</p>
          <p className={s.kicker}>EMAIL AUDIENCE</p>
        </Reveal>
      </Section>

      {/* -------------------------------------------- other productions */}
      <Section accent={C.clients}>
        <Reveal>
          <h2 className={`${s.display} ${s.mid}`}>Other people&rsquo;s productions, too.</h2>
          <Figure
            src={studio}
            alt="Ty at work in a blacked out studio, framing a shot beside a large lit softbox."
            offset={{ color: C.clients, side: "left", reach: 16 }}
            tilt
          />
          <p className={s.note}>
            Contract production work, 2019 to 2025, for clients like Amazon, Cleveland
            Clinic, Ohio State, and Saks Fifth Avenue. Planning, shooting, cutting, and the
            unglamorous parts that make a shoot happen on the day.
          </p>
        </Reveal>
      </Section>

      {/* ------------------------------------------------------ design */}
      <Section accent={C.print}>
        <Reveal>
          <h2 className={`${s.display} ${s.mid}`}>Some of it you could hold.</h2>
          <div className={s.field} style={{ marginTop: "1.8rem" }}>
            <Figure
              src={vapePackage}
              alt="A product and its retail box on a white background: a white device beside a black carton with red graphics."
              offset={{ color: C.print, side: "left", reach: 20 }}
            />
          </div>
          <Figure
            src={vapeDieline}
            alt="The same carton as a flat printing dieline, unfolded, with every panel and fold line laid out."
            tilt
            width="tight"
          />
          <Annotation mark={<ArrowRight />}>THE DIELINE <ArrowTo /> THE SHELF</Annotation>
          <p className={s.note}>I designed the packaging. Flat, it looks like this.</p>
          <p className={s.bigNumber}>&gt;$68K</p>
          <p className={s.kicker}>SALES OF PRODUCTS I DESIGNED AND MADE, OVER ABOUT TWO YEARS</p>
        </Reveal>
      </Section>

      {/* --------------------------------------------- the resume line */}
      <Section accent={C.turn} size="roomy">
        <Reveal>
          <h2 className={`${s.display}`}>
            My r&eacute;sum&eacute; makes more sense if you know this about me.
          </h2>
          <p className={s.lead}>
            When something gets my attention, I don&rsquo;t really let go until I
            understand it.
          </p>
        </Reveal>
      </Section>

      {/* --------------------------------------------------------- cad */}
      <Section accent={C.cad}>
        <Reveal>
          <h2 className={`${s.display} ${s.mid}`}>
            I couldn&rsquo;t find exactly what I wanted.<br />So I modeled it.
          </h2>
          <Figure
            src={onshape}
            alt="A laptop on a garden table showing a CAD program with a sliding box modelled in it."
            offset={{ color: C.cad, side: "above", reach: 16 }}
          />
          <Annotation mark={<ArrowRight />}>
            MODELED IN CAD.<br />FROM SCRATCH, NOT A DOWNLOAD.
          </Annotation>
        </Reveal>
      </Section>

      <Section accent={C.part}>
        <Reveal>
          <h2 className={`${s.display} ${s.mid}`}>And printed it.</h2>
          <Figure
            src={printedPart}
            alt="The finished part, 3D printed in black, photographed on a red background with its lid propped beside it."
            offset={{ color: C.part, side: "below", reach: 18 }}
            width="tight"
          />
          <p className={s.note}>
            Why buy a small plastic thing when you can spend several hours designing one?
          </p>
        </Reveal>
      </Section>

      {/* ------------------------------------------------------- fixed */}
      <Section accent={C.repair}>
        <Reveal>
          <p className={s.note}>
            Owning a printer comes with a bonus subject: what to do when it stops.
          </p>
          <div className={s.stack}>
            <Figure
              src={printer}
              alt="A 3D printer on a sideboard at home, a spool of copper coloured filament mounted on its side."
              bleed
            />
            <Figure
              src={repair}
              alt="The back of an opened 3D printer with its panel off, a hand holding a multimeter probe inside it."
              className={s.stackOver}
              offset={{ color: C.repair, side: "below", reach: 14 }}
            />
          </div>
          <Annotation mark={<ArrowRight />}>AC BOARD, REPLACED</Annotation>
          <h2 className={`${s.display} ${s.mid}`} style={{ marginTop: "2rem" }}>
            When something breaks, &ldquo;it&rsquo;s broken&rdquo; never feels like the end
            of the story.
          </h2>
        </Reveal>
      </Section>

      {/* ---------------------------------------------------- teaching */}
      <Section accent={C.teach}>
        <Reveal>
          <h2 className={`${s.display} ${s.small}`}>
            For a few years, my job was helping other people figure things out.
          </h2>
          <p className={s.note}>
            Teaching video production at a community college. Understanding something is
            one thing. Understanding it well enough to hand it to someone else is a
            different sport.
          </p>
          <p className={s.bigNumber}>250+</p>
          <p className={s.kicker}>STUDENTS TAUGHT AND MENTORED</p>
        </Reveal>
      </Section>

      {/* ------------------------------------------------------ rentpup */}
      <Section accent={C.pup}>
        <Reveal>
          <h2 className={`${s.display} ${s.mid}`}>The deepest rabbit hole so far.</h2>
          <p className={s.lead}>
            I got curious about a real problem: property owners can be out of compliance
            with local rules and not even know it.
          </p>
          <p className={s.note}>
            The more I read, the more complicated it turned out to be. So I kept reading.
            Then I built the thing I wished existed.
          </p>
          <div style={{ margin: "2rem 0 1rem", maxWidth: 220 }}>
            <Image
              src={rentpupLogo}
              alt="The RentPup logo: a dog silhouette beside the word RentPup."
              sizes="220px"
            />
          </div>
          <Figure
            src={rentpupUi}
            alt="RentPup's property report screen, showing a property's compliance items and their current status."
            offset={{ color: C.pup, side: "right", reach: 20 }}
          />
          <p className={s.note}>
            It watches the public records for a property and tells its owner what needs
            attention before it becomes a problem.
          </p>
          <div className={s.field}>
            <div>
              <p className={s.bigNumber}>21</p>
              <p className={s.kicker}>CURRENT USERS</p>
            </div>
            <div>
              <p className={s.bigNumber}>~$1.2K</p>
              <p className={s.kicker}>MONTHLY REVENUE, CURRENT</p>
            </div>
          </div>
          <p className={s.note}>
            Real people pay real money for it every month, which is a strange and excellent
            feeling.
          </p>
        </Reveal>
      </Section>

      {/* ---------------------------------------------------- the turn */}
      <Section accent={C.loose} size="roomy">
        <h2 className={`${s.display} ${s.huge}`}>Anyway, enough work stuff.</h2>
      </Section>

      {/* ------------------------------------------------------- grown */}
      <Section accent={C.garden}>
        <Reveal>
          <h2 className={`${s.display} ${s.mid}`}>I grow things, too.</h2>
          <p className={s.lead}>Houseplants, mainly.</p>
          <p className={s.note}>Mostly successfully.</p>
          {/* A photograph drops in here when there is one worth using. */}
        </Reveal>
      </Section>

      {/* ------------------------------------------------------- found */}
      <Section accent={C.poland}>
        <Reveal>
          <h2 className={`${s.display} ${s.mid}`}>I go places.</h2>
          <p className={s.note}>Preferably somewhere I haven&rsquo;t been before.</p>
          <p className={`${s.display} ${s.mid}`} style={{ marginTop: "2rem" }}>
            Except <span className={s.accent}>Poland</span>.
          </p>

          <Figure
            src={sniezka}
            alt="Ty at the summit of Śnieżka in Karpacz, Poland, giving a thumbs up, with green mountain ridges behind him."
            bleed
            crop="right"
            offset={{ color: C.poland, side: "left", reach: 18 }}
          />
          <Annotation mark={<ArrowRight />}>
            SUMMIT OF ŚNIEŻKA<br />KARPACZ, POLAND
          </Annotation>

          <p className={s.lead}>Apparently I just keep going back.</p>

          <div style={{ marginTop: "1.6rem", color: C.poland }}>
            <RouteLine />
          </div>
          <p className={s.kicker} style={{ marginTop: "0.4rem" }}>
            POLAND<br />
            TRIPS: 4<br />
            CURRENT FAVORITE: <span className={s.accent}>STILL POLAND</span>
          </p>
        </Reveal>
      </Section>

      {/* ------------------------------------------------------- music */}
      <Section accent={C.music}>
        <h2 className={`${s.display} ${s.mid}`}>I listen to everything.</h2>
        <WordStorm />
        <p className={s.note}>My recommendations are doing their best.</p>
        <p className={s.lead}>
          I like finding things I wouldn&rsquo;t have found if I stayed inside what I
          already knew.
        </p>
      </Section>

      {/* ---------------------------------------------------------- Bo */}
      <Section accent={C.bo} size="roomy">
        <h2 className={`${s.display} ${s.small}`} style={{ textAlign: "center" }}>
          Oh. There&rsquo;s one more thing.
        </h2>
      </Section>

      <Section accent={C.bo}>
        <Paw color={C.bo} />
        <Reveal>
          <Figure
            src={bo}
            alt="Bo, a large cream coloured Great Pyrenees, grinning at the camera with his tongue out, a stadium behind him."
            bleed
            offset={{ color: C.bo, side: "below", reach: 16 }}
          />
          <h2 className={`${s.display} ${s.mid}`} style={{ marginTop: "1.8rem" }}>
            I did not make this.<br />This is <span className={s.accent}>Bo</span>.
          </h2>
          <p className={s.kicker} style={{ marginTop: "1.4rem" }}>
            GREAT PYRENEES<br />DOG PARK ENTHUSIAST<br />HEAD OF MORALE
          </p>
          <p className={s.note}>He has contributed very little to my professional development.</p>
          <p className={s.note}>
            Actually, that&rsquo;s not entirely true. He&rsquo;s pretty good at making me
            stop working.
          </p>
        </Reveal>
      </Section>

      {/* --------------------------------------------- one more thing */}
      <Section accent={C.open} size="roomy">
        <Reveal>
          <p className={`${s.display} ${s.small}`}>One more thing.</p>
          <h2 className={`${s.display} ${s.mid}`} style={{ marginTop: "0.6rem" }}>
            You&rsquo;re looking at it.
          </h2>
          <p className={s.annotation} style={{ marginTop: "1.2rem" }}>
            <ArrowUp />
          </p>
          <p className={s.note}>
            I wanted a personal website that felt like me, so I made one.
          </p>
        </Reveal>
      </Section>

      {/* --------------------------------------------------- the thesis */}
      <Section accent={C.ink} size="roomy">
        <Reveal>
          <p className={s.lead}>
            I&rsquo;m pretty comfortable not knowing the answer yet.
          </p>
        </Reveal>
      </Section>

      <Section accent={C.ink} size="roomy">
        <h2 className={`${s.display} ${s.huge}`}>
          The subject changes.<br />The curiosity doesn&rsquo;t.
        </h2>
      </Section>

      {/* ------------------------------------------------------ numbers */}
      <Section accent={C.teach}>
        <Reveal>
          <p className={s.kicker}>SOME OF IT BY THE NUMBERS</p>
          <Metrics />
        </Reveal>
      </Section>

      {/* ------------------------------------------------------- ending */}
      <Section accent={C.open}>
        <Reveal>
          <h2 className={`${s.display} ${s.mid}`}>Anyway, that&rsquo;s me.</h2>
          <p className={s.lead}>Thanks for poking around.</p>
          <p className={s.note}>
            If you want dates, titles, employers, and all the other responsible-adult
            information, that&rsquo;s what LinkedIn is for.
          </p>
          <a className={s.bigLink} href={LINKEDIN} target="_blank" rel="noopener noreferrer">
            See me on LinkedIn <ArrowNE size={22} />
          </a>
          <p style={{ color: C.open, marginTop: "0.4rem" }}><Underline /></p>
        </Reveal>

        <footer className={s.footer}>
          <MadeBy />
          <p className={s.metaLine} style={{ margin: "0.8rem 0 0" }}>
            CLEVELAND, OH <ArrowTo /> CHICAGO, IL
          </p>
        </footer>
      </Section>
    </main>
  );
}
