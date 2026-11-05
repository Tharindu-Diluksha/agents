# Authentication with Keycloak + Postgres

The orchestrator runs without login by default (`AUTH_MODE=none`): everyone who can reach it is a local admin. That is fine on your own machine. For a **shared server**, turn on Keycloak:

- Users sign in with Keycloak (authorization code + PKCE). The backend keeps the tokens; the browser only gets an httpOnly session cookie.
- Permissions come from **Keycloak realm roles**:

  | Role | Can |
  | ---- | --- |
  | `viewer` | see runs, artifacts, live streams, analytics, exports |
  | `operator` | viewer + launch runs, jump, abort, re-check overlaps, test JIRA |
  | `approver` | viewer + decide approval gates (branch names, PRs, JIRA comments) and skip gates |
  | `admin` | everything, incl. archive/delete runs, remove worktrees, the audit log |

  A user with none of these can sign in but sees nothing. Assign roles in Keycloak; changes apply within one access-token lifetime (5 minutes in the provided realm), because the backend refreshes tokens on use.
- Every run shows **who launched it** and an **Activity** list (who approved, rejected, jumped, aborted…). Postgres keeps an append-only **audit log** (sign-ins, denied requests, all actions, also for deleted runs), visible to admins under **Audit**.

## Local setup (Docker)

```bash
docker compose -f deploy/docker-compose.yml up -d
```

This starts Postgres 16 (databases `keycloak` and `orchestrator`) and Keycloak 26 on http://localhost:8080 (admin console: `admin` / `admin`). On first start Keycloak imports `deploy/keycloak/orchestrator-realm.json`:

- realm `orchestrator` with the four roles above (`admin` includes the others; `operator` and `approver` include `viewer`);
- confidential client `orchestrator-web` (PKCE S256, redirect URIs for ports 5173 and 5174) with a mapper that puts the realm roles in the ID token as `roles`;
- development users, password = username: `alice` (admin), `bob` (approver), `carol` (operator), `dave` (viewer).

Later restarts skip the import, so changes you make in Keycloak are kept.

Then in `.env` at the repo root:

```bash
AUTH_MODE=keycloak
KEYCLOAK_ISSUER=http://localhost:8080/realms/orchestrator
KEYCLOAK_CLIENT_ID=orchestrator-web
KEYCLOAK_CLIENT_SECRET=dev-only-change-me
SESSION_SECRET=<at least 32 random characters, e.g. `openssl rand -base64 48`>
DATABASE_URL=postgres://orchestrator:orchestrator@localhost:5432/orchestrator
PUBLIC_URL=http://localhost:5173   # the URL you open: 5173 with `npm run dev`, 5174 for the built app
```

`npm run dev` and open `PUBLIC_URL`. The backend creates its tables on start (`schema_migrations`, `sessions`, `audit_log`).

## Production checklist

- Run Keycloak with `start` (not `start-dev`) behind HTTPS, with its own hostname (`KC_HOSTNAME`), and change the bootstrap admin password.
- Delete the development users and **regenerate the client secret** (Clients → orchestrator-web → Credentials); set it as `KEYCLOAK_CLIENT_SECRET`.
- In the client, set the real redirect URI (`https://<host>/auth/callback`), post-logout redirect URI (`https://<host>/`) and web origin.
- Change the Postgres passwords in `deploy/postgres/init.sql` / `DATABASE_URL`.
- Orchestrator: `PUBLIC_URL=https://<host>` (session cookies are then marked `Secure`), `HOST=0.0.0.0` (or bind to the proxy's interface), and add the host to `ALLOWED_HOSTS` if it differs from `PUBLIC_URL`'s. Behind a reverse proxy set `TRUST_PROXY=true` so the audit log records client IPs.
- Use a long random `SESSION_SECRET` and keep it stable: it encrypts stored refresh tokens. Rotating it signs everyone out.
- Sessions end after `SESSION_IDLE_MINUTES` of inactivity (default 480) or `SESSION_MAX_HOURS` (default 168), or as soon as Keycloak refuses a token refresh (user disabled, session revoked, logged out elsewhere). Open live streams are closed when a session ends.

## Without Postgres

`SESSION_STORE=memory` keeps sessions in memory (everyone is signed out on restart). Leaving `DATABASE_URL` unset also turns off the audit log; activity is still recorded on each run.
