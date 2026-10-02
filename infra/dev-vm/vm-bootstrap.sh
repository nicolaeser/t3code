#!/usr/bin/env bash
set -euo pipefail

AGENT_USER="${AGENT_USER:-agent}"
AGENT_HOME="/home/${AGENT_USER}"
AGENT_SCRIPT="${AGENT_HOME}/vm-bootstrap.sh"
NODE_MAJOR="${NODE_MAJOR:-26}"
GLAB_FALLBACK_VERSION="1.120.0"
CRED_FILE="/etc/git-credentials"
CRED_GROUP="gitcreds"

ALL_STEPS=(agent base node docker claude grok codex t3 git remind)

if [[ -t 1 ]]; then
  C_RESET=$'\e[0m'; C_BOLD=$'\e[1m'; C_DIM=$'\e[2m'
  C_BLUE=$'\e[34m'; C_GREEN=$'\e[32m'; C_YELLOW=$'\e[33m'; C_RED=$'\e[31m'
else
  C_RESET=""; C_BOLD=""; C_DIM=""; C_BLUE=""; C_GREEN=""; C_YELLOW=""; C_RED=""
fi

STEP_NO=0; STEP_TOTAL=0
step()  { STEP_NO=$((STEP_NO+1)); printf '\n%s%s[%d/%d] %s%s\n' "$C_BOLD" "$C_BLUE" "$STEP_NO" "$STEP_TOTAL" "$*" "$C_RESET"; }
info()  { printf '%s    %s%s\n' "$C_DIM" "$*" "$C_RESET"; }
ok()    { printf '%s  ✔ %s%s\n' "$C_GREEN" "$*" "$C_RESET"; }
warn()  { printf '%s  ! %s%s\n' "$C_YELLOW" "$*" "$C_RESET"; }
fail()  { printf '%s  ✘ %s%s\n' "$C_RED" "$*" "$C_RESET" >&2; }
die()   { fail "$@"; exit 1; }

ask() {
  local prompt="$1" default="${2:-}" answer
  if [[ -n "$default" ]]; then
    read -r -p "  $prompt [$default]: " answer </dev/tty
    printf '%s' "${answer:-$default}"
  else
    read -r -p "  $prompt: " answer </dev/tty
    printf '%s' "$answer"
  fi
}
ask_secret() {
  local answer
  read -r -s -p "  $1: " answer </dev/tty
  printf '\n' >/dev/tty
  printf '%s' "$answer"
}
choose() {
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

apt_install() { sudo apt-get install -y -q "$@"; }
apt_update()  { sudo apt-get update -q; }

ensure_path_line() {
  local dir="$1" line rc
  line="export PATH=\"$dir:\$PATH\""
  for rc in "$HOME/.bashrc" "$HOME/.profile"; do
    touch "$rc"
    grep -qF "$line" "$rc" || printf '\n%s\n' "$line" >>"$rc"
  done
  case ":$PATH:" in *":$dir:"*) ;; *) export PATH="$dir:$PATH" ;; esac
}

create_agent_user() {
  id "$AGENT_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash --user-group "$AGENT_USER"
  passwd -d "$AGENT_USER" >/dev/null
  command -v sudo >/dev/null || { apt-get update -q; apt-get install -y -q sudo; }
  printf '%s ALL=(ALL:ALL) NOPASSWD:ALL\n' "$AGENT_USER" >"/etc/sudoers.d/${AGENT_USER}"
  chmod 0440 "/etc/sudoers.d/${AGENT_USER}"
  visudo -cf "/etc/sudoers.d/${AGENT_USER}" >/dev/null || die "invalid sudoers entry for $AGENT_USER"
}

reexec_as_agent() {
  [[ -f "$0" ]] || die "Run from a saved file (bash vm-bootstrap.sh), not a pipe."
  install -m 0755 -o "$AGENT_USER" -g "$AGENT_USER" "$0" "$AGENT_SCRIPT"
  cd "$AGENT_HOME"
  exec runuser -u "$AGENT_USER" -- env \
       HOME="$AGENT_HOME" USER="$AGENT_USER" LOGNAME="$AGENT_USER" \
       AGENT_USER="$AGENT_USER" NODE_MAJOR="$NODE_MAJOR" \
       bash "$AGENT_SCRIPT" "$@"
}

step_agent() {
  step "User ${AGENT_USER}"
  sudo -n true 2>/dev/null || die "$AGENT_USER cannot sudo without a password"
  ok "running as $(id -un), home $HOME, passwordless sudo"
}

step_base() {
  step "Base packages"
  apt_update
  apt_install ca-certificates curl git jq unzip build-essential
  ok "curl $(curl --version | head -1 | awk '{print $2}'), git $(git --version | awk '{print $3}')"
}

step_node() {
  step "Node.js ${NODE_MAJOR}.x + npm"
  if command -v node >/dev/null && [[ "$(node -v | sed 's/^v//' | cut -d. -f1)" == "$NODE_MAJOR" ]]; then
    info "node $(node -v) already installed"
  else
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
    apt_install nodejs
  fi
  sudo npm install -g npm@latest >/dev/null
  ok "node $(node -v), npm $(npm -v)"
}

step_docker() {
  step "Docker CE"
  if command -v docker >/dev/null; then
    info "docker already installed: $(docker --version)"
  else
    sudo install -m 0755 -d /etc/apt/keyrings
    sudo curl -fsSL "https://download.docker.com/linux/${DISTRO_ID}/gpg" -o /etc/apt/keyrings/docker.asc
    sudo chmod a+r /etc/apt/keyrings/docker.asc
    sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
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
  sudo systemctl enable --now docker >/dev/null 2>&1 || warn "could not enable docker.service"
  id -nG | grep -qw docker || sudo usermod -aG docker "$USER"
  ok "$(docker --version)"
}

step_claude() {
  step "Claude Code"
  curl -fsSL https://claude.ai/install.sh | bash
  ensure_path_line "$HOME/.local/bin"
  ok "claude $(claude --version 2>/dev/null || echo installed)"
}

step_grok() {
  step "Grok CLI"
  curl -fsSL https://x.ai/cli/install.sh | bash
  ensure_path_line "$HOME/.local/bin"
  ok "grok $(grok --version 2>/dev/null || echo installed)"
}

step_codex() {
  step "Codex CLI"
  curl -fsSL https://chatgpt.com/codex/install.sh | sh
  ensure_path_line "$HOME/.local/bin"
  ok "codex $(codex --version 2>/dev/null || echo installed)"
}

step_t3() {
  step "t3"
  sudo npm install -g t3@latest >/dev/null
  ok "t3 $(t3 --version 2>/dev/null || echo installed)"
}

install_gh() {
  command -v gh >/dev/null && return
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
  sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  apt_update
  apt_install gh
  ok "gh $(gh --version | head -1 | awk '{print $3}')"
}

install_glab() {
  command -v glab >/dev/null && return
  local ver deb tmp
  ver="$(curl -fsSL 'https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/releases/permalink/latest' 2>/dev/null \
         | jq -r '.tag_name' 2>/dev/null | sed 's/^v//')" || true
  [[ -z "$ver" || "$ver" == "null" ]] && ver="$GLAB_FALLBACK_VERSION"
  deb="glab_${ver}_linux_${ARCH}.deb"
  tmp="$(mktemp -d)"
  curl -fsSL "https://gitlab.com/gitlab-org/cli/-/releases/v${ver}/downloads/${deb}" -o "$tmp/$deb" \
    || die "Could not download glab ${ver} for ${ARCH}."
  sudo dpkg -i "$tmp/$deb" >/dev/null
  rm -rf "$tmp"
  ok "glab ${ver}"
}

git_system_setup() {
  sudo groupadd -f "$CRED_GROUP"
  sudo touch "$CRED_FILE"
  sudo chown "root:$CRED_GROUP" "$CRED_FILE"
  sudo chmod 0640 "$CRED_FILE"
  id -nG | grep -qw "$CRED_GROUP" || sudo usermod -aG "$CRED_GROUP" "$USER"
  sudo git config --system --unset-all credential.helper 2>/dev/null || true
  sudo git config --system credential.helper "store --file=${CRED_FILE}"
  sudo git config --system core.askPass ""
  sudo git config --system safe.directory '*'
  printf 'export GIT_TERMINAL_PROMPT=0\nexport GIT_ASKPASS=\n' | sudo tee /etc/profile.d/git-noprompt.sh >/dev/null
}

store_git_credential() {
  local host="$1" user="$2" tok="$3"
  printf 'protocol=https\nhost=%s\nusername=%s\n' "$host" "$user" \
    | sudo git credential-store --file "$CRED_FILE" erase 2>/dev/null || true
  printf 'protocol=https\nhost=%s\nusername=%s\npassword=%s\n' "$host" "$user" "$tok" \
    | sudo git credential-store --file "$CRED_FILE" store
  sudo chown "root:$CRED_GROUP" "$CRED_FILE"; sudo chmod 0640 "$CRED_FILE"
}

agent_git_check() {
  env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/nonexistent GIT_TERMINAL_PROMPT=0 \
      git ls-remote "$1" HEAD >/dev/null 2>&1
}

verify_host() {
  local host="$1" url="$2"
  [[ -n "$url" ]] || { warn "$host: no repo on this account to test with"; return; }
  if agent_git_check "$url"; then ok "$host: agent-mode git works → $url"
  else fail "$host: agent-mode git FAILED for $url (token scopes?)"; fi
}

login_github_account() {
  echo
  printf '  %sGitHub account%s\n' "$C_BOLD" "$C_RESET"
  local method
  method="$(choose "Login method" \
      "Browser / device code" \
      "Personal access token (classic: repo + workflow; fine-grained: contents:rw)")"
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
  ok "GitHub: $user"
  verify_host github.com "$(gh repo list "$user" --limit 1 --json url --jq '.[0].url' 2>/dev/null || true)"
}

login_gitlab_account() {
  echo
  printf '  %sGitLab account%s\n' "$C_BOLD" "$C_RESET"
  local host
  host="$(ask "GitLab host" "gitlab.com")"
  host="${host#https://}"; host="${host#http://}"; host="${host%%/*}"
  [[ -z "$host" ]] && return 0
  local method
  method="$(choose "Login method for $host" \
      "Device code (gitlab.com; self-hosted needs GitLab 17.9+ and an OAuth client_id)" \
      "Browser / web" \
      "Personal access token (scopes: api, read_repository, write_repository)")"
  case "$method" in
    1) glab auth login --hostname "$host" --git-protocol https --insecure-storage --device </dev/tty \
         || { warn "device flow failed — use a token instead"; return 0; } ;;
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
  [[ -z "$user" || -z "$tok" ]] && { fail "could not read user/token back from glab"; return 0; }
  store_git_credential "$host" "$user" "$tok"
  ok "GitLab $host: $user"
  verify_host "$host" "$(GITLAB_HOST="$host" glab api 'projects?membership=true&per_page=1&order_by=last_activity_at' 2>/dev/null \
                         | jq -r '.[0].http_url_to_repo // empty' || true)"
}

account_status() {
  echo
  printf '  %sStored credentials (%s)%s\n' "$C_DIM" "$CRED_FILE" "$C_RESET"
  if sudo test -s "$CRED_FILE"; then
    sudo sed -E 's#^https://([^:]+):[^@]*@(.+)$#    \2  (\1)#' "$CRED_FILE"
  else
    printf '    %s(none)%s\n' "$C_DIM" "$C_RESET"
  fi
}

account_hub() {
  while true; do
    account_status
    echo
    local c
    c="$(choose "Accounts" "Add GitHub account" "Add GitLab account" "Done")"
    case "$c" in
      1) login_github_account ;;
      2) login_gitlab_account ;;
      3) break ;;
    esac
  done
}

step_git() {
  step "Git, gh, glab + accounts"
  install_gh
  install_glab
  git_system_setup

  local name mail
  echo
  name="$(ask "git user.name"  "$(git config --global user.name  || true)")"
  mail="$(ask "git user.email" "$(git config --global user.email || true)")"
  git config --global user.name  "$name";  sudo git config --system user.name  "$name"
  git config --global user.email "$mail";  sudo git config --system user.email "$mail"

  account_hub

  if command -v t3 >/dev/null; then
    echo
    printf '  %st3 connect%s\n' "$C_BOLD" "$C_RESET"
    t3 connect </dev/tty || warn "t3 connect did not finish — run later: t3 connect"
  else
    warn "t3 not installed — run 't3 connect' after installing it"
  fi
}

step_remind() {
  step "Final steps"
  cat <<EOF

  ${C_BOLD}su - ${AGENT_USER}${C_RESET}            (no password)
  ${C_BOLD}claude${C_RESET}  → /login        ${C_BOLD}codex login${C_RESET}        ${C_BOLD}grok${C_RESET}

  ${C_DIM}add accounts later:  bash $AGENT_SCRIPT --only git${C_RESET}
EOF
}

usage() {
  cat <<EOF
Usage: bash vm-bootstrap.sh [--only a,b] [--skip a,b] [--list]

Run as root. Creates user "${AGENT_USER}" (no login password, NOPASSWD sudo)
and re-executes itself as that user; every step runs as ${AGENT_USER}.
Steps: ${ALL_STEPS[*]}
Env:   AGENT_USER (default agent), NODE_MAJOR (default 26)
EOF
}

ORIG_ARGS=("$@")
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

[[ -r /etc/os-release ]] || die "Unsupported OS: /etc/os-release missing."
. /etc/os-release
DISTRO_ID="${ID:-debian}"
DISTRO_CODENAME="${VERSION_CODENAME:-}"
ARCH="$(dpkg --print-architecture)"

if [[ "$(id -un)" != "$AGENT_USER" ]]; then
  [[ $EUID -eq 0 ]] || die "Run as root."
  create_agent_user
  reexec_as_agent "${ORIG_ARGS[@]}"
fi
export DEBIAN_FRONTEND=noninteractive

in_list() { [[ ",$2," == *",$1,"* ]]; }
RUN=()
for s in "${ALL_STEPS[@]}"; do
  if [[ -n "$ONLY" ]]; then in_list "$s" "$ONLY" && RUN+=("$s"); continue; fi
  in_list "$s" "$SKIP" || RUN+=("$s")
done
[[ ${#RUN[@]} -gt 0 ]] || die "nothing to run"

STEP_TOTAL=${#RUN[@]}
for s in "${RUN[@]}"; do "step_$s"; done
printf '\n%s%sDone.%s\n' "$C_BOLD" "$C_GREEN" "$C_RESET"
