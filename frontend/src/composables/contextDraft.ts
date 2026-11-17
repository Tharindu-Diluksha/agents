import type { ContextUpload } from "../api.js";
import type { ContextDraft, PendingImage } from "../types.js";

/** Mirrors the backend limits in orchestrator/attachments.ts. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES_PER_REQUEST = 10;

export function emptyDraft(): ContextDraft {
  return { note: "", images: [] };
}

export function hasContent(d: ContextDraft): boolean {
  return d.note.trim().length > 0 || d.images.length > 0;
}

/** Adds image files to the draft; returns a message for any that were refused. */
export function addFiles(d: ContextDraft, files: Iterable<File>): string | null {
  const refused: string[] = [];
  for (const file of files) {
    if (!IMAGE_TYPES.includes(file.type)) refused.push(`${file.name || "pasted file"}: use PNG, JPEG, GIF or WebP`);
    else if (file.size > MAX_IMAGE_BYTES) refused.push(`${file.name}: larger than 5 MB`);
    else if (d.images.length >= MAX_IMAGES_PER_REQUEST) refused.push(`${file.name}: at most ${MAX_IMAGES_PER_REQUEST} images at a time`);
    else d.images.push({ file, url: URL.createObjectURL(file), caption: "" });
  }
  return refused.length > 0 ? refused.join("; ") : null;
}

export function removeImage(d: ContextDraft, idx: number): void {
  const [img] = d.images.splice(idx, 1);
  if (img) URL.revokeObjectURL(img.url);
}

/** Frees the preview URLs; call when the draft is discarded or sent. */
export function releaseDraft(d: ContextDraft): void {
  for (const img of d.images) URL.revokeObjectURL(img.url);
  d.images = [];
  d.note = "";
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error(`could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

export async function toContextUpload(d: ContextDraft): Promise<ContextUpload> {
  const images = await Promise.all(
    d.images.map(async (img: PendingImage, i) => ({
      // Pasted screenshots have a generic name ("image.png"); number them so they're told apart.
      name: img.file.name && img.file.name !== "image.png" ? img.file.name : `pasted-${i + 1}.${img.file.type.split("/")[1] ?? "png"}`,
      mediaType: img.file.type,
      data: await toBase64(img.file),
      caption: img.caption.trim() || undefined,
    })),
  );
  return { note: d.note.trim() || undefined, images: images.length > 0 ? images : undefined };
}
