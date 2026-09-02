/**
 * The public homepage.
 *
 * One continuous story rather than a set of resume sections. It starts
 * with professional creative work, and each beat quietly turns out to be
 * something the reader did not expect. Nothing on the page tells them
 * that; the sequence does it.
 *
 * The thread down the left is the only structural device, and it is
 * never explained: it changes colour at every subject and does not break
 * anywhere.
 *
 * Rules this file is held to, and which the accompanying checks enforce:
 * no em dash anywhere, no label that categorises the breadth, and no
 * claim that is not the reader's to verify or Ty's to make.
 */
import type { Metadata } from "next";
import Image from "next/image";

import { fontVariables } from "./_site/fonts.ts";
import { Section } from "./_site/Section.tsx";
import { Figure } from "./_site/Figure.tsx";
import { Reveal } from "./_site/Reveal.tsx";
import { CadWipe } from "./_site/CadWipe.tsx";
import { WordStorm } from "./_site/WordStorm.tsx";
import { Paw } from "./_site/Paw.tsx";
import { MadeBy } from "./_site/MadeBy.tsx";
import { Metrics } from "./_site/Metrics.tsx";
import {
  Annotation, ArrowDown, ArrowRight, ArrowUp, ArrowNE, ArrowTo,
  Circle, Underline, RouteLine,
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

const LINKEDIN = "https://www.linkedin.com/in/tylerpleban";

/*
 * Absolute URLs for the social card. Vercel supplies the production
 * host; locally there is nothing to resolve against but localhost, and
 * saying so explicitly is better than the framework guessing out loud.
 */
const origin = process.env["VERCEL_PROJECT_PRODUCTION_URL"]
  ? `https://${process.env["VERCEL_PROJECT_PRODUCTION_URL"]}`
  : "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(origin),
  title: "Ty Pleban",
  description:
    "I make things. Sometimes for work, sometimes because I needed one, sometimes because I got curious and it got out of hand.",
  openGraph: {
    title: "Ty Pleban",
    description: "I make things. Sometimes for work, sometimes because I got curious.",
    images: ["/photos/ty-headshot.jpg"],
    type: "profile",
  },
};

/* Each beat takes its colour from the photograph in it. */
const C = {
  open: "#e85d2a",
  video: "#7c5fa8",
  set: "#e2611f",
  print: "#f1553f",
  cad: "#2e7cc4",
  part: "#e01b22",
  printer: "#b5642e",
  repair: "#1f7a4d",
  work: "#1f3a5f",
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
              Hi, I&rsquo;m Ty.<br />I make things.
            </h1>
            <p className={s.lead}>
              Sometimes for work. Sometimes because I needed one. Sometimes because I got
              curious and it got out of hand.
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

      {/* -------------------------------------------------------- made */}
      <Section accent={C.video} label="MADE">
        <Reveal>
          <h2 className={`${s.display} ${s.mid}`}>I made this.</h2>
          <Figure
            src={studio}
            alt="A photographer at work in a blacked out studio, framing a shot beside a large lit softbox."
            tilt
          />
          <Annotation mark={<ArrowRight />}>
            SHOOTS, EDITS, EVENTS, AND THE WORKFLOW BEHIND THEM
          </Annotation>
          <p className={s.note}>
            Video production, photography, and editing, plus the unglamorous part that
            actually makes a shoot happen on the day.
          </p>
        </Reveal>
      </Section>

      <Section accent={C.set}>
        <Reveal>
          <Figure
            src={productionSet}
            alt="A multi camera interview set: two people talking on a couch and chair, surrounded by lights, monitors and cameras on tripods."
            bleed
          >
            {/* Looped around the couch itself, which is the whole joke. */}
            <span className={s.onPhoto} style={{ left: "45%", top: "47%", width: "24%", height: "17%" }}>
              <Circle w={120} h={52} />
              <span className={s.onPhotoLabel}>THE COUCH</span>
            </span>
          </Figure>
          <h2 className={`${s.display} ${s.mid}`} style={{ marginTop: "1.6rem" }}>
            Well. Not the couch.
          </h2>
          <p className={s.note}>
            Elsewhere: a film about a new lab for Cleveland Clinic, through Anytime Picture.
            I planned it, shot it, cut it, and did the motion graphics. Somebody else owned
            the client.
          </p>
        </Reveal>
      </Section>

      {/* ------------------------------------------------------ design */}
      <Section accent={C.print}>
        <Reveal>
          <h2 className={`${s.display} ${s.mid}`}>And things like this.</h2>
          <div className={s.field} style={{ marginTop: "1.8rem" }}>
            <Figure
              src={vapePackage}
              alt="A product and its retail box on a white background: a white device beside a black carton with red graphics."
              className={s.fieldSoft}
            />
          </div>
          <Figure
            src={vapeDieline}
            alt="The same carton as a flat printing dieline, unfolded, with every panel and fold line laid out."
            tilt
          />
          <Annotation mark={<ArrowRight />}>THE FLAT VERSION, WHICH IS THE PART NOBODY SEES</Annotation>
          <p className={s.note}>
            Branding, packaging, graphics, web, campaigns. What I like is turning an idea
            into something people can pick up, or click, or buy.
          </p>
        </Reveal>
      </Section>

      {/* -------------------------------------------------------- turn */}
      <Section accent={C.cad} size="roomy">
        <h2 className={`${s.display}`}>
          But I don&rsquo;t only mean <span className={s.accent}>work things</span>.
        </h2>
      </Section>

      <Section accent={C.cad}>
        <Reveal>
          <h2 className={`${s.display} ${s.mid}`}>I made this too.</h2>
          <CadWipe
            drawing={onshape}
            part={printedPart}
            drawingAlt="A laptop on a garden table showing a CAD program with a sliding box modelled in it."
            partAlt="The finished part, 3D printed in black, photographed on a red background with its lid propped beside it."
            before="slide box design v2_1.stl"
            after="printed. v2."
            figcaption="The part drawn in Onshape, and the same part after printing."
          />
          <p className={s.lead}>
            I wanted something that didn&rsquo;t exist exactly the way I wanted it. So I
            designed it.
          </p>
          <p className={s.note}>
            Bookends. Watering globes. Brackets for things that came with no bracket. Small
            problems, solved slightly too thoroughly.
          </p>
          <p className={s.note}>
            Why buy a small plastic thing when you can spend several hours designing one?
          </p>
        </Reveal>
      </Section>

      {/* ----------------------------------------------------- printer */}
      <Section accent={C.printer}>
        <Reveal>
          <h2 className={`${s.display} ${s.mid}`}>Naturally, I bought a 3D printer.</h2>
          <Figure
            src={printer}
            alt="A 3D printer on a sideboard at home, a spool of copper coloured filament mounted on its side, a plant next to it."
            bleed
          />
          <p className={s.note}>
            Which is how you find out that the printer is also a thing that needs figuring
            out.
          </p>
        </Reveal>
      </Section>

      {/* ------------------------------------------------------- fixed */}
      <Section accent={C.repair} label="FIXED">
        <Reveal>
          {/*
            The photograph comes first and is pulled up into the previous
            section, so it reads as something dropped on top of the tidy
            printer shot. It used to sit after the heading and cover it.
          */}
          <div className={s.stack}>
            <Figure
              src={repair}
              alt="The back of an opened 3D printer with its panel off, a hand holding a multimeter probe inside it, the meter reading on the bench."
              className={s.stackOver}
            />
          </div>
          <h2 className={`${s.display} ${s.mid}`} style={{ marginTop: "2.4rem" }}>
            Then this happened.
          </h2>
          <Annotation mark={<ArrowRight />}>
            CULPRIT:<br />AC BOARD
          </Annotation>
          <p className={s.lead}>
            When something stops working, I have a very difficult time accepting
            &ldquo;it&rsquo;s broken&rdquo; as the end of the story.
          </p>
        </Reveal>
      </Section>

      {/* -------------------------------------------------------- work */}
      <Section accent={C.work} label="WORK">
        <Reveal>
          <h2 className={`${s.display} ${s.mid}`}>That part follows me to work.</h2>
          <p className={s.bigNumber}>87%</p>
          <p className={s.lead}>
            That&rsquo;s how much I reduced claims in a diesel logistics job.
          </p>
          <p className={s.note}>
            Different problem. Same instinct: find out why it keeps happening before you do
            anything else.
          </p>
        </Reveal>
      </Section>

      <Section accent={C.work}>
        <Reveal>
          <h2 className={`${s.display} ${s.small}`}>
            Sometimes the thing I&rsquo;m building isn&rsquo;t physical.
          </h2>
          <p className={s.bigNumber}>$70K+</p>
          <p className={s.note}>
            Genius Academy, at its 2022 peak in annual recurring revenue. I helped build it
            from an idea into something people paid for.
          </p>
        </Reveal>
      </Section>

      {/* ---------------------------------------------------- the turn */}
      <Section accent={C.loose} size="roomy">
        <h2 className={`${s.display} ${s.huge}`}>Anyway, enough work stuff.</h2>
      </Section>

      {/* ------------------------------------------------------- grown */}
      <Section accent={C.garden} label="GROWN">
        <Reveal>
          <h2 className={`${s.display} ${s.mid}`}>I grow things, too.</h2>
          <p className={s.lead}>Houseplants, mainly.</p>
          <p className={s.note}>Mostly successfully.</p>
          {/*
            A photograph drops in here when there is one worth using.
            <Figure src={plants} alt="…" bleed /> is all it takes; the
            section is laid out to take it without being rebuilt.
          */}
        </Reveal>
      </Section>

      {/* ------------------------------------------------------- found */}
      <Section accent={C.poland} label="FOUND">
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

      {/* --------------------------------------------------- the point */}
      <Section accent={C.ink}>
        <Reveal>
          <h2 className={`${s.display} ${s.mid}`}>
            So what does any of this have to do with work?
          </h2>
          <p className={s.lead}>Probably more than you&rsquo;d think.</p>
          <p className={s.note}>
            I like understanding how things work. I like making things that didn&rsquo;t
            exist before. I like finding out why something isn&rsquo;t working and figuring
            out how to make it better.
          </p>
          <p className={s.note}>
            Sometimes that&rsquo;s a 3D printer. Sometimes it&rsquo;s a marketing campaign.
            Sometimes it&rsquo;s a process. Sometimes it&rsquo;s a business.
          </p>
        </Reveal>
      </Section>

      <Section accent={C.ink} size="roomy">
        <h2 className={`${s.display} ${s.huge}`}>
          The subject changes.<br />The curiosity doesn&rsquo;t.
        </h2>
      </Section>

      {/* ------------------------------------------------------ numbers */}
      <Section accent={C.work}>
        <Reveal>
          <p className={s.kicker}>SOME OF IT IN NUMBERS</p>
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
