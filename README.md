# wt — Interactive Git Worktree Switcher

A terminal tool for navigating git worktrees across multiple repositories using [fzf](https://github.com/junegunn/fzf).

## Features

- **Interactive fuzzy picker** — browse all worktrees across all repos with fzf
- **Live refresh** — the list updates automatically when worktrees are created or removed (via `fs.watch`, no polling)
- **Repo filtering** — `wt frontend` shows only worktrees for repos matching that prefix
- **Color-coded output** — repo names (cyan), branches (green), directories (magenta), base repos (dim + yellow tag)
- **Active worktree highlight** — the worktree matching your current directory is marked with a bold `▸`
- **Sorted by recency** — worktrees with the most recent activity appear first
- **Per-repo commands** — configure commands (e.g. `pnpm i && pnpm start`) that run automatically after switching
- **Worktree deletion** — delete worktrees from the picker with confirmation
- **Cleanup mode** — `Ctrl-X` opens a "red alert" cleanup view that flags each worktree as merged / upstream-gone / dirty / unmerged, with age; multi-select and bulk-remove stale worktrees, sweep all safe ones at once, and filter by status
- **Interactive config editor** — `wt -config` lets you browse repos and set commands via a TUI
- **Zero dependencies** — only Node.js builtins + fzf

## Prerequisites

- **Node.js** >= 18
- **[fzf](https://github.com/junegunn/fzf)** >= 0.50
- **Git** with worktree support

## Install

### npm (global)

```bash
npm install -g worktree-mngr
```

### Manual (clone + link)

```bash
git clone https://github.com/MatejBosnjak/worktree-mngr.git
cd worktree-mngr
npm link
```

## Setup

### 1. Shell integration

Add one line to `~/.zshrc` (or `~/.bashrc`):

```bash
# After npm install -g:
source "$(npm root -g)/worktree-mngr/wt.sh"

# Or with a direct path:
source "/path/to/wt/wt.sh"
```

### 2. Initialize config

Navigate to your workspace root and run:

```bash
wt -init
```

This creates a `.wtrc.json` that tells `wt` where your repos and worktrees live:

```json
{
  "reposDir": "./repos",
  "worktreesDir": "./worktrees",
  "commands": {}
}
```

Paths are relative to the `.wtrc.json` location. The config is discovered by walking up from your current directory (like `.eslintrc`).

Both `reposDir` and `worktreesDir` accept a string or an array — useful when repos and worktrees are spread across multiple directories:

```json
{
  "reposDir": ["./work/repos", "./repos"],
  "worktreesDir": ["./work/worktrees", "./worktrees"],
  "commands": {}
}
```

### 3. Directory structure

```
workspace/
├── .wtrc.json       # created by wt -init
├── repos/           # git checkouts
│   ├── frontend/
│   ├── api/
│   └── ...
└── worktrees/       # where git worktree add places new worktrees
```

### 4. Configure per-repo commands (optional)

```bash
wt -config
```

Or edit `.wtrc.json` directly:

```json
{
  "reposDir": "./repos",
  "worktreesDir": "./worktrees",
  "commands": {
    "frontend": "pnpm i && pnpm start",
    "api": "bundle install && rails s"
  }
}
```

## Usage

| Command | Description |
|---|---|
| `wt` | Show all worktrees across all repos |
| `wt frontend` | Show only worktrees for repos starting with "frontend" |
| `wt -config` | Open the interactive config editor |
| `wt -init` | Create `.wtrc.json` in current directory |

### Inside the picker

| Key | Action |
|---|---|
| Type | Fuzzy filter the list |
| `Enter` | Select worktree, cd into it, and run configured command |
| `Ctrl-O` | Select worktree and cd without running the command |
| `Backspace` | Delete the highlighted worktree (with confirmation) |
| `Ctrl-X` | Enter **cleanup mode** (see below) |
| `Ctrl-R` | Force refresh the list |
| `Esc` | Cancel |

### Cleanup mode (`Ctrl-X`)

Cleanup mode turns the picker into a "red alert" view for pruning stale worktrees. Every worktree is scanned and badged by status, sorted safest-and-oldest first:

| Badge | Meaning |
|---|---|
| `✓ merged` | Branch is merged into the repo's default branch — safe to remove |
| `⬆ gone` | The branch's upstream was deleted (PR merged, incl. squash/rebase) — safe to remove. Reflects the last `Ctrl-F` refresh |
| `● dirty` | Uncommitted/untracked changes — removing loses that work (needs an extra confirm) |
| `⚠ unmerged` | Not merged and upstream still present — the branch is kept when you remove the worktree, so commits aren't lost |

Detection is fast (a single `git branch --merged` + `git for-each-ref` per repo; the per-worktree dirty scan runs in parallel and lazily, so the list appears in ~1s and dirty fills in after). Entering cleanup runs `git worktree prune` first to drop stale metadata.

| Key | Action |
|---|---|
| `Tab` | Mark / unmark a worktree |
| `Ctrl-A` | Select all |
| `Enter` | Remove marked worktrees (or the focused one) with a summary confirm; dirty ones need a separate force confirm |
| `Ctrl-D` | Remove the focused worktree |
| `Ctrl-G` | **Sweep** — remove every merged/gone clean worktree in the current tab's scope (one repo, or all repos on the `ALL` tab) |
| `Ctrl-S` | Cycle the status filter (`All → Safe → Merged → Gone → Dirty → Unmerged`) |
| `⌥1`–`⌥5` / `⌥0` | Jump the filter to merged / gone / dirty / unmerged / safe / all |
| `Ctrl-F` | Fetch `--prune` across repos so `⬆ gone` is accurate |
| `?` | Show the badge + key guide |
| `◀ ▶` | Switch repo tab (the status filter persists) |
| `Ctrl-X` | Exit cleanup mode |

**Safe** = merged/gone **and** clean — the set `Ctrl-G` sweeps. The status filter persists across tab switches; the footer always shows the total per-status counts.

### Config editor (`wt -config`)

| Key | Action |
|---|---|
| `Enter` | Select repo to edit its command |
| `Esc` (in repo list) | Exit config editor |
| `Esc` (in command input) | Go back to repo list |
| `Enter` (in command input) | Save command (empty input removes it) |

## How live refresh works

When the fzf picker is open, a background Node process watches:

- `repos/*/.git/worktrees/` — git's internal worktree metadata directories
- `worktrees/` — the directory where worktree checkouts live

Watching is non-recursive (only reacts to direct child additions/removals) and uses `fs.watch()` (FSEvents on macOS, inotify on Linux). When a change is detected, it posts a reload command to fzf's `--listen` HTTP API. The watcher exits automatically when fzf closes.
