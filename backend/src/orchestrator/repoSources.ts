import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { config, paths } from "../config.js";
import { cloneRepo, fetchOrigin, isWorktreeRoot, originUrl } from "../external/git.js";

/*
 * Where a run's repo comes from:
 * - a checkout path on this machine (the default for local use), or
 * - a Git URL (server mode): the orchestrator clones it once into
 *   <REPOS_DIR>/<host>/<owner>/<repo> and fetches it again on later launches.
 *   Runs then work in worktrees of that clone as usual.
 *
 * Policy (config.repoSources): local paths can be turned off for shared
 * servers, and URLs can be limited to allowed prefixes. URLs with embedded
 * credentials are refused: they would end up in run.json and git config; use
 * GH_TOKEN / a credential helper / SSH keys instead.
 */

export class RepoSourceError extends Error {}

export interface ParsedRepoUrl {
  /** The URL as given (minus a trailing slash). */
  url: string;
  host: string;
  /** Path segments after the host, without a trailing .git, e.g. ["acme", "web"]. */
  segments: string[];
  kind: "https" | "http" | "ssh" | "file";
}

const SCP_LIKE = /^([\w.-]+@)?([\w.-]+):(?!\/\/)([\w./-]+)$/; // git@github.com:acme/web.git

export function looksLikeUrl(input: string): boolean {
  return /^(https?|ssh|file):\/\//i.test(input.trim()) || SCP_LIKE.test(input.trim());
}

export function parseRepoUrl(input: string): ParsedRepoUrl {
  const raw = input.trim().replace(/\/+$/, "");
  const clean = (segs: string[]) => {
    const out = segs.filter(Boolean);
    if (out.length === 0) throw new RepoSourceError(`no repository path in ${raw}`);
    out[out.length - 1] = out[out.length - 1]!.replace(/\.git$/, "");
    if (out.some((s) => s === "." || s === ".." || !/^[\w.-]+$/.test(s))) throw new RepoSourceError(`unsupported repository path in ${raw}`);
    return out;
  };

  const scp = raw.match(SCP_LIKE);
  if (scp && !/^[a-z]+:\/\//i.test(raw)) {
    return { url: raw, host: scp[2]!.toLowerCase(), segments: clean(scp[3]!.split("/")), kind: "ssh" };
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new RepoSourceError(`not a Git URL: ${raw}`);
  }
  const kind = u.protocol.replace(":", "") as ParsedRepoUrl["kind"];
  if (!["https", "http", "ssh", "file"].includes(kind)) throw new RepoSourceError(`unsupported URL scheme ${u.protocol} (use https, ssh or git@host:owner/repo)`);
  if (u.password || (u.username && kind !== "ssh")) {
    throw new RepoSourceError("credentials in the repository URL are not allowed; give the server GH_TOKEN, a credential helper or an SSH key instead");
  }
  if (kind === "file") return { url: raw, host: "local", segments: clean(decodeURIComponent(u.pathname).split("/")), kind };
  return { url: raw, host: u.host.toLowerCase(), segments: clean(u.pathname.split("/")), kind };
}

export function isAllowedRepoUrl(parsed: ParsedRepoUrl, prefixes: string[], allowLocalPaths: boolean): boolean {
  if (parsed.kind === "file") return allowLocalPaths; // a file:// URL is a local path in disguise
  if (prefixes.length === 0) return true;
  const norm = (s: string) => s.toLowerCase().replace(/\.git$/, "");
  return prefixes.some((p) => norm(parsed.url).startsWith(norm(p)));
}

/** Clone location for a URL, stable across launches. */
export function cloneDirFor(parsed: ParsedRepoUrl): string {
  return join(paths.reposDir, parsed.host.replace(/[^\w.-]/g, "_"), ...parsed.segments);
}

const inFlight = new Map<string, Promise<string>>();

/** Clones the repo (first time) or fetches it (later), one operation per clone at a time. Returns the clone path. */
export function ensureClone(parsed: ParsedRepoUrl): Promise<string> {
  const dir = cloneDirFor(parsed);
  const running = inFlight.get(dir);
  if (running) return running;
  const p = (async () => {
    if (existsSync(dir)) {
      if (!(await isWorktreeRoot(dir))) throw new RepoSourceError(`${dir} exists but is not a git clone; remove it and launch again`);
      const origin = await originUrl(dir);
      if (origin && parseRepoUrl(origin).segments.join("/").toLowerCase() !== parsed.segments.join("/").toLowerCase()) {
        throw new RepoSourceError(`${dir} is a clone of ${origin}, not ${parsed.url}`);
      }
      await fetchOrigin(dir);
    } else {
      mkdirSync(dirname(dir), { recursive: true });
      await cloneRepo(parsed.url, dir);
    }
    return dir;
  })().finally(() => inFlight.delete(dir));
  inFlight.set(dir, p);
  return p;
}

export interface ResolvedRepo {
  /** The checkout the run's worktrees are created from. */
  path: string;
  /** The Git URL, when launched by URL. */
  url: string | null;
}

/** Turns a launch dialog entry (a path or a Git URL) into a checkout on this machine, enforcing the policy. */
export async function resolveRepoSource(
  input: string,
  policy: { allowLocalPaths: boolean; allowedUrlPrefixes: string[] } = config.repoSources,
): Promise<ResolvedRepo> {
  const value = input.trim();
  if (looksLikeUrl(value)) {
    const parsed = parseRepoUrl(value);
    if (!isAllowedRepoUrl(parsed, policy.allowedUrlPrefixes, policy.allowLocalPaths)) {
      throw new RepoSourceError(
        parsed.kind === "file"
          ? "file:// URLs are local paths, which this server does not allow"
          : `${parsed.url} is not in the allowed repositories (${policy.allowedUrlPrefixes.join(", ")})`,
      );
    }
    return { path: await ensureClone(parsed), url: parsed.url };
  }
  if (!policy.allowLocalPaths) {
    throw new RepoSourceError("this server only accepts Git URLs (ALLOW_LOCAL_REPO_PATHS=false); enter the repository's clone URL");
  }
  if (!existsSync(value)) throw new RepoSourceError(`repo path not found: ${value}`);
  return { path: value, url: null };
}
