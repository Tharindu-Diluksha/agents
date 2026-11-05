#!/bin/sh
# Container start: credentials and identity for git / gh / Claude, then the backend.
set -e

mkdir -p "${RUNS_DIR:-/data/runs}" "${SESSIONS_DIR:-/data/sessions}" "${WORKTREES_DIR:-/data/worktrees}" \
         "${REPOS_DIR:-/data/repos}" "${CLAUDE_CONFIG_DIR:-/data/claude}"

# Identity for the commits the orchestrator itself makes (rebase/merge before a PR).
git config --global user.name "${GIT_USER_NAME:-Agent Orchestrator}"
git config --global user.email "${GIT_USER_EMAIL:-orchestrator@localhost}"

# Mounted checkouts / bare repos owned by another uid (ALLOW_LOCAL_REPO_PATHS=true):
# git refuses them as "dubious ownership" unless listed. Comma-separated paths, or *.
git config --global --unset-all safe.directory >/dev/null 2>&1 || true
if [ -n "${GIT_SAFE_DIRECTORIES:-}" ]; then
  echo "$GIT_SAFE_DIRECTORIES" | tr ',' '\n' | while read -r dir; do
    if [ -n "$dir" ]; then git config --global --add safe.directory "$dir"; fi
  done
fi

# GitHub over HTTPS (clone, fetch, push, gh pr create) with GH_TOKEN.
if [ -n "${GH_TOKEN:-}" ]; then
  gh auth setup-git --hostname "${GH_HOST:-github.com}" >/dev/null 2>&1 \
    || echo "orchestrator: warning: 'gh auth setup-git' failed; git over HTTPS may not authenticate" >&2
else
  echo "orchestrator: note: GH_TOKEN is not set; private HTTPS clones, pushes and PR creation will fail" >&2
fi

# Claude: an API key (API billing) or a long-lived subscription token from `claude setup-token`.
if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  echo "orchestrator: warning: set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN; role sessions cannot authenticate otherwise" >&2
fi

exec "$@"
