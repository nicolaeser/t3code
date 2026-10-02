# Dev VM bootstrap

Prepares a fresh Debian or Ubuntu VM as a remote environment for T3 Code: runtime, Docker, the
coding CLIs, and Git hosting access that works for an agent.

```bash
scp infra/dev-vm/vm-bootstrap.sh root@<vm>:
ssh root@<vm> bash vm-bootstrap.sh
```

Steps, in order: `base`, `node`, `docker`, `claude`, `grok`, `codex`, `t3`, `git`, `remind`.
Use `--only git` or `--skip docker,codex` to run a subset; `--list` prints the step names.
Every step is idempotent, so re-running is safe.

## Git access for agents

The agent runs `git` without a terminal, often without a `HOME` and sometimes as another Linux
user. A credential that only lives in one user's `gh` or `glab` config fails there with
`could not read Username ... terminal prompts disabled`. The `git` step therefore:

- stores each token in `/etc/git-credentials` (`root:gitcreds`, mode `0640`; existing users are
  added to the group, later ones with `usermod -aG gitcreds <user>`)
- points `credential.helper` in `/etc/gitconfig` at that store first, with `gh` and `glab` as
  per-host fallbacks using absolute binary paths
- sets `GIT_TERMINAL_PROMPT=0` system-wide so a missing credential fails fast instead of hanging
- removes `insteadOf` rewrites to SSH; everything stays on HTTPS
- verifies each account with `env -i HOME=/nonexistent git ls-remote` against one of its repos

Accounts are added from an interactive menu: GitHub (device code or token) and any number of
GitLab instances (gitlab.com or self-hosted; device code, browser, or token). Self-hosted GitLab
device login needs an OAuth application `client_id` on the instance; a personal access token with
`api`, `read_repository`, `write_repository` is the simpler path.

After the accounts are verified the script runs `t3 connect`, then prints the remaining manual
logins (`claude`, `codex login`, `grok`) and reminds you to `source ~/.bashrc`.
