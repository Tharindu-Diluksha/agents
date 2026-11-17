import { afterAll, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";

const tmp = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  return fs.mkdtempSync(path.join(os.tmpdir(), "orch-attach-routes-"));
});

vi.mock("../src/config.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/config.js")>();
  return {
    ...orig,
    paths: { ...orig.paths, repoRoot: tmp, runsDir: join(tmp, "runs"), sessionsDir: join(tmp, "sessions"), worktreesDir: join(tmp, "worktrees") },
  };
});
// No model calls: the routes module imports the workflow, which imports the SDK wrapper.
vi.mock("../src/sdk/runRole.js", async (importOriginal) => ({
  RoleRunError: (await importOriginal<typeof import("../src/sdk/runRole.js")>()).RoleRunError,
  runRoleAgent: vi.fn(),
}));

const { registerRunsRoutes } = await import("../src/routes/runs.js");
const { createRun, loadRun } = await import("../src/orchestrator/runStore.js");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("attachment routes", async () => {
  const app = Fastify();
  await registerRunsRoutes(app);

  createRun({
    runId: "R-1",
    label: "R-1",
    source: { kind: "manual", type: "feature", title: "t", description: "d", acceptanceCriteria: [] },
    repos: [{ path: join(tmp, "app"), baseBranch: "main", aiGuidelinePath: null }],
  });

  it("accepts images larger than Fastify's default 1 MB body and serves them back", async () => {
    // ~3 MB image → ~4 MB of base64 JSON.
    const big = Buffer.concat([PNG_HEADER, Buffer.alloc(3 * 1024 * 1024)]);
    const res = await app.inject({
      method: "POST",
      url: "/api/runs/R-1/attachments",
      payload: { note: "see mockup", images: [{ name: "mock.png", mediaType: "image/png", data: big.toString("base64") }] },
    });
    expect(res.statusCode).toBe(200);
    const file = loadRun("R-1")!.attachments!.find((a) => a.kind === "image")!.file!;

    const img = await app.inject({ method: "GET", url: `/api/runs/R-1/attachments/${file}` });
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toBe("image/png");
    expect(img.rawPayload.equals(big)).toBe(true);

    const nope = await app.inject({ method: "GET", url: `/api/runs/R-1/attachments/..%2Frun.json` });
    expect(nope.statusCode).toBe(404);
  });

  it("rejects invalid images with a readable error", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/runs/R-1/attachments",
      payload: { images: [{ name: "x.png", mediaType: "image/png", data: Buffer.from("nope").toString("base64") }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toMatch(/not a valid PNG/);
  });
});
