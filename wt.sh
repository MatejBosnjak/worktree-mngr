# wt — Interactive git worktree switcher
# Source from ~/.zshrc or ~/.bashrc:
#   source "/path/to/wt.sh"
#   or after npm install -g: source "$(npm root -g)/worktree-mngr/wt.sh"

wt() {
  if [ "$1" = "-config" ]; then
    worktrees --config
    return
  fi
  if [ "$1" = "-init" ]; then
    worktrees --init
    return
  fi

  local result
  if [ -n "$1" ]; then
    result=$(worktrees --filter "$1" 2>/dev/null)
  else
    result=$(worktrees 2>/dev/null)
  fi
  [ -z "$result" ] && return

  local dir=$(echo "$result" | cut -f1)
  local repo=$(echo "$result" | cut -f2)
  local skip=$(echo "$result" | cut -f3)
  cd "$dir" || return

  # Run per-repo command (skip on Ctrl-O)
  if [ "$skip" = "skip" ]; then return; fi
  if [ -n "$repo" ]; then
    local cmd=$(worktrees --get-command "$repo" 2>/dev/null)
    if [ -n "$cmd" ]; then
      echo "\x1b[2mRunning: $cmd\x1b[0m"
      eval "$cmd"
    fi
  fi
}
