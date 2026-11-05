import { describe, expect, it, vi } from "vitest";

// The container layout: code in /app, state on a volume in /data.
vi.mock("../src/config.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/config.js")>();
  return {
    ...orig,
    paths: { ...orig.paths, repoRoot: "/app", runsDir: "/data/runs", templatesDir: "/app/templates" },
  };
});

const { artifactPath, artifactRelative, resolveArtifactRef, toRelative } = await import("../src/orchestrator/artifacts.js");
const common = await import("../src/roles/common.js");
const { requestApproval } = await import("../src/orchestrator/approvals.js");

const record = { runId: "R-1" } as Parameters<typeof artifactPath>[0];

describe("artifact paths with RUNS_DIR outside the orchestrator root", () => {
  it("shows runs/… for display and resolves it back under RUNS_DIR", () => {
    expect(toRelative("/data/runs/R-1/developer/adr.md")).toBe("runs/R-1/developer/adr.md");
    expect(artifactRelative(record, "developer", "adr.md")).toBe("runs/R-1/developer/adr.md");
    expect(resolveArtifactRef("runs/R-1/developer/adr.md")).toBe("/data/runs/R-1/developer/adr.md");
    expect(resolveArtifactRef("/data/runs/R-1/developer/adr.md")).toBe("/data/runs/R-1/developer/adr.md");
    expect(resolveArtifactRef("templates/adr.md")).toBe("/app/templates/adr.md");
  });

  it("gives roles absolute artifact and template paths", () => {
    expect(common.artifactRelative(record, "developer", "adr.md")).toBe("/data/runs/R-1/developer/adr.md");
    expect(common.templateRef("adr.md")).toBe("/app/templates/adr.md");
  });

  it("stores approval payloads in display form, whichever form the role used", () => {
    const run = { runId: "R-1", pendingApproval: null } as unknown as Parameters<typeof requestApproval>[0];
    const pending = requestApproval(run, "prCreator", {
      action: "create_pr",
      summary: "x",
      payloadPaths: ["/data/runs/R-1/prCreator/app-pr-description.md", "runs/R-1/prCreator/api-pr-description.md"],
    });
    expect(pending.payloadPaths).toEqual(["runs/R-1/prCreator/app-pr-description.md", "runs/R-1/prCreator/api-pr-description.md"]);
  });
});
