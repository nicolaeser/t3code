#!/usr/bin/env bash
# =============================================================================
#  vm-bootstrap.sh — fresh Debian/Ubuntu dev VM in one go
#
#  Steps (in order):
#    base     curl, wget, git, jq, ca-certificates, build tools
#    node     Node.js (NodeSource) + latest npm
#    docker   Docker CE from the official Docker apt repo
#    claude   Claude Code CLI
#    grok     xAI Grok CLI
#    codex    OpenAI Codex CLI
#    t3       t3 (npm, global)
#    git      gh + glab, login to as many GitHub / gitlab.com / self-hosted GitLab
#             accounts as you like; credentials go to /etc/git-credentials and
#             /etc/gitconfig so git works for ANY user, with NO TTY and NO HOME
#             (how t3 code / agents run it) — each account is verified that way
#    remind   list of subscriptions / CLIs you still need to log in to
#
#  Usage:
#    bash vm-bootstrap.sh                 run everything
#    bash vm-bootstrap.sh --only git      only the git / account setup
#    bash vm-bootstrap.sh --skip docker,codex
#    bash vm-bootstrap.sh --list          show steps
#
#  Run as root (typical for a homelab VM) or as a sudo-capable user.
#  Re-running is safe: every step is idempotent.
# =============================================================================
set -euo pipefail

NODE_MAJOR="${NODE_MAJOR:-26}"
GLAB_FALLBACK_VERSION="1.120.0"     # used if the GitLab API can't be reached
SYSTEM_GITCONFIG="/etc/gitconfig"   # helpers go here → every Linux user benefits

ALL_STEPS=(base node docker claude grok codex t3 git remind)

# ----------------------------------------------------------------------------- ui
if [[ -t 1 ]]; then
  C_RESET=$'\e[0m'; C_BOLD=$'\e[1m'; C_DIM=$'\e[2m'
  C_BLUE=$'\e[34m'; C_GREEN=$'\e[32m'; C_YELLOW=$'\e[33m'; C_RED=$'\e[31m'
else
  C_RESET=""; C_BOLD=""; C_DIM=""; C_BLUE=""; C_GREEN=""; C_YELLOW=""; C_RED=""
fi

STEP_NO=0; STEP_TOTAL=0
step()  {
  STEP_NO=$((STEP_NO+1))
  printf '\n%s%s┌─[%d/%d] %s%s\n' "$C_BOLD" "$C_BLUE" "$STEP_NO" "$STEP_TOTAL" "$*" "$C_RESET"
  printf '%s%s└%s%s\n' "$C_BOLD" "$C_BLUE" "$(printf '─%.0s' $(seq 1 60))" "$C_RESET"
}
banner() {
  printf '%s%s\n' "$C_BOLD$C_BLUE" '  ██╗   ██╗███╗   ███╗      ██████╗  ██████╗  ██████╗ ████████╗'
  printf '%s\n'   '  ██║   ██║████╗ ████║      ██╔══██╗██╔═══██╗██╔═══██╗╚══██╔══╝'
  printf '%s\n'   '  ██║   ██║██╔████╔██║█████╗██████╔╝██║   ██║██║   ██║   ██║   '
  printf '%s\n'   '  ╚██╗ ██╔╝██║╚██╔╝██║╚════╝██╔══██╗██║   ██║██║   ██║   ██║   '
  printf '%s\n'   '   ╚████╔╝ ██║ ╚═╝ ██║      ██████╔╝╚██████╔╝╚██████╔╝   ██║   '
  printf '%s%s\n' '    ╚═══╝  ╚═╝     ╚═╝      ╚═════╝  ╚═════╝  ╚═════╝    ╚═╝   ' "$C_RESET"
}
info()  { printf '%s    %s%s\n' "$C_DIM" "$*" "$C_RESET"; }
ok()    { printf '%s  ✔ %s%s\n' "$C_GREEN" "$*" "$C_RESET"; }
warn()  { printf '%s  ! %s%s\n' "$C_YELLOW" "$*" "$C_RESET"; }
fail()  { printf '%s  ✘ %s%s\n' "$C_RED" "$*" "$C_RESET" >&2; }
die()   { fail "$@"; exit 1; }

ask() {               # ask "Prompt" default  → echoes answer
  local prompt="$1" default="${2:-}" answer
  if [[ -n "$default" ]]; then
    read -r -p "  $prompt [$default]: " answer </dev/tty
    printf '%s' "${answer:-$default}"
  else
    read -r -p "  $prompt: " answer </dev/tty
    printf '%s' "$answer"
  fi
}
ask_secret() {        # like ask, but no echo
  local answer
  read -r -s -p "  $1: " answer </dev/tty
  printf '\n' >/dev/tty
  printf '%s' "$answer"
}
confirm() {           # confirm "Question?" [y|n]  → exit 0 on yes
  local prompt="$1" default="${2:-y}" answer hint
  [[ "$default" == "y" ]] && hint="Y/n" || hint="y/N"
  read -r -p "  $prompt [$hint] " answer </dev/tty
  answer="${answer:-$default}"
  [[ "$answer" =~ ^[Yy] ]]
}
choose() {            # choose "Prompt" opt1 opt2 ... → echoes chosen index (1-based)
  local prompt="$1"; shift
  local i=1 answer
  for opt in "$@"; do printf '    %d) %s\n' "$i" "$opt" >/dev/tty; i=$((i+1)); done
  while true; do
    read -r -p "  $prompt [1-$#]: " answer </dev/tty
    if [[ "$answer" =~ ^[0-9]+$ ]] && (( answer >= 1 && answer <= $# )); then
      printf '%s' "$answer"; return
    fi
  done
}

apt_install() { $SUDO apt-get install -y -q "$@"; }
apt_update()  { $SUDO apt-get update -q; }

ensure_path_line() {  # ensure_path_line '<dir>'  → adds to ~/.bashrc and ~/.profile once
  local dir="$1" line
  line="export PATH=\"$dir:\$PATH\""
  for rc in "$TARGET_HOME/.bashrc" "$TARGET_HOME/.profile"; do
    touch "$rc"
    grep -qF "$line" "$rc" || printf '\n%s\n' "$line" >>"$rc"
  done
  case ":$PATH:" in *":$dir:"*) ;; *) export PATH="$dir:$PATH" ;; esac
}

# ============================================================================= steps
step_base() {
  step "Base packages"
  apt_update
  apt_install ca-certificates curl wget gnupg git jq unzip zip tar xz-utils \
              build-essential python3 python3-pip apt-transport-https lsb-release
  ok "curl $(curl --version | head -1 | awk '{print $2}'), git $(git --version | awk '{print $3}')"
}

step_node() {
  step "Node.js ${NODE_MAJOR}.x + npm"
  if command -v node >/dev/null && [[ "$(node -v | sed 's/^v//' | cut -d. -f1)" == "$NODE_MAJOR" ]]; then
    info "node $(node -v) already installed"
  else
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | ${SUDO:+$SUDO -E} bash -
    apt_install nodejs
  fi
  $SUDO npm install -g npm@latest >/dev/null
  ok "node $(node -v), npm $(npm -v)"
}

step_docker() {
  step "Docker CE"
  if command -v docker >/dev/null; then
    info "docker already installed: $(docker --version)"
  else
    apt_install ca-certificates curl
    $SUDO install -m 0755 -d /etc/apt/keyrings
    $SUDO curl -fsSL "https://download.docker.com/linux/${DISTRO_ID}/gpg" -o /etc/apt/keyrings/docker.asc
    $SUDO chmod a+r /etc/apt/keyrings/docker.asc
    $SUDO tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/${DISTRO_ID}
Suites: ${DISTRO_CODENAME}
Components: stable
Architectures: ${ARCH}
Signed-By: /etc/apt/keyrings/docker.asc
EOF
    apt_update
    apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
  $SUDO systemctl enable --now docker >/dev/null 2>&1 || warn "could not enable docker.service (no systemd?)"
  if [[ $EUID -ne 0 ]] && ! id -nG | grep -qw docker; then
    $SUDO usermod -aG docker "$USER"
    warn "Added $USER to the docker group — log out/in for it to take effect."
  fi
  ok "$(docker --version) / $(docker compose version 2>/dev/null || echo 'compose n/a')"
}

step_claude() {
  step "Claude Code"
  curl -fsSL https://claude.ai/install.sh | bash
  ensure_path_line "$TARGET_HOME/.local/bin"
  ok "claude $(claude --version 2>/dev/null || echo installed)"
}

step_grok() {
  step "Grok CLI (xAI)"
  curl -fsSL https://x.ai/cli/install.sh | bash
  ensure_path_line "$TARGET_HOME/.local/bin"
  ok "grok $(grok --version 2>/dev/null || echo installed)"
}

step_codex() {
  step "Codex CLI (OpenAI)"
  curl -fsSL https://chatgpt.com/codex/install.sh | sh
  ensure_path_line "$TARGET_HOME/.local/bin"
  ok "codex $(codex --version 2>/dev/null || echo installed)"
}

step_t3() {
  step "t3"
  $SUDO npm install -g t3@latest >/dev/null
  ok "t3 $(t3 --version 2>/dev/null || echo installed)"
}

# ----------------------------------------------------------------------------- git
#  Design goal: `git` must authenticate for ANY Linux user, with NO TTY, NO HOME
#  and a minimal PATH — i.e. exactly how an agent (t3 code, CI, cron) runs it.
#  Therefore:
#    * all wiring lives in /etc/gitconfig           (not ~/.gitconfig)
#    * tokens live in /etc/git-credentials          (root:gitcreds 0640) and are
#      tried FIRST; gh/glab are only a fallback with absolute binary paths
#    * GIT_TERMINAL_PROMPT=0 globally → fail fast instead of hanging an agent
#    * every account is verified with `env -i ... git ls-remote` at the end
CRED_FILE="/etc/git-credentials"
CRED_GROUP="gitcreds"
GH_BIN="/usr/bin/gh"
GLAB_BIN="/usr/bin/glab"

install_gh() {
  command -v gh >/dev/null && { info "gh $(gh --version | head -1 | awk '{print $3}') present"; return; }
  $SUDO install -m 0755 -d /etc/apt/keyrings
  $SUDO curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
  $SUDO chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | $SUDO tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  apt_update
  apt_install gh
  ok "gh $(gh --version | head -1 | awk '{print $3}')"
}

install_glab() {
  command -v glab >/dev/null && { info "glab $(glab version 2>/dev/null | awk '{print $3}' | head -1) present"; return; }
  # Distro packages of glab are ancient (no --device login) → official .deb
  local ver deb tmp
  ver="$(curl -fsSL 'https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/releases/permalink/latest' 2>/dev/null \
         | jq -r '.tag_name' 2>/dev/null | sed 's/^v//')" || true
  [[ -z "$ver" || "$ver" == "null" ]] && ver="$GLAB_FALLBACK_VERSION"
  deb="glab_${ver}_linux_${ARCH}.deb"
  tmp="$(mktemp -d)"
  curl -fsSL "https://gitlab.com/gitlab-org/cli/-/releases/v${ver}/downloads/${deb}" -o "$tmp/$deb" \
    || die "Could not download glab ${ver} for ${ARCH}."
  $SUDO dpkg -i "$tmp/$deb" >/dev/null
  rm -rf "$tmp"
  ok "glab ${ver}"
}

# One-time system wiring (idempotent)
git_system_setup() {
  # shared credential store, readable by root + members of $CRED_GROUP
  $SUDO groupadd -f "$CRED_GROUP"
  $SUDO touch "$CRED_FILE"
  $SUDO chown "root:$CRED_GROUP" "$CRED_FILE"
  $SUDO chmod 0640 "$CRED_FILE"
  # every human user on the box (uid >= 1000) + whoever invoked us may read it
  local u
  for u in $(awk -F: '$3>=1000 && $3<65534 {print $1}' /etc/passwd) ${SUDO_USER:-}; do
    id -nG "$u" 2>/dev/null | grep -qw "$CRED_GROUP" || $SUDO usermod -aG "$CRED_GROUP" "$u"
  done

  # /etc/gitconfig — the generic store helper is tried first for every host
  $SUDO git config --system --unset-all credential.helper 2>/dev/null || true
  $SUDO git config --system credential.helper "store --file=${CRED_FILE}"
  $SUDO git config --system core.askPass ""
  $SUDO git config --system safe.directory '*'          # repos owned by another user are fine
  $SUDO git config --system init.defaultBranch main

  # never let an agent hang on a username/password prompt
  printf 'export GIT_TERMINAL_PROMPT=0\nexport GIT_ASKPASS=\n' | $SUDO tee /etc/profile.d/git-noprompt.sh >/dev/null
  grep -q '^GIT_TERMINAL_PROMPT=' /etc/environment 2>/dev/null \
    || echo 'GIT_TERMINAL_PROMPT=0' | $SUDO tee -a /etc/environment >/dev/null

  # HTTPS everywhere: kill any https→ssh rewrites in system/global config
  for scope in --system --global; do
    for k in $(git config $scope --name-only --get-regexp '^url\..*\.insteadof$' 2>/dev/null || true); do
      $SUDO git config $scope --unset-all "$k" 2>/dev/null || true
    done
  done
}

# per-host fallback helper (store is already first via the generic entry)
wire_git_host() {     # wire_git_host <host> <helper-cmd>
  local url="https://$1" helper="$2"
  $SUDO git config --system --unset-all "credential.${url}.helper" 2>/dev/null || true
  $SUDO git config --system "credential.${url}.helper" "$helper"
}

store_git_credential() {  # store_git_credential <host> <username> <token>
  local host="$1" user="$2" tok="$3"
  # drop an older entry for the same host+user, then add
  printf 'protocol=https\nhost=%s\nusername=%s\n' "$host" "$user" \
    | $SUDO git credential-store --file "$CRED_FILE" erase 2>/dev/null || true
  printf 'protocol=https\nhost=%s\nusername=%s\npassword=%s\n' "$host" "$user" "$tok" \
    | $SUDO git credential-store --file "$CRED_FILE" store
  $SUDO chown "root:$CRED_GROUP" "$CRED_FILE"; $SUDO chmod 0640 "$CRED_FILE"
}

# The real test: no HOME, no TTY, minimal PATH — how an agent runs git.
agent_git_check() {   # agent_git_check <https-repo-url>
  env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/nonexistent GIT_TERMINAL_PROMPT=0 \
      git ls-remote "$1" HEAD >/dev/null 2>&1
}

verify_host() {       # verify_host <host> <repo-url or empty>
  local host="$1" url="$2"
  if [[ -z "$url" ]]; then
    warn "$host: no repo found on this account to test with — add one, or test a URL from the hub menu"
    return
  fi
  if agent_git_check "$url"; then
    ok "$host: agent-mode git works (no HOME, no TTY) → $url"
  else
    fail "$host: agent-mode git FAILED for $url — token scopes? (needs repo / read_repository+write_repository)"
  fi
}

login_github_account() {
  echo
  printf '  %sGitHub account%s\n' "$C_BOLD" "$C_RESET"
  local method
  method="$(choose "Login method" \
      "Browser / device code   (shows a one-time code; approve it from any device)" \
      "Personal access token   (classic PAT with 'repo' + 'workflow', or fine-grained with contents:rw)")"
  if [[ "$method" == "1" ]]; then
    gh auth login --hostname github.com --git-protocol https --web --skip-ssh-key \
       --insecure-storage --scopes 'repo,workflow,read:org,gist' </dev/tty || { fail "gh login aborted"; return 0; }
  else
    local tok
    tok="$(ask_secret "GitHub PAT")"
    [[ -z "$tok" ]] && { warn "empty token, skipping"; return 0; }
    printf '%s' "$tok" | gh auth login --hostname github.com --git-protocol https --insecure-storage --with-token \
      || { fail "token rejected"; return 0; }
  fi
  local user tok
  user="$(gh api user --jq .login 2>/dev/null || echo "")"
  tok="$(gh auth token --hostname github.com 2>/dev/null || echo "")"
  [[ -z "$user" || -z "$tok" ]] && { fail "could not read user/token back from gh"; return 0; }
  store_git_credential github.com "$user" "$tok"
  wire_git_host github.com      "!${GH_BIN} auth git-credential"
  wire_git_host gist.github.com "!${GH_BIN} auth git-credential"
  ok "GitHub: $user"
  verify_host github.com "$(gh repo list "$user" --limit 1 --json url --jq '.[0].url' 2>/dev/null || true)"
}

login_gitlab_account() {
  echo
  printf '  %sGitLab account%s\n' "$C_BOLD" "$C_RESET"
  local host
  host="$(ask "GitLab host (gitlab.com, or your own e.g. git.example.com)" "gitlab.com")"
  host="${host#https://}"; host="${host#http://}"; host="${host%%/*}"
  [[ -z "$host" ]] && return 0
  local method
  method="$(choose "Login method for $host" \
      "Device code             (gitlab.com; self-hosted needs GitLab 17.9+ AND an OAuth app client_id)" \
      "Browser / web           (OAuth via browser URL)" \
      "Personal access token   (recommended for self-hosted; scopes: api, read_repository, write_repository)")"
  case "$method" in
    1) glab auth login --hostname "$host" --git-protocol https --insecure-storage --device </dev/tty \
         || { warn "device flow failed — self-hosted needs: glab config set client_id <id> -g --host $host (Admin > Applications). Use a token instead."; return 0; } ;;
    2) glab auth login --hostname "$host" --git-protocol https --insecure-storage --web </dev/tty \
         || { fail "web login aborted"; return 0; } ;;
    3) local tok
       tok="$(ask_secret "GitLab PAT for $host")"
       [[ -z "$tok" ]] && { warn "empty token, skipping"; return 0; }
       printf '%s' "$tok" | glab auth login --hostname "$host" --git-protocol https --insecure-storage --stdin \
         || { fail "token rejected"; return 0; } ;;
  esac
  local user tok
  user="$(GITLAB_HOST="$host" glab api user 2>/dev/null | jq -r '.username // empty' || echo "")"
  tok="$(glab config get token --host "$host" 2>/dev/null || echo "")"
  [[ -z "$tok" ]] && tok="$(GITLAB_HOST="$host" glab auth status --show-token 2>&1 | sed -n 's/.*[Tt]oken: *//p' | head -1)"
  [[ -z "$user" || -z "$tok" ]] && { fail "could not read user/token back from glab (is the token valid?)"; return 0; }
  store_git_credential "$host" "$user" "$tok"
  wire_git_host "$host" "!${GLAB_BIN} auth git-credential"
  ok "GitLab $host: $user"
  verify_host "$host" "$(GITLAB_HOST="$host" glab api 'projects?membership=true&per_page=1&order_by=last_activity_at' 2>/dev/null \
                         | jq -r '.[0].http_url_to_repo // empty' || true)"
}

account_status() {
  echo
  printf '  %s── GitHub ───────────────────────────────────────────%s\n' "$C_DIM" "$C_RESET"
  if gh auth status >/dev/null 2>&1; then
    gh auth status 2>&1 | grep -E 'Logged in to|Active account' | sed 's/^ */    /'
  else
    printf '    %s(none)%s\n' "$C_DIM" "$C_RESET"
  fi
  printf '  %s── GitLab ───────────────────────────────────────────%s\n' "$C_DIM" "$C_RESET"
  local hosts
  hosts="$($SUDO sed -nE 's#^https://[^@]*@([^/]+).*#\1#p' "$CRED_FILE" 2>/dev/null | grep -v '^github\.com$' | sort -u || true)"
  if [[ -z "$hosts" ]]; then
    printf '    %s(none)%s\n' "$C_DIM" "$C_RESET"
  else
    local h u
    for h in $hosts; do
      u="$(GITLAB_HOST="$h" glab api user 2>/dev/null | jq -r '.username // empty' || true)"
      if [[ -n "$u" ]]; then printf '    %s✔%s %-32s %s\n' "$C_GREEN" "$C_RESET" "$h" "$u"
      else                   printf '    %s✘%s %-32s %s(glab token invalid/revoked — git store may still work)%s\n' "$C_RED" "$C_RESET" "$h" "$C_DIM" "$C_RESET"; fi
    done
  fi
  printf '  %s── stored credentials (%s) ──%s\n' "$C_DIM" "$CRED_FILE" "$C_RESET"
  if $SUDO test -s "$CRED_FILE"; then
    $SUDO sed -E 's#^https://([^:]+):[^@]*@(.+)$#    \2  (\1)#' "$CRED_FILE"
  else
    printf '    %s(empty)%s\n' "$C_DIM" "$C_RESET"
  fi
}

test_repo_url() {
  local url
  url="$(ask "Repo URL (https://host/group/repo.git)")"
  [[ -z "$url" ]] && return 0
  if agent_git_check "$url"; then ok "agent-mode ls-remote OK — authenticated, no prompt, no HOME needed"
  else fail "ls-remote failed — token scopes, repo access or typo"; fi
}

verify_all() {
  echo
  printf '  %sFinal check — every stored credential, agent-mode%s\n' "$C_BOLD" "$C_RESET"
  $SUDO test -s "$CRED_FILE" || { warn "no credentials stored"; return; }
  local line host user
  while IFS= read -r line; do
    host="$(sed -E 's#^https://[^@]*@([^/]+).*#\1#' <<<"$line")"
    user="$(sed -E 's#^https://([^:]+):.*#\1#' <<<"$line")"
    case "$host" in
      github.com)
        verify_host "github.com ($user)" "$(gh repo list "$user" --limit 1 --json url --jq '.[0].url' 2>/dev/null || true)" ;;
      *)
        verify_host "$host ($user)" "$(GITLAB_HOST="$host" glab api 'projects?membership=true&per_page=1' 2>/dev/null \
                                      | jq -r '.[0].http_url_to_repo // empty' || true)" ;;
    esac
  done < <($SUDO cat "$CRED_FILE")
}

account_hub() {
  while true; do
    account_status
    echo
    printf '  %sAccounts — add as many as you like (GitHub, gitlab.com, self-hosted GitLab)%s\n' "$C_BOLD" "$C_RESET"
    local c
    c="$(choose "What next?" \
        "Add GitHub account" \
        "Add GitLab account (gitlab.com or self-hosted)" \
        "Test a repo URL in agent mode (no HOME / no TTY)" \
        "Switch active GitHub account (gh auth switch)" \
        "Done")"
    case "$c" in
      1) login_github_account ;;
      2) login_gitlab_account ;;
      3) test_repo_url ;;
      4) gh auth switch </dev/tty || true ;;
      5) break ;;
    esac
  done
}

step_git() {
  step "Git, gh, glab + accounts"
  apt_install git jq
  install_gh
  install_glab
  git_system_setup

  # identity (global for the user running this; system-wide fallback too)
  local cur_name cur_mail name mail
  cur_name="$(git config --global user.name  || true)"
  cur_mail="$(git config --global user.email || true)"
  echo
  name="$(ask "git user.name"  "${cur_name:-}")"
  mail="$(ask "git user.email" "${cur_mail:-}")"
  git config --global user.name  "$name";  $SUDO git config --system user.name  "$name"
  git config --global user.email "$mail";  $SUDO git config --system user.email "$mail"
  git config --global pull.rebase false

  account_hub
  verify_all

  # hand straight over to t3 code (interactive account link) if it is installed
  if command -v t3 >/dev/null; then
    echo
    printf '  %sConnecting t3 code (t3 connect)%s\n' "$C_BOLD" "$C_RESET"
    t3 connect </dev/tty || warn "t3 connect did not finish — run it again later: t3 connect"
  else
    warn "t3 not installed (step 't3' skipped?) — run 't3 connect' after installing it"
  fi

  echo
  ok "git wiring: $SYSTEM_GITCONFIG + $CRED_FILE (group $CRED_GROUP)"
  info "new Linux users later: usermod -aG $CRED_GROUP <user>"
  info "two accounts on the same host? put the user in the remote: https://<user>@github.com/org/repo.git"
}

step_remind() {
  step "Final steps"
  cat <<EOF

  ${C_BOLD}${C_YELLOW}1. Reload your shell (or open a new SSH session):${C_RESET}
       ${C_BOLD}source ~/.bashrc${C_RESET}

  ${C_BOLD}${C_YELLOW}2. Log in to your subscriptions:${C_RESET}
       ${C_BOLD}claude${C_RESET}        → /login        (Claude Pro/Max)
       ${C_BOLD}codex login${C_RESET}                   (ChatGPT Plus/Pro)
       ${C_BOLD}grok${C_RESET}          → follow prompt (SuperGrok)

  ${C_DIM}git is ready for agents: HTTPS, no TTY/HOME needed, any user.
  add accounts later:  bash $0 --only git     reconnect t3:  t3 connect${C_RESET}
EOF
}

# ============================================================================= main
usage() { sed -n '2,/^# ====*$/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

# --- args (before any OS checks so --help/--list work anywhere)
ONLY=""; SKIP=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --only) ONLY="$2"; shift 2 ;;
    --skip) SKIP="$2"; shift 2 ;;
    --list) printf '%s\n' "${ALL_STEPS[@]}"; exit 0 ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done

# --- environment
if [[ $EUID -eq 0 ]]; then SUDO=""; else
  command -v sudo >/dev/null || die "Not root and sudo is missing."
  SUDO="sudo"
fi
export DEBIAN_FRONTEND=noninteractive

[[ -r /etc/os-release ]] || die "Unsupported OS: /etc/os-release missing."
# shellcheck disable=SC1091
. /etc/os-release
DISTRO_ID="${ID:-debian}"
DISTRO_CODENAME="${VERSION_CODENAME:-}"
ARCH="$(dpkg --print-architecture)"
case "$DISTRO_ID" in
  debian|ubuntu) ;;
  *) warn "Untested distro '$DISTRO_ID' — proceeding as if Debian." ;;
esac

TARGET_HOME="$HOME"
if [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != "root" ]]; then
  warn "Started via sudo: user-level tools (claude, grok, codex, t3) install for root,"
  warn "not for $SUDO_USER. Run as the user you actually work as if that's not intended."
fi

in_list() { [[ ",$2," == *",$1,"* ]]; }
RUN=()
for s in "${ALL_STEPS[@]}"; do
  if [[ -n "$ONLY" ]]; then in_list "$s" "$ONLY" && RUN+=("$s"); continue; fi
  in_list "$s" "$SKIP" || RUN+=("$s")
done
[[ ${#RUN[@]} -gt 0 ]] || die "nothing to run"

STEP_TOTAL=${#RUN[@]}
banner
printf '  %s%s%s · %s %s · %s · as %s\n' "$C_BOLD" "$(hostname)" "$C_RESET" "$DISTRO_ID" "$DISTRO_CODENAME" "$ARCH" "$(id -un)"
info "steps: ${RUN[*]}"

START=$(date +%s)
for s in "${RUN[@]}"; do "step_$s"; done
printf '\n%s%sDone in %ss.%s\n' "$C_BOLD" "$C_GREEN" "$(( $(date +%s) - START ))" "$C_RESET"
