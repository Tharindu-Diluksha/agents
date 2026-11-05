# Feature known context

A compact record of decisions, hosting options and the tool landscape gathered
while building the orchestrator, so later work (human or AI) can start from it.
Researched November 2026. Prices and vendor terms change often; re-check before acting.

## Project state

| PR | Branch → base | Content | State |
|---|---|---|---|
| #1 | → main | Role split (Unit/Integration/E2E testers), per-role models, guard rails, token usage, JIRA MCP config | merged |
| #2 | → main | Parallel runs: worktrees, port blocks, overlaps, sync before PR, event history | merged |
| #3 | → main | `jira-to-pr` Claude Code plugin (same workflow, subagents, approvals in chat) | merged |
| #4 | → main | Request guard, stack profiles (TS/Node/Vue/React/.NET/Python/Go), shared prompts, archive/analytics | merged |
| #5 | `feature/keycloak-auth` → main | Keycloak sign-in, realm roles, session cookie, Postgres sessions + audit log | open, held until #6 merges |
| #6 | `feature/server-mode` → `feature/keycloak-auth` | Docker server mode, launch by Git URL, container-safe locks | open |

## Auth decisions (PR #5)

- Audience: a small, trusted team on a shared server.
- Keycloak realm roles: `viewer` < `operator` (launch/jump/abort) < `approver` (gates, PRs, JIRA comments) < `admin` (archive/delete, audit).
- Backend session cookie (`orch_session`, stored hashed); refresh tokens sealed with `SESSION_SECRET`.
- Postgres holds Keycloak's DB, login sessions and the audit log. `AUTH_MODE=none` needs neither Keycloak nor Postgres. `SESSION_STORE=postgres|memory`.

## Server mode (PR #6)

- One container runs the backend and UI (`deploy/docker/Dockerfile`), as the `server` profile in `deploy/docker-compose.yml` beside Keycloak and Postgres. Secrets go in `deploy/server.env` (from `server.env.example`).
- Repos are launched by Git URL. The server clones each repo once into `/data/repos/<host>/<owner>/<repo>` and fetches it on later launches. Every run gets a worktree in `/data/worktrees/<runId>/<repo>`; roles edit and commit there. Nothing leaves the container until the PR Creator pushes and `gh pr create` runs after approval.
- Unpushed work exists only in the `orchestrator-data` volume, so back it up. Archiving or deleting a run removes its worktree, and the clone stays as a cache.
- Credentials:
  - Claude: `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`).
  - GitHub: `GH_TOKEN`. One shared identity, so PRs are authored by the token owner. The audit log records who approved what.
- `KEYCLOAK_INTERNAL_URL=http://keycloak:8080`: the backend reaches Keycloak over the compose network while browsers and the token issuer keep the public URL. This was verified with a real browser login.
- Only one backend per state folder and database: a file lock with host + heartbeat (containers all run as pid 1) plus a Postgres advisory lock.
- Comparison with Claude Code cloud sessions: the model is the same (repo cloned remotely, agent works there, PR comes out). The differences:
  - It is self-hosted.
  - It runs a gated multi-role pipeline.
  - State persists across restarts.
  - All runs share one container: separate worktrees, but the same OS user.
  - Credentials are shared by the team.

  This is accepted for a small trusted team. If the audience grows, build per-run containers and per-user GitHub tokens.

## Hosting options (low cost first)

Needs: at least 8 GB RAM (12 GB is comfortable), at least 80 GB disk (each run's worktree installs its own dependencies), a single always-on instance with a persistent volume and WebSockets. Keep `MAX_CONCURRENT_ROLES=2` on small machines. Claude usage will cost far more than hosting.

| Option | Cost | Notes |
|---|---|---|
| **Oracle Cloud Always Free (Ampere A1, Arm)** | $0 | 2 OCPU / 12 GB (cut from 4/24 in mid-2026). Idle VMs (<20% CPU, network and memory over 7 days) can be reclaimed; upgrading to Pay As You Go avoids that and keeps the free allowance. Free Arm capacity is often short. **Recommended free option.** The Arm image build is not yet verified. |
| **Spare PC / mini PC + Tailscale** | $0 (owned hardware) | Private access only, with no public IP or TLS setup. Suits `start-dev` Keycloak. Set `KEYCLOAK_URL` / `ORCHESTRATOR_URL` to the tailnet name. |
| Hetzner CX33 (4 vCPU / 8 GB, x86) | about €9/mo | Best paid value; EU only. 2026 price rises, and reports conflict on which plans can be ordered. |
| Hetzner CAX21 (4 vCPU / 8 GB, Arm) | about €11/mo | EU only. |
| AWS Lightsail 8 GB (2 vCPU) | $44/mo | 160 GB disk, 5 TB transfer. |
| DigitalOcean Basic 8 GB (4 vCPU) | $48/mo | 160 GB disk, 5 TB transfer. |

Avoid scale-to-zero or serverless platforms (Cloud Run, Render free, Railway). The orchestrator needs a long-running single instance with a volume.

## Similar tools (landscape, Nov 2026)

**Commercial cloud agents.** Each is a single agent per task in a hosted sandbox that returns a PR; none has a gated multi-role pipeline.
- Claude Code on the web
- OpenAI Codex (cloud): sandboxed tasks, PR review
- GitHub Copilot coding agent: issue → PR, GitHub-hosted repos only
- Google Jules: VM per task, free daily tier
- Cursor cloud agents: isolated VMs; reportedly offers self-hosted workers
- Devin (Cognition): most autonomous, parallel VMs, usage-billed, uneven on vague tasks

**Open-source, self-hostable cloud agents**
- **OpenHands** (MIT): closest open-source match to self-hosted cloud sessions. Sandboxed, runs in a VPC or Kubernetes, also has a hosted cloud. No built-in hard cost cap.
- **Open SWE** (LangChain): async agent started by GitHub labels, LangGraph-based with a planner and reviewer, pluggable sandboxes (Daytona, Modal, …). More framework than product.

**Parallel-agent orchestrators** (worktrees, mostly local or desktop, no role pipeline or gates): Vibe Kanban, Conductor, Emdash, Paseo, Orchestrator.inc, Open Swarm, Proliferate. Superset is source-available (Elastic License), not open source.

**Role-based pipelines**
- MetaGPT and ChatDev: research frameworks with company-like roles.
- BMAD Method and rjmurillo/ai-agents: agent and prompt kits for Claude Code, comparable to the `jira-to-pr` plugin.
- One-person projects: AICOM (12 agents, 5 gates), autonomous-sdlc, among others. Their maturity varies.
- Building blocks: CrewAI, LangGraph, AutoGen.

**What sets this orchestrator apart:**
- Approval-gated mutating actions: JIRA comment, branch names and PR are approved in the UI.
- A TDD-shaped pipeline with capped fix loops.
- JIRA as input, with read-only access on JIRA runs only.
- Keycloak roles and an audit log, plus cost per run and a budget cap.
- Self-hosted, with a plugin twin (`plugins/jira-to-pr`).

## Open follow-ups

- Verify the Docker image builds and runs on arm64 (needed for Oracle A1), then add an Oracle + Tailscale guide to `deploy/README.md`.
- Optional, for a larger or less trusted audience:
  - a per-run container sandbox (the orchestrator would start containers, so it needs access to Docker);
  - per-user GitHub tokens.
- Production Keycloak: switch to `start` with HTTPS, regenerate the client secret, remove the dev users (see the checklist in `deploy/README.md`).

## Sources

Hosting: [Oracle Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) · [HN: Oracle A1 limit cut](https://news.ycombinator.com/item?id=49183750) · [Site2US: Oracle 2026 limits](https://site2us.com/en/servers/oracle-cloud-free-tier) · [Hetzner 2026 plans (bitdoze)](https://www.bitdoze.com/hetzner-cloud-cost-optimized-plans/) · [Hetzner review (Better Stack)](https://betterstack.com/community/guides/web-servers/hetzner-cloud-review/) · [DigitalOcean Droplet pricing](https://www.digitalocean.com/pricing/droplets) · [Lightsail bundles](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-bundles.html)

Tools: [Best cloud coding agents (aq.dev)](https://aq.dev/guides/best-cloud-coding-agents/) · [Cloud agents that open PRs (ssojet)](https://ssojet.com/blog/best-cloud-coding-agents) · [AI coding agents 2026 (Firecrawl)](https://www.firecrawl.dev/blog/best-ai-coding-agents) · [Orchestration tools (Tembo)](https://www.tembo.io/blog/ai-agent-orchestration-tools) · [awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators) · [Open-source orchestrators (Augment Code)](https://www.augmentcode.com/tools/open-source-agent-orchestrators) · [rjmurillo/ai-agents](https://github.com/rjmurillo/ai-agents) · [AICOM (DEV)](https://dev.to/alexar76/open-source-multi-agent-pipeline-61k-python-12-agents-5-quality-gates-4hl4) · [OpenHands (dsebastien)](https://www.dsebastien.net/openhands/) · [Open SWE review (emelia)](https://emelia.io/pt/hub/langchain-open-swe-review)
