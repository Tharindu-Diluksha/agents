/*
 * Who may do what. Keycloak realm roles:
 *   viewer   — read runs, artifacts, streams, analytics, exports
 *   operator — launch runs, jump/abort, re-check overlaps, test JIRA
 *   approver — decide approval gates (incl. creating branches/PRs and posting
 *              JIRA comments) and skip gates
 *   admin    — everything, incl. archive/delete runs, remove worktrees, audit log
 * Every role implies viewer; admin implies all.
 *
 * Every /api and /ws route must be listed here. Anything not listed is
 * admin-only (deny by default), and a test checks the table covers every
 * registered route.
 */

export const APP_ROLES = ["viewer", "operator", "approver", "admin"] as const;
export type AppRole = (typeof APP_ROLES)[number];
export type Requirement = "public" | AppRole;

export const ROUTE_RULES: Record<string, Requirement> = {
  // Login flow
  "GET /auth/login": "public",
  "GET /auth/callback": "public",
  "POST /auth/logout": "public",
  "GET /auth/me": "public",
  "GET /healthz": "public",

  // Read
  "GET /api/config": "viewer",
  "GET /api/runs": "viewer",
  "GET /api/runs/:id": "viewer",
  "GET /api/runs/:id/artifacts/*": "viewer",
  "GET /api/runs/:id/events": "viewer",
  "GET /api/runs/:id/export": "viewer",
  "GET /api/analytics": "viewer",
  "GET /api/analytics/export.csv": "viewer",
  "GET /api/slots": "viewer",
  "GET /ws/runs": "viewer",
  "GET /ws/runs/:id": "viewer",

  // Operate
  "POST /api/runs": "operator",
  "GET /api/stacks/detect": "operator", // probes local paths, part of launching
  "POST /api/runs/:id/jump": "operator",
  "POST /api/runs/:id/abort": "operator",
  "POST /api/runs/:id/overlaps/refresh": "operator",
  "POST /api/jira/test": "operator",

  // Approve
  "POST /api/runs/:id/approve": "approver",
  "POST /api/runs/:id/skip": "approver",

  // Administer
  "POST /api/runs/:id/workspaces/remove": "admin",
  "POST /api/runs/:id/archive": "admin",
  "DELETE /api/runs/:id": "admin",
  "GET /api/audit": "admin",
};

/** The rule for a request, by Fastify route pattern. Non-API paths (the SPA and its assets) are public. */
export function requirementFor(method: string, routeUrl: string | undefined, rawUrl: string): Requirement {
  const m = method === "HEAD" ? "GET" : method;
  const rule = routeUrl ? ROUTE_RULES[`${m} ${routeUrl}`] : undefined;
  if (rule) return rule;
  const path = rawUrl.split("?")[0]!;
  if (path.startsWith("/api") || path.startsWith("/ws") || path.startsWith("/auth")) return "admin"; // unlisted → deny by default
  return "public";
}

export function allows(roles: readonly string[], required: Requirement): boolean {
  if (required === "public") return true;
  if (roles.includes("admin")) return true;
  if (required === "viewer") return APP_ROLES.some((r) => roles.includes(r));
  return roles.includes(required);
}

/** The app roles among a token's roles (Keycloak also adds default-roles-*, offline_access, …). */
export function appRoles(roles: readonly string[]): AppRole[] {
  return APP_ROLES.filter((r) => roles.includes(r));
}
