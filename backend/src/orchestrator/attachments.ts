import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { nanoid } from "nanoid";
import { runDir } from "./artifacts.js";
import type { RunAttachment, RunRecord } from "./types.js";

/*
 * User-supplied context for a run: free-text notes and images (mockups,
 * screenshots) that aren't in the ticket. Images are stored under
 * runs/<runId>/attachments/ and listed in every role's prompt with their
 * absolute path; roles view them with the Read tool, which renders images.
 */

/** Image types the Read tool can show the model. */
export const IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES_PER_REQUEST = 10;
export const MAX_IMAGES_PER_RUN = 30;
export const MAX_NOTE_CHARS = 20_000;

export interface ImageUpload {
  name: string;
  mediaType: string;
  /** Base64 file content (a `data:` URL prefix is accepted and stripped). */
  data: string;
  caption?: string;
}

export interface ContextInput {
  note?: string;
  images?: ImageUpload[];
}

export function attachmentsDir(runId: string): string {
  return join(runDir(runId), "attachments");
}

/** Absolute path of a stored image, or null for anything that isn't one of this run's images. */
export function attachmentFile(record: RunRecord, file: string): { path: string; mediaType: string } | null {
  const entry = record.attachments?.find((a) => a.kind === "image" && a.file === file);
  if (!entry?.file || basename(entry.file) !== entry.file) return null;
  const path = join(attachmentsDir(record.runId), entry.file);
  return existsSync(path) ? { path, mediaType: entry.mediaType ?? "application/octet-stream" } : null;
}

/** Checks the first bytes, so a renamed non-image can't be stored as one. */
function looksLike(mediaType: string, buf: Buffer): boolean {
  switch (mediaType) {
    case "image/png":
      return buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/jpeg":
      return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case "image/gif":
      return buf.subarray(0, 4).toString("ascii") === "GIF8";
    case "image/webp":
      return buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP";
    default:
      return false;
  }
}

function slug(name: string): string {
  const stem = name.replace(/\.[^.]*$/, "");
  return stem.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "image";
}

/**
 * Validates a note + images without storing anything (the launch route calls
 * it before creating the run). Throws with a user-facing message.
 */
export function checkContext(input: ContextInput, existingImages = 0) {
  const note = input.note?.trim() ?? "";
  const images = input.images ?? [];
  if (!note && images.length === 0) throw new Error("add a note or at least one image");
  if (note.length > MAX_NOTE_CHARS) throw new Error(`the note is longer than ${MAX_NOTE_CHARS} characters`);
  if (images.length > MAX_IMAGES_PER_REQUEST) throw new Error(`at most ${MAX_IMAGES_PER_REQUEST} images at a time`);
  if (existingImages + images.length > MAX_IMAGES_PER_RUN) throw new Error(`a run can hold at most ${MAX_IMAGES_PER_RUN} images`);

  const decoded = images.map((img) => {
    const ext = IMAGE_TYPES[img.mediaType];
    if (!ext) throw new Error(`${img.name}: unsupported type ${img.mediaType} (use PNG, JPEG, GIF or WebP)`);
    const buf = Buffer.from(img.data.replace(/^data:[^,]*,/, ""), "base64");
    if (buf.length === 0) throw new Error(`${img.name}: empty file`);
    if (buf.length > MAX_IMAGE_BYTES) throw new Error(`${img.name}: larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
    if (!looksLike(img.mediaType, buf)) throw new Error(`${img.name}: not a valid ${ext.toUpperCase()} image`);
    return { img, ext, buf };
  });
  return { note, decoded };
}

/** Validates (all or nothing), writes the images and records the entries on the run. */
export function addAttachments(record: RunRecord, input: ContextInput): RunAttachment[] {
  const { note, decoded } = checkContext(input, (record.attachments ?? []).filter((a) => a.kind === "image").length);
  const now = new Date().toISOString();
  const added: RunAttachment[] = [];
  if (note) added.push({ id: nanoid(8), kind: "note", addedAt: now, stage: record.state, text: note });
  if (decoded.length > 0) mkdirSync(attachmentsDir(record.runId), { recursive: true });
  for (const { img, ext, buf } of decoded) {
    const id = nanoid(8);
    const file = `${slug(img.name)}-${id}.${ext}`;
    writeFileSync(join(attachmentsDir(record.runId), file), buf);
    added.push({
      id,
      kind: "image",
      addedAt: now,
      stage: record.state,
      file,
      originalName: img.name.slice(0, 200),
      mediaType: img.mediaType,
      text: img.caption?.trim() ? img.caption.trim().slice(0, 500) : undefined,
    });
  }
  record.attachments = [...(record.attachments ?? []), ...added];
  return added;
}

/** Prompt section listing the user's notes and images; empty when there are none. */
export function attachmentsPromptSection(record: RunRecord): string {
  const list = record.attachments ?? [];
  if (list.length === 0) return "";
  const dir = attachmentsDir(record.runId).split("\\").join("/");
  const lines = [
    "",
    "## User-supplied context and mockups",
    "",
    "The user added the material below to this run, on top of the ticket / description. Treat it as part of the requirements: where it conflicts with the ticket, say so in your report rather than silently picking one.",
  ];
  const notes = list.filter((a) => a.kind === "note");
  for (const n of notes) {
    lines.push("", `### Note (added ${n.addedAt.slice(0, 16).replace("T", " ")})`, "", n.text ?? "");
  }
  const images = list.filter((a) => a.kind === "image");
  if (images.length > 0) {
    lines.push(
      "",
      "### Images",
      "",
      "Open each image with the **Read** tool (it shows you the image) before relying on it. Refer to images by file name in your artifacts.",
      "",
      ...images.map((i) => `- \`${dir}/${i.file}\`${i.originalName ? ` (${i.originalName})` : ""}${i.text ? ` — ${i.text}` : ""}`),
    );
  }
  return lines.join("\n");
}
