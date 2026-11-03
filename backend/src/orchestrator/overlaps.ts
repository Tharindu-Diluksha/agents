import { resolve } from "node:path";
import { config } from "../config.js";
import { emit } from "../events.js";
import { changedFiles } from "../external/git.js";
import { log } from "../log.js";
import { listRuns, saveRun } from "./runStore.js";
import type { Overlap, RunRecord } from "./types.js";
import { diffBase } from "./workspaces.js";

/*
 * Overlap detection between parallel runs on the same repo. For every active
 * run with a worktree, compute the files it changes against its base; any
 * file changed by two runs is reported on both, so the user can sequence the
 * work before the second PR arrives already conflicting.
 */

const INACTIVE = new Set(["done", "failed"]);

function sameRepo(a: string, b: string): boolean {
  const n = (p: string) => resolve(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return n(a) === n(b);
}

/**
 * Recomputes overlaps for `record` and every active run sharing a repo with
 * it, saves the ones that changed and emits `run.overlaps` for them.
 * Never throws: overlap detection is advisory.
 */
export async function refreshOverlaps(record: RunRecord): Promise<void> {
  try {
    const runs = listRuns().filter(
      (r) =>
        (r.runId === record.runId || !INACTIVE.has(r.state)) &&
        r.repos.some((x) => x.workPath && record.repos.some((y) => sameRepo(x.path, y.path))),
    );
    if (!runs.some((r) => r.runId === record.runId)) runs.push(record);

    const copied = new Set(config.worktree.copyFiles.map((f) => f.replace(/\\/g, "/").replace(/^\.\//, "")));
    // Changed files per run per repo, computed once.
    const changes = new Map<string, Map<string, Set<string>>>();
    for (const run of runs) {
      const perRepo = new Map<string, Set<string>>();
      if (!INACTIVE.has(run.state)) {
        for (const repo of run.repos) {
          if (!repo.workPath) continue;
          try {
            const files = await changedFiles(repo.workPath, diffBase(repo));
            // Files the orchestrator copied in (WORKTREE_COPY_FILES) aren't the run's changes.
            perRepo.set(repo.path, new Set(files.filter((f) => !copied.has(f))));
          } catch (err) {
            log.warn("overlaps.changed_files_failed", { runId: run.runId, repo: repo.path, err: err instanceof Error ? err.message : String(err) });
          }
        }
      }
      changes.set(run.runId, perRepo);
    }

    for (const run of runs) {
      const next = computeFor(run, runs, changes);
      if (JSON.stringify(next) !== JSON.stringify(run.overlaps ?? [])) {
        run.overlaps = next;
        saveRun(run);
        emit({ type: "run.overlaps", runId: run.runId, overlaps: next });
      }
    }
  } catch (err) {
    log.warn("overlaps.refresh_failed", { runId: record.runId, err: err instanceof Error ? err.message : String(err) });
  }
}

export function computeFor(run: RunRecord, runs: RunRecord[], changes: Map<string, Map<string, Set<string>>>): Overlap[] {
  const mine = changes.get(run.runId);
  if (!mine) return [];
  const out: Overlap[] = [];
  for (const other of runs) {
    if (other.runId === run.runId) continue;
    const theirs = changes.get(other.runId);
    if (!theirs) continue;
    for (const [repoPath, files] of mine) {
      for (const [otherRepo, otherFiles] of theirs) {
        if (!sameRepo(repoPath, otherRepo)) continue;
        const shared = [...files].filter((f) => otherFiles.has(f)).sort();
        if (shared.length > 0) out.push({ otherRunId: other.runId, otherLabel: other.label, repoPath, files: shared });
      }
    }
  }
  return out;
}
