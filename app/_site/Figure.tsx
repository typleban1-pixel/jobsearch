/**
 * A photograph, sized for what the file can actually carry.
 *
 * Every source here is 1390 square. A phone at 390 CSS pixels needs
 * 1170 for a 3x screen, so full bleed is genuinely sharp there and the
 * mobile layout takes it. A wide display would need close to 2900 for
 * the same treatment, which the file cannot give, so on desktop the
 * photograph is capped where it still resolves and the sense of scale
 * comes from the colour field around it instead. Nothing is upscaled.
 *
 * `sizes` is set from the same caps so the browser never downloads a
 * larger candidate than it will draw.
 */
import Image, { type StaticImageData } from "next/image";
import type { ReactNode } from "react";
import s from "./site.module.css";

export type Crop = "center" | "right" | "top";

const objectPosition: Record<Crop, string> = {
  center: "50% 50%",
  // He is in the right third of the summit photograph; a centre crop at
  // phone aspect ratios cuts him out of his own picture.
  right: "72% 50%",
  top: "50% 22%",
};

export function Figure({
  src,
  alt,
  caption,
  width = "capped",
  bleed = false,
  tilt = false,
  priority = false,
  crop = "center",
  className = "",
  children,
}: {
  src: StaticImageData;
  alt: string;
  caption?: ReactNode;
  width?: "capped" | "tight";
  bleed?: boolean;
  tilt?: boolean;
  priority?: boolean;
  crop?: Crop;
  className?: string;
  children?: ReactNode;
}) {
  const cap = width === "tight" ? s.cappedTight : s.capped;
  const sizeAttr = width === "tight"
    ? "(max-width: 719px) 100vw, 560px"
    : "(max-width: 719px) 100vw, 900px";

  return (
    <figure className={`${s.figure} ${cap} ${bleed ? s.bleed : ""} ${tilt ? s.tilt : ""} ${className}`}>
      {/*
        The image gets its own box. Overlaid marks are positioned in
        percentages, and a percentage against the figure is a percentage
        of a wider element than the photograph, which put a circle drawn
        around the couch several inches to the right of the couch.
      */}
      <span className={s.photoBox}>
        <Image
          src={src}
          alt={alt}
          sizes={sizeAttr}
          placeholder="blur"
          priority={priority}
          loading={priority ? undefined : "lazy"}
          style={{ objectPosition: objectPosition[crop] }}
        />
        {children}
      </span>
      {caption ? <figcaption className={s.caption}>{caption}</figcaption> : null}
    </figure>
  );
}
