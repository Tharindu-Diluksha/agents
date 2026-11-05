import { reactive } from "vue";

/*
 * Who is signed in. Loaded once before the app mounts (main.ts). With
 * AUTH_MODE=keycloak an anonymous visitor is sent to /auth/login, which
 * returns them to the page they asked for. The backend enforces every
 * permission; the UI only uses roles to disable what you can't do.
 */

export type AppRole = "viewer" | "operator" | "approver" | "admin";

export interface CurrentUser {
  sub: string;
  name: string;
  email: string | null;
  roles: AppRole[];
}

export const auth = reactive<{ mode: "none" | "keycloak"; user: CurrentUser | null }>({ mode: "none", user: null });

export function loginUrl(returnTo = location.pathname + location.search): string {
  return `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}

/** Full-page redirect to Keycloak (via the backend). */
export function redirectToLogin(): never {
  location.assign(loginUrl());
  throw new Error("redirecting to login");
}

export async function loadCurrentUser(): Promise<void> {
  const res = await fetch("/auth/me");
  const body = (await res.json().catch(() => ({}))) as { authMode?: "none" | "keycloak"; user?: CurrentUser };
  auth.mode = body.authMode ?? "none";
  if (res.status === 401) redirectToLogin();
  auth.user = body.user ?? null;
}

/** Mirrors the backend's rule: admin can do everything; every role can view. */
export function can(role: AppRole): boolean {
  const roles = auth.user?.roles ?? [];
  if (roles.includes("admin")) return true;
  if (role === "viewer") return roles.length > 0;
  return roles.includes(role);
}

/** Tooltip for a control the user lacks the role for. */
export function needs(role: AppRole): string | undefined {
  return can(role) ? undefined : `Requires the ${role} role`;
}

export async function logout(): Promise<void> {
  const res = await fetch("/auth/logout", { method: "POST" });
  const body = (await res.json().catch(() => ({}))) as { redirect?: string };
  location.assign(body.redirect ?? "/");
}
