/**
 * Per-application portfolio attribution tokens.
 *
 * Generation only. Nothing resolves a token, no endpoint serves one, and
 * no visit is recorded anywhere: the public portfolio is the last phase
 * of this project, and this exists so the schema and the resume renderer
 * do not have to be redesigned when it arrives.
 *
 * The token identifies an APPLICATION and nothing else. It encodes no
 * employer, company, job, application id, recruiter, personal detail or
 * sequence number, because anything encoded is something a reader of two
 * URLs can compare. 160 bits from a CSPRNG, base64url, so the space
 * cannot be walked and two tokens reveal no relationship.
 *
 * What it supports is the claim "someone used the link associated with
 * this application". Not who. A resume is forwarded, parsed by an ATS,
 * opened by a security scanner and read by several people, and the
 * design has to keep that uncertainty rather than pretend to resolve it.
 */
import { randomBytes } from "node:crypto";

export const ATTRIBUTION_VERSION = 1;

/** 160 bits. Long enough that guessing is hopeless, short enough for a tidy URL. */
const TOKEN_BYTES = 20;

export function generateAttributionToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * The shape the database constraint enforces, restated so a caller can
 * check before writing rather than after failing.
 */
export function isWellFormedToken(token: string): boolean {
  return token.length >= 16 && token.length <= 64 && /^[A-Za-z0-9_-]+$/.test(token);
}

/**
 * Where an attributed visit probably came from.
 *
 * Deliberately separate from the token. The token alone identifies the
 * application; this only says which surface the link was on. If a source
 * marker is stripped by a mail gateway, an ATS or a reader, attribution
 * still works and the source is simply unknown, which is the honest
 * answer rather than a guess.
 */
export type AttributionSource = "RESUME_PDF" | "ATS_WEBSITE_FIELD" | "UNKNOWN";
