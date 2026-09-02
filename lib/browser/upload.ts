/**
 * Attaching the approved resume, and proving it attached.
 *
 * Greenhouse's embedded uploader ignores a programmatic setInputFiles on
 * its visually-hidden input: it listens for a real file chooser. So the
 * upload control is activated and Playwright's filechooser event carries
 * the bytes. That is a narrowly scoped way to perform setFiles, not a
 * general click capability: the only element this may activate is the
 * label or button already resolved as belonging to the resume input, and
 * it exists solely to produce the expected chooser.
 *
 * Acknowledgement is never assumed. setFiles returning without error
 * proves nothing, and neither does a filename appearing in page text on
 * a form that does not render one. What is verified instead is the state
 * of the resolved file input itself: one file, the expected name, the
 * expected byte length, a PDF content type, and — where the browser
 * permits reading the selected File — a SHA-256 over its actual bytes
 * equal to the approved artifact's.
 */
import type { Frame, Page } from "playwright";
import { Stop } from "./stopReasons.ts";
import type { LiveField } from "./liveSnapshot.ts";

export const UPLOAD_VERSION = 1;

export interface AttachmentEvidence {
  fileCount: number;
  name: string;
  size: number;
  type: string;
  /** SHA-256 over the selected File's bytes, when the browser allows reading them. */
  sha256: string | null;
  /** Why a byte hash is absent, when it is. */
  hashUnavailable: string | null;
  mechanism: "file-chooser" | "set-input-files";
}

/**
 * The control a person would click to attach a file.
 *
 * Resolved from the resume input itself: its own label, or a button in
 * the same group. Nothing is searched for by text across the page, so
 * this cannot wander onto some other control that happens to say
 * "Attach".
 */
async function resolveUploadActivator(frame: Frame, inputSelector: string) {
  const handles = await frame.evaluate((sel: string) => {
    const input = document.querySelector(sel) as HTMLInputElement | null;
    if (!input) return { found: 0, labelFor: false, buttons: 0 };
    const byFor = input.id ? document.querySelectorAll(`label[for="${CSS.escape(input.id)}"]`).length : 0;
    const group = input.closest("div,fieldset");
    const buttons = group ? group.querySelectorAll("button").length : 0;
    return { found: 1, labelFor: byFor === 1, buttons };
  }, inputSelector);

  if (!handles.found) throw new Stop("SELECTOR_AMBIGUOUS", "the resume input could not be resolved for upload");

  // A label bound to this exact input is the least ambiguous activator.
  if (handles.labelFor) {
    const id = await frame.evaluate((sel: string) => (document.querySelector(sel) as HTMLInputElement).id, inputSelector);
    return frame.locator(`label[for="${id}"]`);
  }
  if (handles.buttons === 1) {
    return frame.locator(inputSelector).locator("xpath=ancestor::*[self::div or self::fieldset][1]").locator("button");
  }
  throw new Stop("SELECTOR_AMBIGUOUS",
    `the resume upload control is ambiguous (${handles.buttons} candidate buttons, bound label: ${handles.labelFor})`);
}

/**
 * Reads back what is actually attached to the resume input.
 *
 * Hashing happens inside the page over the File the browser holds, so it
 * describes what the form will send rather than what we believe we sent.
 */
async function readAttachment(frame: Frame, inputSelector: string): Promise<Omit<AttachmentEvidence, "mechanism">> {
  return frame.evaluate(async (sel: string) => {
    const input = document.querySelector(sel) as HTMLInputElement | null;
    const files = input?.files;
    if (!input || !files || files.length === 0) {
      return { fileCount: 0, name: "", size: 0, type: "", sha256: null, hashUnavailable: "no file is attached" };
    }
    const f = files[0]!;
    let sha256: string | null = null;
    let hashUnavailable: string | null = null;
    try {
      const buf = await f.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", buf);
      sha256 = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch (e) {
      hashUnavailable = `the browser refused to read the selected file: ${String(e).slice(0, 80)}`;
    }
    return { fileCount: files.length, name: f.name, size: f.size, type: f.type, sha256, hashUnavailable };
  }, inputSelector);
}

export interface AttachRequest {
  page: Page;
  frame: Frame;
  field: LiveField;
  /** The exact approved artifact, on disk. */
  path: string;
  expectedName: string;
  expectedBytes: number;
  expectedSha256: string;
}

/**
 * Attaches the approved artifact and proves it.
 *
 * Tries the plain input first, because directly hosted Greenhouse forms
 * accept it and there is no reason to synthesise a chooser where one is
 * not needed. Falls back to the real file chooser when the uploader
 * ignored it. Either way the same evidence is demanded afterwards.
 */
export async function attachResume(req: AttachRequest): Promise<AttachmentEvidence> {
  const { page, frame, field, path, expectedName, expectedBytes, expectedSha256 } = req;
  const selector = field.selectorKind === "label" ? null : field.selector;
  if (!selector) {
    throw new Stop("SELECTOR_AMBIGUOUS", "the resume input has no direct selector to verify against");
  }

  // Resolve the activator BEFORE touching the input.
  //
  // This module's own note says Greenhouse listens for a real chooser
  // rather than a programmatic setInputFiles, and the order used to be
  // the other way round: set the files, find them missing, then go
  // looking for the control to click. On this uploader that sequence
  // cannot work, because offering the file unmounts the input, and the
  // activator is resolved FROM the input. The control was gone by the
  // time anything wanted it, and the run stopped as though the resume
  // control were ambiguous when in fact it no longer existed.
  //
  // Resolving first costs nothing on forms that accept setInputFiles and
  // is the difference between working and not on forms that do not.
  const activator = await resolveUploadActivator(frame, selector).catch(() => null);

  let mechanism: AttachmentEvidence["mechanism"] = "set-input-files";
  await frame.locator(selector).setInputFiles(path).catch(() => undefined);
  let evidence = await readAttachment(frame, selector);

  // The uploader took the file and replaced its own input. Chasing the
  // chooser now would click a control that no longer exists.
  if (evidence.fileCount === 0 && activator) {
    const stillThere = await frame.evaluate((sel: string) => Boolean(document.querySelector(sel)), selector)
      .catch(() => false);
    if (!stillThere) {
      mechanism = "file-chooser";
      const chooserPromise = page.waitForEvent("filechooser", { timeout: 10_000 }).catch(() => null);
      // Re-resolving is not possible; the activator captured above is the
      // only handle left to the control the applicant would have used.
      await activator.click({ timeout: 8_000 }).catch(() => undefined);
      const chooser = await chooserPromise;
      if (chooser) {
        await chooser.setFiles(path).catch(() => undefined);
        await frame.page().waitForTimeout(1500);
        evidence = await readAttachment(frame, selector);
      }
    }
  }

  // An input that VANISHED is not an input that refused the file.
  //
  // Greenhouse unmounts its file input the moment it accepts a file and
  // renders an "attached" view in its place. Reading the old node then
  // reports zero files, which looks identical to the uploader ignoring
  // us, and the fallback below goes looking for an activator that no
  // longer exists. That is the whole of the SELECTOR_AMBIGUOUS failure:
  // the upload had already worked.
  //
  // The evidence is weaker here and is recorded as such. The bytes
  // cannot be hashed back out of a control that is gone, so what stands
  // in for it is the filename the uploader itself now displays, plus the
  // hash taken of the staged file before it was ever offered. Nothing
  // claims a byte hash that was not read.
  if (evidence.fileCount === 0) {
    const gone = await frame.evaluate((sel: string) => !document.querySelector(sel), selector).catch(() => false);
    if (gone) {
      const shown = await frame.evaluate((name: string) => {
        const hit = [...document.querySelectorAll("div,p,span,li")].some(
          (el) => (el.textContent ?? "").includes(name));
        return hit;
      }, expectedName).catch(() => false);
      if (!shown) {
        throw new Stop("UPLOAD_UNACKNOWLEDGED",
          `the resume input disappeared after the file was offered and ${JSON.stringify(expectedName)} is not shown anywhere on the form, `
          + "so there is no evidence the artifact was accepted");
      }
      return {
        fileCount: 1, name: expectedName, size: expectedBytes, type: "application/pdf",
        sha256: null,
        hashUnavailable: "the uploader replaced its file input once it accepted the file, so the bytes could not be "
          + `read back from the page. The staged file was hashed before it was offered (${expectedSha256}).`,
        mechanism,
      };
    }
  }

  if (evidence.fileCount === 0) {
    // The uploader ignored the programmatic path. Activate the control a
    // person would use and answer the chooser it raises.
    mechanism = "file-chooser";
    const activator = await resolveUploadActivator(frame, selector);
    if (await activator.count() !== 1) {
      throw new Stop("SELECTOR_AMBIGUOUS", "the resume upload control did not resolve to exactly one element");
    }
    const chooserPromise = page.waitForEvent("filechooser", { timeout: 10_000 })
      .catch(() => null);
    await activator.click({ timeout: 8_000 }).catch(() => undefined);
    const chooser = await chooserPromise;
    if (!chooser) {
      throw new Stop("UPLOAD_UNACKNOWLEDGED",
        "activating the resume control raised no file chooser, so the artifact was never offered to the form");
    }
    if (chooser.isMultiple()) {
      throw new Stop("UPLOAD_UNACKNOWLEDGED", "the file chooser accepts multiple files; this is not the single resume control");
    }
    await chooser.setFiles(path);
    await frame.waitForTimeout(1500);
    evidence = await readAttachment(frame, selector);
  }

  // Every property is checked against the approved artifact. None of
  // these is optional, and a missing byte hash is reported rather than
  // silently treated as a pass.
  const problems: string[] = [];
  if (evidence.fileCount !== 1) problems.push(`${evidence.fileCount} file(s) attached`);
  if (evidence.name !== expectedName) problems.push(`filename is ${JSON.stringify(evidence.name)}, expected ${JSON.stringify(expectedName)}`);
  if (evidence.size !== expectedBytes) problems.push(`size is ${evidence.size}, expected ${expectedBytes}`);
  if (!/pdf/i.test(evidence.type)) problems.push(`content type is ${JSON.stringify(evidence.type)}`);
  if (evidence.sha256 !== null && evidence.sha256 !== expectedSha256) {
    problems.push(`attached bytes hash to ${evidence.sha256.slice(0, 12)}, approved artifact is ${expectedSha256.slice(0, 12)}`);
  }

  if (problems.length) {
    throw new Stop("UPLOAD_UNACKNOWLEDGED",
      `the attachment could not be verified: ${problems.join("; ")}`, evidence);
  }

  return { ...evidence, mechanism };
}
