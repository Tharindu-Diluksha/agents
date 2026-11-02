import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { paths } from "../config.js";
import type { RepoTarget, RoleId, RunRecord } from "./types.js";

/**
 * Layout per run:
 *   runs/<runId>/
 *     run.json                       ← state metadata (not an artifact)
 *     analyst/<file>.md
 *     developer/<file>.md
 *     reviewer/<file>.md
 *     tester/<file>.md
 *     prCreator/<file>.md
 *     orchestrator/<file>            ← orchestrator-generated, e.g. proposed-branches.json
 *
 * Role attribution for the UI comes from the subfolder name — no central
 * registry needed.
 */
export function runDir(runId: string): string {
  return join(paths.runsDir, runId);
}

export function roleArtifactDir(runId: string, role: RoleId | "orchestrator"): string {
  return join(runDir(runId), role);
}

export function ensureRoleDir(runId: string, role: RoleId | "orchestrator"): string {
  const dir = roleArtifactDir(runId, role);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function readTemplate(name: string): string {
  const file = join(paths.templatesDir, name);
  return readFileSync(file, "utf8");
}

export function writeArtifact(absPath: string, body: string): void {
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, body);
}

export function readArtifact(absPath: string): string | null {
  if (!existsSync(absPath)) return null;
  return readFileSync(absPath, "utf8");
}

/** Convert an absolute artifact path to a repo-relative POSIX-style path for UI display. */
export function toRelative(absPath: string): string {
  return relative(paths.repoRoot, absPath).split("\\").join("/");
}

export type ArtifactOwner = RoleId | "orchestrator";

const KNOWN_OWNERS: Set<ArtifactOwner> = new Set([
  "analyst",
  "developer",
  "reviewer",
  "tester",
  "prCreator",
  "orchestrator",
]);

export function repoSlug(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return (parts[parts.length - 1] ?? "repo").toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

export function perRepoPrDescriptionName(repo: RepoTarget): string {
  return `${repoSlug(repo.path)}-pr-description.md`;
}

export interface ListedArtifact {
  owner: ArtifactOwner;
  file: string;      // absolute
  relative: string;  // POSIX repo-relative
  name: string;      // basename
}

export function listArtifactsForRun(record: RunRecord): ListedArtifact[] {
  const base = runDir(record.runId);
  if (!existsSync(base)) return [];
  const out: ListedArtifact[] = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (!KNOWN_OWNERS.has(name as ArtifactOwner)) continue;
    const owner = name as ArtifactOwner;
    const sub = join(base, name);
    for (const f of readdirSync(sub, { withFileTypes: true })) {
      if (!f.isFile()) continue;
      const abs = join(sub, f.name);
      out.push({ owner, file: abs, relative: toRelative(abs), name: f.name });
    }
  }
  return out;
}

/** Absolute path for an artifact under a role's folder. */
export function artifactPath(record: RunRecord, role: ArtifactOwner, name: string): string {
  return join(roleArtifactDir(record.runId, role), name);
}

/** POSIX-relative path (handy for prompts). */
export function artifactRelative(record: RunRecord, role: ArtifactOwner, name: string): string {
  return toRelative(artifactPath(record, role, name));
}
