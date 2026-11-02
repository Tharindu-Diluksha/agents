import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorktree, changedFiles, switchWorktreeBranch, syncWithBase } from "../src/external/git.js";

// Rebases/merges made by the code under test need an identity on any machine.
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });

const root = mkdtempSync(join(tmpdir(), "git-sync-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  }).trim();

let n = 0;
/** A repo on main with a.txt/b.txt, and a worktree on a fresh feature branch. */
async function setup(): Promise<{ repo: string; wt: string }> {
  const repo = join(root, `repo${++n}`);
  execFileSync("mkdir", ["-p", repo]);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a1\n");
  writeFileSync(join(repo, "b.txt"), "b1\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const wt = join(root, `wt${n}`);
  await addWorktree(repo, wt, { ref: "main" });
  await switchWorktreeBranch(wt, "feature/x");
  return { repo, wt };
}

describe("changedFiles", () => {
  it("lists committed, uncommitted and untracked changes since the branch point", async () => {
    const { repo, wt } = await setup();
    writeFileSync(join(wt, "a.txt"), "a2\n");
    git(wt, "commit", "-qam", "change a");
    writeFileSync(join(wt, "b.txt"), "b2\n"); // uncommitted
    writeFileSync(join(wt, "new.txt"), "n\n"); // untracked
    // Upstream changes after the branch point don't count.
    writeFileSync(join(repo, "c.txt"), "c\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "upstream");
    expect(await changedFiles(wt, "main")).toEqual(["a.txt", "b.txt", "new.txt"]);
  });
});

describe("syncWithBase", () => {
  it("reports up to date", async () => {
    const { wt } = await setup();
    expect(await syncWithBase(wt, "main", { fetch: false })).toEqual({ status: "up_to_date", ref: "main" });
  });

  it("rebases an unpushed branch onto new upstream commits", async () => {
    const { repo, wt } = await setup();
    writeFileSync(join(wt, "a.txt"), "a2\n");
    git(wt, "commit", "-qam", "feature");
    writeFileSync(join(repo, "b.txt"), "b2\n");
    git(repo, "commit", "-qam", "upstream");
    expect(await syncWithBase(wt, "main", { fetch: false })).toEqual({ status: "rebased", ref: "main", behind: 1 });
    expect(git(wt, "log", "--format=%s")).toBe("feature\nupstream\ninit"); // linear
  });

  it("merges instead of rebasing once the branch has been pushed", async () => {
    const { repo, wt } = await setup();
    writeFileSync(join(wt, "a.txt"), "a2\n");
    git(wt, "commit", "-qam", "feature");
    git(wt, "update-ref", "refs/remotes/origin/feature/x", "HEAD"); // as if pushed
    writeFileSync(join(repo, "b.txt"), "b2\n");
    git(repo, "commit", "-qam", "upstream");
    expect(await syncWithBase(wt, "main", { fetch: false })).toMatchObject({ status: "merged", behind: 1 });
    expect(git(wt, "rev-list", "--count", "--merges", "HEAD")).toBe("1");
  });

  it("leaves a conflicting merge in progress and lists the files", async () => {
    const { repo, wt } = await setup();
    writeFileSync(join(wt, "a.txt"), "feature\n");
    git(wt, "commit", "-qam", "feature");
    writeFileSync(join(repo, "a.txt"), "upstream\n");
    git(repo, "commit", "-qam", "upstream");
    const r = await syncWithBase(wt, "main", { fetch: false });
    expect(r).toEqual({ status: "conflicts", ref: "main", behind: 1, files: ["a.txt"] });
    expect(readFileSync(join(wt, "a.txt"), "utf8")).toContain("<<<<<<<");
    // Resolving + `git commit --no-edit` concludes it.
    writeFileSync(join(wt, "a.txt"), "both\n");
    git(wt, "add", "a.txt");
    git(wt, "commit", "--no-edit", "-q");
    expect(await syncWithBase(wt, "main", { fetch: false })).toEqual({ status: "up_to_date", ref: "main" });
  });

  it("skips when the worktree has uncommitted changes", async () => {
    const { repo, wt } = await setup();
    writeFileSync(join(repo, "b.txt"), "b2\n");
    git(repo, "commit", "-qam", "upstream");
    writeFileSync(join(wt, "a.txt"), "dirty\n");
    expect(await syncWithBase(wt, "main", { fetch: false })).toMatchObject({ status: "skipped", reason: /uncommitted/ });
  });
});
