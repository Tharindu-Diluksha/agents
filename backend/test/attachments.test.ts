import { afterAll, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { RunRecord } from "../src/orchestrator/types.js";

const tmp = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  return fs.mkdtempSync(path.join(os.tmpdir(), "orch-attach-"));
});

vi.mock("../src/config.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/config.js")>();
  return { ...orig, paths: { ...orig.paths, repoRoot: tmp, runsDir: join(tmp, "runs") } };
});

const { addAttachments, attachmentFile, attachmentsPromptSection, MAX_IMAGES_PER_REQUEST } = await import(
  "../src/orchestrator/attachments.js"
);
const { headerFor } = await import("../src/roles/common.js");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// A 1×1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function record(runId: string): RunRecord {
  return {
    runId,
    label: runId,
    source: { kind: "manual", type: "feature", title: "t", description: "d", acceptanceCriteria: [] },
    repos: [{ path: join(tmp, "app"), baseBranch: "main", aiGuidelinePath: null }],
    state: "awaiting_feature_doc_approval",
    createdAt: "",
    updatedAt: "",
    roles: {},
    stateHistory: [],
    pendingApproval: null,
  };
}

describe("run attachments", () => {
  it("stores a note and images and lists them in every role's prompt header", () => {
    const rec = record("A-1");
    const added = addAttachments(rec, {
      note: "Use the brand blue for the primary button.",
      images: [{ name: "Checkout Mockup.png", mediaType: "image/png", data: `data:image/png;base64,${PNG}`, caption: "new checkout page" }],
    });
    expect(added.map((a) => a.kind)).toEqual(["note", "image"]);
    const image = added[1]!;
    expect(image.file).toMatch(/^checkout-mockup-[\w-]+\.png$/);
    expect(image.stage).toBe("awaiting_feature_doc_approval");

    const stored = attachmentFile(rec, image.file!)!;
    expect(existsSync(stored.path)).toBe(true);
    expect(readFileSync(stored.path).equals(Buffer.from(PNG, "base64"))).toBe(true);
    expect(stored.mediaType).toBe("image/png");

    const header = headerFor(rec, "Developer");
    expect(header).toContain("## User-supplied context and mockups");
    expect(header).toContain("Use the brand blue for the primary button.");
    expect(header).toContain(`/runs/A-1/attachments/${image.file}\` (Checkout Mockup.png) — new checkout page`);
    expect(header).toContain("**Read** tool");
  });

  it("rejects bad input without storing anything", () => {
    const rec = record("A-2");
    expect(() => addAttachments(rec, {})).toThrow(/note or at least one image/);
    // Good image + one that is not really a PNG: all or nothing.
    expect(() =>
      addAttachments(rec, {
        images: [
          { name: "ok.png", mediaType: "image/png", data: PNG },
          { name: "evil.png", mediaType: "image/png", data: Buffer.from("<script>").toString("base64") },
        ],
      }),
    ).toThrow(/evil.png: not a valid PNG/);
    expect(() => addAttachments(rec, { images: [{ name: "a.svg", mediaType: "image/svg+xml", data: PNG }] })).toThrow(/unsupported type/);
    const many = Array.from({ length: MAX_IMAGES_PER_REQUEST + 1 }, (_, i) => ({ name: `${i}.png`, mediaType: "image/png", data: PNG }));
    expect(() => addAttachments(rec, { images: many })).toThrow(/at most/);
    expect(rec.attachments).toBeUndefined();
    expect(existsSync(join(tmp, "runs", "A-2", "attachments"))).toBe(false);
    expect(attachmentsPromptSection(rec)).toBe("");
  });

  it("serves only files recorded for the run", () => {
    const rec = record("A-3");
    addAttachments(rec, { images: [{ name: "x.png", mediaType: "image/png", data: PNG }] });
    expect(attachmentFile(rec, "../run.json")).toBeNull();
    expect(attachmentFile(rec, "other.png")).toBeNull();
  });
});
