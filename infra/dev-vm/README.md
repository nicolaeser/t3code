# Dev VM bootstrap

Prepares a fresh Debian or Ubuntu VM as a remote environment for T3 Code: runtime, Docker, the
coding CLIs, and Git hosting access that works for an agent.

```bash
scp infra/dev-vm/vm-bootstrap.sh root@<vm>:
ssh -t root@<vm> bash vm-bootstrap.sh
```

Run it as root. It creates the user `agent` (no login password, passwordless `sudo`), copies
itself to `/home/agent/vm-bootstrap.sh` and re-executes from `/home/agent` as that user, so every
step and everything it installs belongs to `agent`. Set `AGENT_USER` for a different name and
`NODE_MAJOR` for another Node.js line (default 26).

Steps, in order: `agent`, `base`, `node`, `docker`, `claude`, `grok`, `codex`, `t3`, `git`,
`remind`. Use `--only git` or `--skip docker,codex` to run a subset; `--list` prints the step
names. Every step is idempotent, so re-running is safe.

## Git access for agents

The agent runs `git` without a terminal and often without a `HOME`. A credential that only lives
in one user's `gh` or `glab` config fails there with `could not read Username ... terminal
prompts disabled`. The `git` step therefore:

- stores each token in `/etc/git-credentials` (`root:gitcreds`, mode `0640`; `agent` is added to
  the group, other users with `usermod -aG gitcreds <user>`)
- sets `credential.helper` in `/etc/gitconfig` to that store and clears `core.askPass`
- sets `GIT_TERMINAL_PROMPT=0` system-wide so a missing credential fails fast instead of hanging
- verifies each account with `env -i HOME=/nonexistent git ls-remote` against one of its repos

Accounts are added from an interactive menu: GitHub (browser/device code or token) and any number
of GitLab instances (gitlab.com or self-hosted; device code, browser, or token). Self-hosted GitLab
device login needs an OAuth application `client_id` on the instance; a personal access token with
`api`, `read_repository`, `write_repository` is the simpler path.

After the accounts are verified the script enables linger for `agent` and starts its systemd
user manager (T3 installs its background service there; `runuser` alone opens no session),
then runs `t3 connect`, then prints the remaining manual
logins: `su - agent`, then `claude` (`/login`), `codex login` and `grok`. Add accounts later with
`bash /home/agent/vm-bootstrap.sh --only git`.
