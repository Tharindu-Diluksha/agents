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

## Server mode (everything in containers)

The `server` profile adds the orchestrator itself, with the backend and the built UI in one image (`deploy/docker/Dockerfile`):

```bash
cp deploy/server.env.example deploy/server.env   # set SESSION_SECRET, Claude and GitHub credentials
docker compose -f deploy/docker-compose.yml --profile server up -d --build
```

Open http://localhost:5174 and sign in as one of the dev users.

**Repos are launched by Git URL.** In the launch dialog, enter a URL such as `https://github.com/org/repo.git` or `git@github.com:org/repo.git` instead of a path. The server clones each repo once into `/data/repos/<host>/<owner>/<repo>`, fetches it on later launches, and gives each run its own worktree as usual.
- `ALLOWED_REPO_URLS` limits launches to URL prefixes, e.g. `https://github.com/my-org/`.
- The image sets `ALLOW_LOCAL_REPO_PATHS=false`, so paths inside the container are refused. To work on a checkout you mount yourself, set it to `true` and enter the mount path (or a `file://` URL). If the mount belongs to another uid, list it in `GIT_SAFE_DIRECTORIES` (comma-separated paths, or `*`). Otherwise git refuses it as "dubious ownership".
- URLs with embedded credentials are refused. Use `GH_TOKEN` instead.

**Credentials** (all in `deploy/server.env`):
- **Claude:** for API billing, set `ANTHROPIC_API_KEY`. To use a Claude subscription, run `claude setup-token` on your machine and set the token as `CLAUDE_CODE_OAUTH_TOKEN`. The container has no browser, so `claude /login` is not an option.
- **GitHub:** `GH_TOKEN` is used by `gh pr create`, and the entrypoint also runs `gh auth setup-git`, so HTTPS clones and pushes use the token. For `git@` URLs, mount an SSH key and `known_hosts` into `/home/orchestrator/.ssh`. Commits are authored as `GIT_USER_NAME` / `GIT_USER_EMAIL`.

**State.** Everything lives in the `orchestrator-data` volume, mounted at `/data`. Back it up as one unit:

| Path | Contents |
| --- | --- |
| `/data/runs` | `run.json`, artifacts, event logs (`RUNS_DIR`) |
| `/data/sessions` | SDK session ids per role (`SESSIONS_DIR`) |
| `/data/worktrees` | per-run worktrees (`WORKTREES_DIR`) |
| `/data/repos` | clones of launched repos (`REPOS_DIR`) |
| `/data/claude` | Claude Code's config and session history (`CLAUDE_CONFIG_DIR`); a role is resumed from here |
| `/data/playwright-browsers` | browsers the E2E Tester installs |

Worktrees and session history must stay on the same volume as the runs. The SDK resumes a session by its working directory, and worktrees point back to their clone by absolute path.

**Keycloak URLs.** Browsers and token issuers use the public URL (`KEYCLOAK_URL`, default `http://localhost:8080`). The backend reaches Keycloak at `KEYCLOAK_INTERNAL_URL` (`http://keycloak:8080` on the compose network): discovery, token and refresh requests addressed to the issuer's origin are sent there instead, while issuer checks and browser redirects keep the public URL. For a real hostname, set `KEYCLOAK_URL` and `ORCHESTRATOR_URL` (which becomes `PUBLIC_URL`), and add the redirect URI to the client.

**One backend per state folder.** Run state is cached in memory. The backend locks `runs/.orchestrator.lock`, writing its host and a heartbeat every 30 s, so a second container sharing the volume refuses to start; a lock left by a crashed container is taken over after 2 minutes. With a database it also holds a Postgres advisory lock, so two backends can't share the same `DATABASE_URL` either. Don't scale the `orchestrator` service beyond one replica.

**Image.** Node 22 on Debian bookworm, with git, ssh, `gh`, Python 3 (+ venv), Go, .NET 8 and the system libraries for headless Chromium. It runs as the non-root user `orchestrator` (uid 10001). To make the image smaller, turn toolchains off with build args, for example to leave out .NET and Go:

```bash
docker compose -f deploy/docker-compose.yml --profile server build --build-arg INSTALL_DOTNET=false --build-arg INSTALL_GO=false
```

The available args are `INSTALL_PYTHON`, `INSTALL_GO`, `INSTALL_DOTNET` and `INSTALL_PLAYWRIGHT_DEPS`. Behind a TLS-intercepting proxy, pass the proxy's CA as a build secret, and it is trusted at build and run time:

```bash
docker build --secret id=extra_ca,src=corp-ca.crt -f deploy/docker/Dockerfile -t agent-orchestrator .
```

**JIRA.** Use an HTTP/SSE MCP server (`JIRA_MCP_URL`, `JIRA_MCP_TRANSPORT`, `JIRA_MCP_HEADERS`), or put a `jira-mcp.json` on the volume and set `JIRA_MCP_CONFIG=/data/jira-mcp.json`. A stdio server only works if its command is installed in the image.

`GET /healthz` is public and used by the container health check.
