/**
 * The three faces, self-hosted.
 *
 * next/font downloads these at build time and serves them from this
 * origin, so the page makes no request to Google and there is no font
 * swap flash. They are exposed as CSS variables and applied only on the
 * public homepage's root element; nothing in the portal is touched.
 *
 * latin-ext is not optional. "Śnieżka" needs U+015A and U+017B, which
 * live in Latin Extended-A. Without that subset the two characters fall
 * back to whatever the system has and the word renders in a different
 * typeface mid-heading.
 */
import { Bricolage_Grotesque, Onest, DM_Mono } from "next/font/google";

export const display = Bricolage_Grotesque({
  subsets: ["latin", "latin-ext"],
  display: "swap",
  variable: "--font-display",
});

export const body = Onest({
  subsets: ["latin", "latin-ext"],
  display: "swap",
  variable: "--font-body",
});

export const mono = DM_Mono({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--font-mono",
});

export const fontVariables = `${display.variable} ${body.variable} ${mono.variable}`;
