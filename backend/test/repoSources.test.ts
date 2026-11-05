import { afterAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const tmp = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  return fs.mkdtempSync(path.join(os.tmpdir(), "repo-sources-"));
});
vi.mock("../src/config.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/config.js")>();
  const { join } = await import("node:path");
  return {
    ...orig,
    paths: { ...orig.paths, repoRoot: tmp, runsDir: join(tmp, "runs"), sessionsDir: join(tmp, "sessions"), reposDir: join(tmp, "repos"), worktreesDir: join(tmp, "worktrees") },
    config: { ...orig.config, repoSources: { allowLocalPaths: true, allowedUrlPrefixes: [] } },
  };
});
// Launches below must not start real agent sessions.
vi.mock("../src/sdk/runRole.js", () => ({
  runRoleAgent: vi.fn(async () => ({ output: { status: "awaiting_approval", artifacts: [], approvalRequest: { action: "proceed_to_next", summary: "s", payloadPaths: [] }, handoff: null } })),
}));

const { cloneDirFor, ensureClone, isAllowedRepoUrl, looksLikeUrl, parseRepoUrl, resolveRepoSource, RepoSourceError } = await import("../src/orchestrator/repoSources.js");
const { config } = await import("../src/config.js");

afterAll(async () => {
  const { rmSync } = await import("node:fs");
  rmSync(tmp, { recursive: true, force: true });
});

Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A bare "remote" at <tmp>/remotes/acme/<name>.git with one commit on main. */
function makeRemote(name: string): { url: string; work: string } {
  const bare = join(tmp, "remotes", "acme", `${name}.git`);
  const work = join(tmp, "src", name);
  mkdirSync(bare, { recursive: true });
  mkdirSync(work, { recursive: true });
  git(bare, "init", "-q", "--bare", "-b", "main");
  git(work, "init", "-q", "-b", "main");
  writeFileSync(join(work, "package.json"), JSON.stringify({ name, devDependencies: { typescript: "^5" } }));
  git(work, "add", ".");
  git(work, "commit", "-qm", "init");
  git(work, "remote", "add", "origin", bare);
  git(work, "push", "-q", "origin", "main");
  return { url: `file://${bare}`, work };
}

describe("parseRepoUrl", () => {
  it("understands https, ssh and scp-like URLs", () => {
    expect(parseRepoUrl("https://github.com/acme/web.git")).toMatchObject({ host: "github.com", segments: ["acme", "web"], kind: "https" });
    expect(parseRepoUrl("https://gitlab.example.com/group/sub/api/")).toMatchObject({ host: "gitlab.example.com", segments: ["group", "sub", "api"] });
    expect(parseRepoUrl("git@github.com:acme/web.git")).toMatchObject({ host: "github.com", segments: ["acme", "web"], kind: "ssh" });
    expect(parseRepoUrl("ssh://git@github.com/acme/web.git")).toMatchObject({ host: "github.com", segments: ["acme", "web"], kind: "ssh" });
    expect(looksLikeUrl("/home/me/repo")).toBe(false);
    expect(looksLikeUrl("C:\\work\\repo")).toBe(false);
    expect(looksLikeUrl("git@github.com:acme/web.git")).toBe(true);
  });

  it("refuses credentials in the URL and odd paths", () => {
    expect(() => parseRepoUrl("https://user:token@github.com/acme/web.git")).toThrow(/credentials in the repository URL/);
    expect(() => parseRepoUrl("https://ghp_x@github.com/acme/web.git")).toThrow(RepoSourceError);
    expect(() => parseRepoUrl("https://github.com/")).toThrow(/no repository path/);
    expect(() => parseRepoUrl("https://github.com/acme/we b")).toThrow(/unsupported repository path/);
    // "..": the URL parser normalises it away, so no clone folder can escape REPOS_DIR.
    expect(parseRepoUrl("https://github.com/acme/../etc").segments).toEqual(["etc"]);
    expect(() => parseRepoUrl("ftp://github.com/acme/web")).toThrow(/unsupported URL scheme/);
  });

  it("maps a URL to a stable clone folder", () => {
    expect(cloneDirFor(parseRepoUrl("https://github.com/acme/web.git"))).toBe(join(tmp, "repos", "github.com", "acme", "web"));
    expect(cloneDirFor(parseRepoUrl("git@github.com:acme/web"))).toBe(join(tmp, "repos", "github.com", "acme", "web"));
  });
});

describe("repo policy", () => {
  it("limits URLs to allowed prefixes and treats file:// as a local path", () => {
    const p = parseRepoUrl("https://github.com/acme/web.git");
    expect(isAllowedRepoUrl(p, [], false)).toBe(true);
    expect(isAllowedRepoUrl(p, ["https://github.com/acme/"], false)).toBe(true);
    expect(isAllowedRepoUrl(p, ["https://github.com/other/"], false)).toBe(false);
    const f = parseRepoUrl("file:///srv/repo.git");
    expect(isAllowedRepoUrl(f, [], true)).toBe(true);
    expect(isAllowedRepoUrl(f, [], false)).toBe(false);
  });

  it("rejects local paths when the server only accepts URLs", async () => {
    await expect(resolveRepoSource(tmp, { allowLocalPaths: false, allowedUrlPrefixes: [] })).rejects.toThrow(/only accepts Git URLs/);
    await expect(resolveRepoSource("https://github.com/x/y", { allowLocalPaths: false, allowedUrlPrefixes: ["https://github.com/acme/"] })).rejects.toThrow(/not in the allowed repositories/);
  });
});

describe("ensureClone", () => {
  it("clones once, fetches on later launches, and shares an in-flight clone", async () => {
    const { url, work } = makeRemote("web");
    const parsed = parseRepoUrl(url);
    const [a, b] = await Promise.all([ensureClone(parsed), ensureClone(parsed)]);
    expect(a).toBe(b);
    expect(existsSync(join(a, "package.json"))).toBe(true);

    writeFileSync(join(work, "new.txt"), "x");
    git(work, "add", ".");
    git(work, "commit", "-qm", "second");
    git(work, "push", "-q", "origin", "main");
    await ensureClone(parsed);
    expect(git(a, "log", "--format=%s", "-1", "origin/main")).toBe("second");
  });

  it("fails fast instead of prompting for credentials", async () => {
    const started = Date.now();
    await expect(ensureClone(parseRepoUrl("https://127.0.0.1:1/acme/missing.git"))).rejects.toThrow(/git clone .* failed/);
    expect(Date.now() - started).toBeLessThan(30_000);
  });
});

describe("launching by URL", () => {
  it("clones the repo, detects its stack and records the URL on the run", async () => {
    const { url } = makeRemote("api");
    const { buildApp } = await import("../src/app.js");
    const { NoAuditLog } = await import("../src/auth/audit.js");
    const { app } = await buildApp({
      allowedHosts: [],
      serveFrontend: false,
      auth: { mode: "none", audit: new NoAuditLog(), publicUrl: "http://localhost:5174", idleMinutes: 60, maxHours: 1 },
    });
    const H = { host: "localhost:5174" };
    const launch = await app.inject({
      method: "POST",
      url: "/api/runs",
      headers: H,
      payload: { source: { kind: "manual", type: "feature", title: "Add thing", description: "d" }, repos: [{ path: url, baseBranch: "main" }] },
    });
    expect(launch.statusCode, launch.body).toBe(201);
    const run = (await app.inject({ url: `/api/runs/${launch.json().runId}`, headers: H })).json();
    expect(run.repos[0]).toMatchObject({ url, path: join(tmp, "repos", "local", ...parseRepoUrl(url).segments), stacks: ["typescript"] });

    (config.repoSources as { allowLocalPaths: boolean }).allowLocalPaths = false;
    const refused = await app.inject({
      method: "POST",
      url: "/api/runs",
      headers: H,
      payload: { source: { kind: "manual", type: "feature", title: "t", description: "d" }, repos: [{ path: tmp }] },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: "repo_rejected" });
    expect((await app.inject({ url: `/api/stacks/detect?path=${encodeURIComponent(tmp)}`, headers: H })).statusCode).toBe(400);
    expect((await app.inject({ url: "/healthz", headers: H })).json()).toEqual({ ok: true });
    await app.close();
  });
});
