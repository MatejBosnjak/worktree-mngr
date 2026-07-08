#!/usr/bin/env node

/**
 * wt — Interactive git worktree switcher.
 * Scans repos for worktrees and lets you pick one via fzf.
 *
 * Usage:
 *   worktrees                    # interactive fzf picker
 *   worktrees --filter frontend  # only frontend worktrees
 *   worktrees --list             # plain list, no fzf
 *   worktrees --config           # edit per-repo commands
 *   worktrees --init             # create .wtrc.json in current dir
 *   worktrees --get-command repo # print configured command for a repo
 *
 * Shell integration (add to ~/.zshrc):
 *   source "/path/to/wt.sh"
 */

import { execSync, exec, spawn } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, renameSync, statSync, watch, existsSync, unlinkSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { tmpdir } from 'node:os';

// --- Path constants ---
const SCRIPT_PATH = new URL(import.meta.url).pathname;

// --- Arg parsing ---
const listOnly = process.argv.includes('--list');
const listFzf = process.argv.includes('--list-fzf');
const watchMode = process.argv.includes('--watch');
const configMode = process.argv.includes('--config');
const initMode = process.argv.includes('--init');
const filterIdx = process.argv.indexOf('--filter');
const repoFilter = filterIdx !== -1 ? process.argv[filterIdx + 1] : null;
const cwdIdx = process.argv.indexOf('--cwd');
const activeCwd = cwdIdx !== -1 ? process.argv[cwdIdx + 1] : process.cwd();
const getCommandIdx = process.argv.indexOf('--get-command');
const cycleTabIdx = process.argv.indexOf('--cycle-tab');
const tabFileIdx = process.argv.indexOf('--tab-file');
const tabFile = tabFileIdx !== -1 ? process.argv[tabFileIdx + 1] : null;
const listConfigMode = process.argv.includes('--list-config');
const editCommandIdx = process.argv.indexOf('--edit-command');
const handleEnterMode = process.argv.includes('--handle-enter');
const handleDeleteMode = process.argv.includes('--handle-delete');
const handleSkipMode = process.argv.includes('--handle-skip');
const handleCodeMode = process.argv.includes('--handle-code');
const cleanupMode = process.argv.includes('--cleanup');
const toggleCleanupMode = process.argv.includes('--toggle-cleanup');
const handleHelpMode = process.argv.includes('--handle-help');
const cleanupHelpMode = process.argv.includes('--cleanup-help');
const handleFetchMode = process.argv.includes('--handle-fetch');
const fetchPruneMode = process.argv.includes('--fetch-prune');
const bulkDeleteMode = process.argv.includes('--bulk-delete');
const handleSweepMode = process.argv.includes('--handle-sweep');
const spinnerMode = process.argv.includes('--spinner');
const handleLoadMode = process.argv.includes('--handle-load');
const handleStatusIdx = process.argv.indexOf('--handle-status');

// --- ANSI color helpers ---
const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  white: '\x1b[37m',
  red: '\x1b[31m',
  bgCyan: '\x1b[46m',
  bgRed: '\x1b[41m',
  black: '\x1b[30m',
  blue: '\x1b[34m',
};

// Soft reset: turn off bold/dim/underline and reset foreground, but DO NOT
// reset the background (SGR 49). Used for cleanup rows so fzf's selected-bg /
// current-bg line highlight fills the whole row instead of being wiped by a
// full `\x1b[0m` reset partway through.
const SR = '\x1b[22;24;39m';

// Don't show a loader (body spinner / dirty shimmer) unless a load stage runs
// longer than this — avoids a flash on fast tabs/scans.
const LOADER_DELAY_MS = 500;

// Status filter chips (cleanup mode). value -> {label, match(entry)}.
const STATUS_FILTERS = [
  { value: 'all', label: 'All', match: () => true },
  { value: 'safe', label: 'Safe', match: (e) => (e.merged || e.gone) && !e.dirty },
  { value: 'merged', label: 'Merged', match: (e) => e.merged },
  { value: 'gone', label: 'Gone', match: (e) => e.gone },
  { value: 'dirty', label: 'Dirty', match: (e) => e.dirty },
  { value: 'unmerged', label: 'Unmerged', match: (e) => !e.merged && !e.gone && !e.dirty },
];
const STATUS_ORDER = STATUS_FILTERS.map((f) => f.value);

// Rainbow palette (256-color) used to give each repo tab a distinct hue in the
// navigation bar. Cycles if there are more repos than colors.
const RAINBOW = [
  '\x1b[38;5;203m', // red
  '\x1b[38;5;215m', // orange
  '\x1b[38;5;221m', // yellow
  '\x1b[38;5;114m', // green
  '\x1b[38;5;80m',  // teal
  '\x1b[38;5;75m',  // blue
  '\x1b[38;5;141m', // purple
  '\x1b[38;5;211m', // pink
];

// Shared cleanup-mode key hints (footer line 2).
function cleanupHints() {
  return `${c.cyan}Tab${c.reset} ${c.dim}mark${c.reset}  ${c.red}Enter${c.reset} ${c.dim}remove${c.reset}  ${c.green}${c.bold}Ctrl-G${c.reset} ${c.dim}sweep safe${c.reset}  ${c.yellow}Ctrl-F${c.reset} ${c.dim}refresh${c.reset}  ${c.cyan}?${c.reset} ${c.dim}help${c.reset}  ${c.yellow}Ctrl-X${c.reset} ${c.dim}exit${c.reset}`;
}

// --- Config discovery ---
// Walks up from cwd to find .wtrc.json, falls back to ~/.wtrc.json
function findConfigPath() {
  let dir = process.cwd();
  const home = homedir();
  while (true) {
    const candidate = join(dir, '.wtrc.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break; // reached root
    dir = parent;
  }
  // Global fallback
  const global = join(home, '.wtrc.json');
  if (existsSync(global)) return global;
  return null;
}

function loadConfigFile(configPath) {
  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  const base = dirname(configPath);
  const rawRepoDirs = raw.reposDir || './repos';
  const reposDirs = (Array.isArray(rawRepoDirs) ? rawRepoDirs : [rawRepoDirs]).map((d) => resolve(base, d));
  const rawWtDirs = raw.worktreesDir || './worktrees';
  const worktreesDirs = (Array.isArray(rawWtDirs) ? rawWtDirs : [rawWtDirs]).map((d) => resolve(base, d));
  return {
    reposDir: reposDirs[0],
    reposDirs,
    worktreesDir: worktreesDirs[0],
    worktreesDirs,
    configPath,
    commands: raw.commands || {},
  };
}

function saveCommands(configPath, commands) {
  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  raw.commands = commands;
  writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n');
}

// --- Raw stdin prompt (Esc to cancel, Enter to confirm) ---
function rawPrompt(question) {
  return new Promise((resolve, reject) => {
    process.stderr.write(question);
    let buf = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');

    const onData = (key) => {
      if (key === '\x1b') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.stderr.write('\n');
        reject();
      } else if (key === '\r' || key === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.stderr.write('\n');
        resolve(buf);
      } else if (key === '\x7f' || key === '\b') {
        if (buf.length > 0) {
          buf = buf.slice(0, -1);
          process.stderr.write('\b \b');
        }
      } else if (key >= ' ') {
        buf += key;
        process.stderr.write(key);
      }
    };

    process.stdin.on('data', onData);
  });
}

// --- --init: create .wtrc.json ---
if (initMode) {
  const target = join(process.cwd(), '.wtrc.json');
  if (existsSync(target)) {
    process.stderr.write(`${c.yellow}.wtrc.json already exists in this directory.${c.reset}\n`);
    process.exit(1);
  }

  process.stderr.write(`${c.cyan}Creating .wtrc.json in ${process.cwd()}${c.reset}\n\n`);

  let reposDir, worktreesDir;
  try {
    reposDir = await rawPrompt(`${c.dim}Repos directory (relative):${c.reset} `);
    worktreesDir = await rawPrompt(`${c.dim}Worktrees directory (relative):${c.reset} `);
  } catch {
    process.stderr.write(`${c.dim}Cancelled.${c.reset}\n`);
    process.exit(0);
  }

  const config = {
    reposDir: reposDir || './repos',
    worktreesDir: worktreesDir || './worktrees',
    commands: {},
  };

  writeFileSync(target, JSON.stringify(config, null, 2) + '\n');
  process.stderr.write(`\n${c.green}Wrote .wtrc.json${c.reset}\n`);

  const resolvedRepos = resolve(process.cwd(), config.reposDir);
  const resolvedWt = resolve(process.cwd(), config.worktreesDir);
  if (!existsSync(resolvedRepos)) {
    process.stderr.write(`${c.yellow}Warning: ${config.reposDir} does not exist yet${c.reset}\n`);
  }
  if (!existsSync(resolvedWt)) {
    process.stderr.write(`${c.yellow}Warning: ${config.worktreesDir} does not exist yet${c.reset}\n`);
  }

  process.exit(0);
}

// --- Load config (required for all other commands) ---
const configPath = findConfigPath();
if (!configPath) {
  process.stderr.write(
    `${c.yellow}No .wtrc.json found.${c.reset}\n` +
    `Run ${c.cyan}worktrees --init${c.reset} in your workspace root to create one.\n`,
  );
  process.exit(1);
}

const cfg = loadConfigFile(configPath);
const REPOS_DIR = cfg.reposDir;
const REPOS_DIRS = cfg.reposDirs;
const WORKTREES_DIR = cfg.worktreesDir;

function getAllRepos() {
  const repos = [];
  for (const dir of REPOS_DIRS) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      const repoPath = join(dir, name);
      if (statSync(repoPath).isDirectory() && isGitRepo(repoPath)) {
        repos.push({ name, repoPath });
      }
    }
  }
  return repos;
}

// --- --get-command: print command for a repo ---
if (getCommandIdx !== -1) {
  const repo = process.argv[getCommandIdx + 1];
  const cmd = cfg.commands?.[repo];
  if (cmd) process.stdout.write(cmd);
  process.exit(0);
}

// --- --preview-command: formatted command preview for fzf footer ---
const previewCmdIdx = process.argv.indexOf('--preview-command');
if (previewCmdIdx !== -1) {
  const repo = process.argv[previewCmdIdx + 1];
  const ctxIdx = process.argv.indexOf('--context');
  const ctx = ctxIdx !== -1 ? process.argv[ctxIdx + 1] : null;
  const isConfig = ctx === 'CONFIG';

  // Cleanup mode: live counts (from the list writer's cache — free) + selection
  // tally, plus bulk-remove hints, instead of the per-repo command preview.
  if (tabFile && readState(tabFile).cleanup && !isConfig) {
    const { pending } = readState(tabFile);
    let counts = null;
    try { counts = JSON.parse(readFileSync(`${tabFile}.counts`, 'utf-8')); } catch {}
    const sel = parseInt(process.env.FZF_SELECT_COUNT || '', 10) || 0;
    const sep = `  ${c.dim}·${c.reset}  `;
    const selTag = sel > 0 ? `     ${c.bgRed}${c.bold}${c.white} ${sel} selected ${c.reset}` : '';
    // Stage 5 = dirty scan has outlasted the delay -> static "scanning dirty"
    // label (fzf's own braille spinner in the info line supplies the motion).
    // No per-frame re-render, so no flicker. Otherwise show the real count.
    const dirtySeg = pending === 5
      ? `${c.dim}⟳ scanning dirty…${c.reset}`
      : counts
        ? `${c.red}${counts.dirty} dirty${c.reset}`
        : '';
    const head = counts
      ? `${c.green}${counts.removable} merged/gone${c.reset}${sep}${c.yellow}${counts.unmerged} unmerged${c.reset}${sep}`
      : '';
    const countLine = counts || pending === 5 ? `${head}${dirtySeg}${selTag}` : `${c.dim}scanning…${c.reset}`;
    process.stdout.write(`${countLine}\n${cleanupHints()}`);
    process.exit(0);
  }

  if (isConfig) {
    const cmd = cfg.commands?.[repo];
    const cmdLine = cmd
      ? `${c.yellow}\u25b6 ${cmd}${c.reset}`
      : `${c.dim}no command configured${c.reset}`;
    const hints = `${c.cyan}Enter${c.reset} ${c.dim}edit${c.reset}`;
    process.stdout.write(`${cmdLine}\n${hints}`);
  } else {
    const cmd = cfg.commands?.[repo];
    const cmdLine = cmd
      ? `${c.yellow}\u25b6 ${cmd}${c.reset}`
      : `${c.dim}no command configured${c.reset}`;
    const hints = `${c.cyan}Enter${c.reset} ${c.dim}open${c.reset}  ${c.green}Ctrl-O${c.reset} ${c.dim}skip cmd${c.reset}  ${c.blue}Ctrl-E${c.reset} ${c.dim}code .${c.reset}  ${c.magenta}Ctrl-D${c.reset} ${c.dim}delete${c.reset}  ${c.red}${c.bold}Ctrl-X${c.reset} ${c.red}cleanup${c.reset}`;
    process.stdout.write(`${cmdLine}\n${hints}`);
  }
  process.exit(0);
}

const CONFIG_TAB = '\u2699 config';

// --- --list-config: repo list for config tab ---
if (listConfigMode) {
  for (const name of getRepoNames()) {
    const cmd = cfg.commands?.[name];
    const cmdDisplay = cmd
      ? `${c.green}${cmd}${c.reset}`
      : `${c.dim}(no command)${c.reset}`;
    console.log(`  ${c.cyan}${name.padEnd(18)}${c.reset} ${cmdDisplay}\tCONFIG\t${name}`);
  }
  process.exit(0);
}

// --- --edit-command: inline command editor for a repo ---
if (editCommandIdx !== -1) {
  const repo = process.argv[editCommandIdx + 1];
  const currentCmd = cfg.commands?.[repo] || '';
  process.stderr.write(
    `\n${c.cyan}${repo}${c.reset} — current: ${currentCmd ? `${c.green}${currentCmd}${c.reset}` : `${c.dim}(none)${c.reset}`}\n`,
  );
  process.stderr.write(`${c.dim}Enter new command (empty to remove, Esc to cancel):${c.reset}\n`);

  let answer;
  try {
    answer = await rawPrompt(`${c.yellow}> ${c.reset}`);
  } catch {
    process.stderr.write(`${c.dim}Cancelled.${c.reset}\n`);
    process.exit(0);
  }

  const trimmed = answer.trim();
  const commands = { ...cfg.commands };
  if (trimmed) {
    commands[repo] = trimmed;
  } else {
    delete commands[repo];
  }
  saveCommands(configPath, commands);
  process.stderr.write(
    trimmed
      ? `${c.green}Saved: ${repo} → ${trimmed}${c.reset}\n`
      : `${c.dim}Removed command for ${repo}${c.reset}\n`,
  );
  process.exit(0);
}

// --- --handle-delete: transform action for Ctrl-D (skip on config tab) ---
if (handleDeleteMode && tabFile) {
  const tabs = tabList();
  const { idx, cleanup } = readState(tabFile);

  if (tabs[idx] === CONFIG_TAB) {
    // Config mode: no-op
    process.stdout.write('');
  } else if (cleanup) {
    // Re-enter the lazy load after removal (spinner -> fast -> dirty).
    writeState(tabFile, { idx, cleanup: true, pending: 1 });
    process.stdout.write(
      `execute(node '${SCRIPT_PATH}' --delete {2})+reload(${buildListReload(idx, true, false)})+refresh-preview`,
    );
  } else {
    process.stdout.write(
      `execute(node '${SCRIPT_PATH}' --delete {2})+reload(${buildListReload(idx, false)})+refresh-preview`,
    );
  }
  process.exit(0);
}

// --- --handle-skip: transform action for Ctrl-O (no-op on config tab) ---
if (handleSkipMode && tabFile) {
  const tabs = ['ALL', ...getRepoNames(), CONFIG_TAB];
  let idx = 0;
  try { idx = parseInt(readFileSync(tabFile, 'utf-8').trim(), 10) || 0; } catch {}

  if (tabs[idx] !== CONFIG_TAB) {
    process.stdout.write('become(printf "SKIP\\t%s\\t%s" {2} {3})');
  }
  process.exit(0);
}

// --- --handle-code: transform action for Ctrl-. (open VS Code, no-op on config tab) ---
if (handleCodeMode && tabFile) {
  const tabs = ['ALL', ...getRepoNames(), CONFIG_TAB];
  let idx = 0;
  try { idx = parseInt(readFileSync(tabFile, 'utf-8').trim(), 10) || 0; } catch {}

  if (tabs[idx] !== CONFIG_TAB) {
    process.stdout.write('become(printf "CODE\\t%s\\t%s" {2} {3})');
  }
  process.exit(0);
}

// --- --handle-enter: transform action based on current tab / mode ---
if (handleEnterMode && tabFile) {
  const tabs = tabList();
  const { idx, cleanup } = readState(tabFile);

  if (cleanup && tabs[idx] !== CONFIG_TAB) {
    // Cleanup mode: bulk-remove the selected worktrees (or focused row).
    // Selected paths are passed after a '--' separator via fzf's {+2}.
    const sep = process.argv.indexOf('--');
    const paths = sep !== -1 ? process.argv.slice(sep + 1).filter(Boolean) : [];
    if (paths.length === 0) {
      process.stdout.write('');
      process.exit(0);
    }
    const quoted = paths.map((p) => `'${p.replace(/'/g, "'\\''")}'`).join(' ');
    // After removal, re-enter the lazy load (spinner -> fast -> dirty) so the
    // refreshed list appears instantly and dirty badges come back on their own.
    writeState(tabFile, { idx, cleanup: true, pending: 1 });
    process.stdout.write(
      `execute(node '${SCRIPT_PATH}' --bulk-delete -- ${quoted})+reload(${buildListReload(idx, true, false)})+refresh-preview`,
    );
  } else if (tabs[idx] === CONFIG_TAB) {
    // Config mode: edit command, then reload config list
    const listConfigCmd = `node '${SCRIPT_PATH}' --list-config`;
    process.stdout.write(
      `execute(node '${SCRIPT_PATH}' --edit-command {3})+reload(${listConfigCmd})`,
    );
  } else {
    // Normal mode: accept selection
    process.stdout.write('accept');
  }
  process.exit(0);
}

// --- Repo list helper (for tabs) ---
function getRepoNames() {
  const seen = new Set();
  return getAllRepos()
    .map(({ name }) => name)
    .filter((name) => {
      if (seen.has(name)) return false;
      seen.add(name);
      return true;
    });
}

// --- Tab bar renderer ---
// In cleanup mode a full-width red "danger bar" sits on its own line above the
// tab bar, and the picker's accent shifts cyan -> red (active tab, ◀ ▶) so the
// whole UI reads "red alert". The banner never pushes the tabs sideways.
function renderTabBar(tabs, activeIdx, cleanup = false, filter = 'all') {
  const isConfig = (t) => t.includes('config');
  const parts = tabs.map((t, i) => {
    if (i === activeIdx) {
      return cleanup
        ? `${c.bgRed}${c.bold}${c.white} ${t} ${c.reset}`
        : `${c.bgCyan}${c.bold}${c.black} ${t} ${c.reset}`;
    }
    if (t === 'ALL') return `${c.bold}${c.white} ${t} ${c.reset}`;
    if (isConfig(t)) return `${c.yellow} ${t} ${c.reset}`;
    // Repo tabs: each gets a distinct rainbow hue (index 0 is the ALL tab).
    return `${RAINBOW[(i - 1) % RAINBOW.length]} ${t} ${c.reset}`;
  });
  const bar = parts.join(`${c.dim}│${c.reset}`);
  const navColor = cleanup ? c.red : c.yellow;
  const nav = `  ${navColor}◀ ▶${c.reset} ${c.dim}tabs${c.reset}`;
  const tabLine = `${bar}${nav}`;
  if (!cleanup) return tabLine;

  const selectedTab = tabs[activeIdx] || 'ALL';
  const scope = isConfig(selectedTab) ? 'config' : selectedTab === 'ALL' ? 'all repos' : selectedTab;
  // Plain text (no inline ANSI) so the width math for the full-width bar is exact.
  const left = `  CLEANUP MODE     scope: ${scope}`;
  const right = `?  help      Ctrl-X  exit  `;
  const width = parseInt(process.env.FZF_COLUMNS || '', 10) || 0;
  const mid = width ? ' '.repeat(Math.max(2, width - left.length - right.length)) : '   ';
  const banner = `${c.bgRed}${c.bold}${c.white}${left}${mid}${right}${c.reset}`;
  return `${banner}\n${tabLine}\n${renderFilterChips(filter)}`;
}

// Status filter chip row (cleanup mode, line 3). Active chip is highlighted;
// safe/merged/gone read green, dirty/unmerged red, All neutral.
function renderFilterChips(active) {
  const color = (v) => (v === 'dirty' || v === 'unmerged' ? c.red : v === 'all' ? c.white : c.green);
  const chips = STATUS_FILTERS.map((f) => {
    if (f.value === active) return `${c.bgCyan}${c.bold}${c.black} ${f.label} ${c.reset}`;
    return `${c.dim}${color(f.value)}${f.label}${c.reset}`;
  }).join('  ');
  return `${c.dim}filter${c.reset}  ${chips}   ${c.yellow}Ctrl-S${c.reset} ${c.dim}cycle${c.reset} ${c.dim}·${c.reset} ${c.yellow}⌥1-5${c.reset} ${c.dim}jump${c.reset}`;
}

// --- Reload command / header builders (tab + cleanup aware) ---
function tabList() {
  return ['ALL', ...getRepoNames(), CONFIG_TAB];
}

function buildListReload(idx, cleanup, withDirty = false) {
  const tabs = tabList();
  const selectedTab = tabs[idx] || 'ALL';
  if (selectedTab === CONFIG_TAB) return `node '${SCRIPT_PATH}' --list-config`;
  const filterArg = selectedTab === 'ALL' ? '' : ` --filter '${selectedTab}'`;
  const cwdArg = ` --cwd '${activeCwd}'`;
  // In cleanup mode the list writer also caches badge tallies to a counts file
  // that the footer reads — free counts, no extra git calls on tab-switch.
  // --with-dirty adds the (slower) uncommitted-changes scan; the first pass omits
  // it so the list appears instantly, then a background pass enriches it.
  // --status carries the persistent status filter (read from live state).
  let cleanupArg = '';
  if (cleanup) {
    const status = tabFile ? readState(tabFile).filter : 'all';
    cleanupArg = ` --cleanup${withDirty ? ' --with-dirty' : ''} --status '${status}' --counts-file '${tabFile}.counts'`;
  }
  return `node '${SCRIPT_PATH}' --list-fzf${filterArg}${cwdArg}${cleanupArg}`;
}

function buildHeader(idx, cleanup) {
  const filter = tabFile ? readState(tabFile).filter : 'all';
  return renderTabBar(tabList(), idx, cleanup, filter);
}

// Command that prints the loading placeholder for the current scope.
function spinnerReloadCmd(idx) {
  const tabs = tabList();
  const selectedTab = tabs[idx] || 'ALL';
  const scope = selectedTab === 'ALL' ? 'all repos' : selectedTab;
  return `node '${SCRIPT_PATH}' --spinner --scope '${scope}'`;
}

// --- --cycle-tab: advance tab index, output fzf transform actions ---
if (cycleTabIdx !== -1 && tabFile) {
  const direction = process.argv[cycleTabIdx + 1]; // 'right', 'left', or 'init'
  const tabs = tabList();
  const state = readState(tabFile);
  let idx = state.idx;

  if (direction === 'right') idx++;
  else if (direction === 'left') idx--;
  // 'init' — no change

  if (idx < 0) idx = tabs.length - 1;
  if (idx >= tabs.length) idx = 0;

  const header = buildHeader(idx, state.cleanup);

  if (state.cleanup) {
    // Show the spinner instantly; --handle-load swaps in the real list once the
    // (fast) spinner has rendered, so stale rows from the previous tab never show.
    writeState(tabFile, { idx, cleanup: true, pending: 1 });
    process.stdout.write(`reload(${buildListReload(idx, true, false)})+change-header(${header})+refresh-preview`);
  } else {
    writeState(tabFile, { idx, cleanup: false, pending: 0 });
    process.stdout.write(`reload(${buildListReload(idx, false)})+change-header(${header})+refresh-preview`);
  }
  process.exit(0);
}

// --- --toggle-cleanup: flip cleanup mode, prune stale worktrees on entry ---
if (toggleCleanupMode && tabFile) {
  const state = readState(tabFile);
  const nowCleanup = !state.cleanup;
  const header = buildHeader(state.idx, nowCleanup);

  if (nowCleanup) {
    // Bookkeeping-only prune: drops metadata for worktrees whose dir is gone.
    for (const { repoPath } of getAllRepos()) {
      try {
        execSync('git worktree prune', { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch {}
    }
    // Entering cleanup is the slow scan — show the spinner, load real list after.
    writeState(tabFile, { idx: state.idx, cleanup: true, pending: 1 });
    process.stdout.write(`reload(${buildListReload(state.idx, true, false)})+change-header(${header})+refresh-preview`);
  } else {
    writeState(tabFile, { idx: state.idx, cleanup: false, pending: 0 });
    process.stdout.write(`reload(${buildListReload(state.idx, false)})+change-header(${header})+refresh-preview`);
  }
  process.exit(0);
}

// --- --handle-fetch: Ctrl-F refreshes remote state (cleanup mode only) ---
if (handleFetchMode && tabFile) {
  const state = readState(tabFile);
  if (!state.cleanup) { process.stdout.write(''); process.exit(0); }
  // Fetch (shows its own progress), then spinner while the list re-scans.
  writeState(tabFile, { idx: state.idx, cleanup: true, pending: 1 });
  process.stdout.write(
    `execute(node '${SCRIPT_PATH}' --fetch-prune)+reload(${buildListReload(state.idx, true, false)})+refresh-preview`,
  );
  process.exit(0);
}

// --- --fetch-prune: fetch --prune all repos so ⬆ gone is accurate ---
if (fetchPruneMode) {
  const repos = getAllRepos();
  process.stderr.write(`${c.cyan}Refreshing remote state (${repos.length} repos)…${c.reset}\n`);
  for (const { name, repoPath } of repos) {
    process.stderr.write(`${c.dim}  fetch ${name}${c.reset}\r`);
    try {
      execSync('git fetch --prune', { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {}
  }
  process.stderr.write(`${c.green}Done.${c.reset}                    \n`);
  process.exit(0);
}

// --- --handle-sweep: Ctrl-G removes every merged/gone clean worktree in scope ---
// Scope = the repo of the active tab, or ALL repos on the ALL tab.
if (handleSweepMode && tabFile) {
  const state = readState(tabFile);
  const tabs = tabList();
  const selectedTab = tabs[state.idx] || 'ALL';
  if (!state.cleanup || selectedTab === CONFIG_TAB) {
    process.stdout.write('');
    process.exit(0);
  }
  const filterName = selectedTab === 'ALL' ? null : selectedTab;

  // Gather done (merged/gone) candidates cheaply, then check dirty in parallel —
  // and only for those candidates, since only done && !dirty ones get swept.
  const candidates = [];
  for (const { name, repoPath } of getAllRepos()) {
    if (filterName && !name.startsWith(filterName)) continue;
    const defaultBranch = getDefaultBranch(repoPath);
    const refInfo = getRefInfo(repoPath);
    const mergedSet = getMergedSet(repoPath, defaultBranch);
    for (const wt of getWorktrees(repoPath)) {
      if (wt.path === repoPath) continue;
      const branch = wt.branch || '';
      if (!branch || branch === '(detached)') continue;
      const done = mergedSet.has(branch) || (refInfo.get(branch)?.gone ?? false);
      if (done) candidates.push(wt.path);
    }
  }
  const dirtyFlags = await mapPool(candidates, 16, (p) => isDirtyAsync(p));
  const targets = candidates.filter((_, i) => !dirtyFlags[i]);

  const quoted = targets.map((p) => `'${p.replace(/'/g, "'\\''")}'`).join(' ');
  const scope = filterName || 'all repos';
  // Route through --bulk-delete (same confirm/removal path); --sweep-scope only
  // customizes the heading. Re-enter the lazy load afterwards.
  writeState(tabFile, { idx: state.idx, cleanup: true, pending: 1 });
  process.stdout.write(
    `execute(node '${SCRIPT_PATH}' --bulk-delete --sweep-scope '${scope}' -- ${quoted})+reload(${buildListReload(state.idx, true, false)})+refresh-preview`,
  );
  process.exit(0);
}

// --- --handle-status: set/cycle the status filter (Ctrl-S / Alt+digit) ---
if (handleStatusIdx !== -1 && tabFile) {
  const arg = process.argv[handleStatusIdx + 1];
  const st = readState(tabFile);
  if (!st.cleanup) { process.stdout.write(''); process.exit(0); }
  let filter;
  if (arg === 'cycle') {
    filter = STATUS_ORDER[(STATUS_ORDER.indexOf(st.filter) + 1) % STATUS_ORDER.length];
  } else if (STATUS_ORDER.includes(arg)) {
    filter = arg;
  } else {
    process.stdout.write('');
    process.exit(0);
  }
  // Persist the new filter and re-enter the lazy load so the list re-filters.
  writeState(tabFile, { idx: st.idx, cleanup: true, pending: 1, filter });
  const header = buildHeader(st.idx, true);
  process.stdout.write(`reload(${buildListReload(st.idx, true, false)})+change-header(${header})+refresh-preview`);
  process.exit(0);
}

// --- --spinner: loading placeholder shown while a cleanup list rebuilds ---
if (spinnerMode) {
  const scopeIdx = process.argv.indexOf('--scope');
  const scope = scopeIdx !== -1 ? process.argv[scopeIdx + 1] : 'worktrees';
  const lines = [
    '',
    `   ${c.yellow}⣾⣽⣻⢿⡿⣟⣯⣷${c.reset}   ${c.dim}scanning ${c.reset}${c.cyan}${scope}${c.reset}${c.dim} worktrees…${c.reset}`,
    `   ${c.dim}checking merge status & uncommitted changes${c.reset}`,
    '',
  ];
  // Trailing tabs => empty path/repo fields, so the placeholder rows are inert
  // if Enter/Ctrl-D fires on them before the real list arrives.
  for (const l of lines) process.stdout.write(`${l}\t\t\n`);
  process.exit(0);
}

// --- --handle-load: drive the lazy load stages after each reload completes ---
// Stages: 1 = fast list loading, 2 = spinner shown, 3 = fast list loading after
// spinner, 4 = dirty scan. The spinner (stage 2) is inserted by the animator
// only if stage 1 outlasts LOADER_DELAY_MS; otherwise stage 1 finishes and jumps
// straight to the dirty scan (stage 4).
if (handleLoadMode && tabFile) {
  const st = readState(tabFile);
  if (st.pending === 1 || st.pending === 3) {
    // Fast list finished -> start the (slow) dirty scan.
    writeState(tabFile, { idx: st.idx, cleanup: st.cleanup, pending: 4 });
    process.stdout.write(`reload(${buildListReload(st.idx, st.cleanup, true)})+refresh-preview`);
  } else if (st.pending === 2) {
    // Spinner finished rendering -> (re)load the fast list beneath it.
    writeState(tabFile, { idx: st.idx, cleanup: st.cleanup, pending: 3 });
    process.stdout.write(`reload(${buildListReload(st.idx, st.cleanup, false)})+refresh-preview`);
  } else if (st.pending === 4 || st.pending === 5) {
    // Dirty scan finished -> idle; refresh the footer to show real dirty counts.
    writeState(tabFile, { idx: st.idx, cleanup: st.cleanup, pending: 0 });
    process.stdout.write('refresh-preview');
  } else {
    process.stdout.write('');
  }
  process.exit(0);
}

// --- --handle-help: '?' shows the badge legend (cleanup mode only) ---
if (handleHelpMode && tabFile) {
  const state = readState(tabFile);
  if (!state.cleanup) { process.stdout.write(''); process.exit(0); }
  process.stdout.write(`execute(node '${SCRIPT_PATH}' --cleanup-help)`);
  process.exit(0);
}

// --- --cleanup-help: full-screen badge explanation ---
if (cleanupHelpMode) {
  const L = (s) => process.stderr.write(s + '\n');
  L('');
  L(`  ${c.bgRed}${c.bold}${c.white} !CLEANUP! ${c.reset}  ${c.dim}badge guide${c.reset}`);
  L('');
  L(`  ${c.green}✓ merged${c.reset}    Branch is an ancestor of the repo's default branch —`);
  L(`              the work already landed. Safe to remove.`);
  L('');
  L(`  ${c.green}⬆ gone${c.reset}      The branch's upstream (origin/…) was deleted — usually`);
  L(`              means the PR was merged (incl. squash/rebase) and the`);
  L(`              remote branch cleaned up. Safe to remove.`);
  L(`              ${c.dim}Reflects last ${c.reset}${c.yellow}Ctrl-F${c.reset}${c.dim} refresh; run it for fresh data.${c.reset}`);
  L('');
  L(`  ${c.red}● dirty${c.reset}     Worktree has uncommitted or untracked changes. Removing`);
  L(`              it ${c.red}loses that work${c.reset} — requires an extra confirmation.`);
  L('');
  L(`  ${c.red}${c.bold}⚠ unmerged${c.reset}  Not merged and upstream still present — no evidence the`);
  L(`              work is saved elsewhere. The branch itself is kept when`);
  L(`              you remove the worktree, so commits aren't lost.`);
  L('');
  L(`  ${c.yellow}age${c.reset}         Time since the last commit on the branch`);
  L(`              ${c.dim}(today · Nd · Nw · Nmo — ${c.reset}${c.yellow}yellow${c.dim} ≥2w, ${c.reset}${c.red}red${c.dim} ≥1mo).${c.reset}`);
  L('');
  L(`  ${c.dim}Rows are sorted safest-and-oldest first; dirty rows sink to the bottom.${c.reset}`);
  L('');
  L(`  ${c.yellow}${c.bold}Filter${c.reset}      Narrow the list by status via the chip row (persists across`);
  L(`              tabs). ${c.yellow}Ctrl-S${c.reset} cycles ${c.dim}All → Safe → Merged → Gone → Dirty → Unmerged${c.reset};`);
  L(`              ${c.yellow}⌥1${c.reset} merged  ${c.yellow}⌥2${c.reset} gone  ${c.yellow}⌥3${c.reset} dirty  ${c.yellow}⌥4${c.reset} unmerged  ${c.yellow}⌥5${c.reset} safe  ${c.yellow}⌥0${c.reset} all.`);
  L(`              ${c.dim}Safe = merged/gone and clean (what ${c.reset}${c.green}${c.bold}Ctrl-G${c.reset}${c.dim} sweeps).${c.reset}`);
  L('');
  L(`  ${c.green}${c.bold}Ctrl-G${c.reset}      Sweep — remove ${c.green}every merged/gone clean${c.reset} worktree in the`);
  L(`              current tab's scope (one repo, or all repos on the ALL tab),`);
  L(`              behind a single confirmation. Dirty/unmerged are left alone.`);
  L('');
  L(`  ${c.bold}Keys${c.reset}  ${c.cyan}Tab${c.reset} mark   ${c.green}Ctrl-A${c.reset} select all   ${c.red}${c.bold}Enter${c.reset} remove selected/focused`);
  L(`        ${c.magenta}Ctrl-D${c.reset} remove focused   ${c.green}${c.bold}Ctrl-G${c.reset} sweep safe   ${c.yellow}Ctrl-S${c.reset} filter   ${c.yellow}Ctrl-F${c.reset} refresh   ${c.yellow}Ctrl-X${c.reset} exit`);
  L('');
  // Keep the help visible until a keypress, then hand control back to fzf.
  await new Promise((resolve) => {
    process.stderr.write(`  ${c.dim}Press any key to return…${c.reset}`);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');
    process.stdin.once('data', () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve();
    });
  });
  process.exit(0);
}

// --- Git helpers ---
function getWorktrees(repoPath) {
  try {
    const output = execSync('git worktree list --porcelain', {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const worktrees = [];
    let current = {};

    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        current = { path: line.slice(9) };
      } else if (line.startsWith('branch ')) {
        current.branch = line.slice(7).replace('refs/heads/', '');
      } else if (line === 'detached') {
        current.branch = '(detached)';
      } else if (line === '') {
        if (current.path) {
          worktrees.push(current);
        }
        current = {};
      }
    }

    return worktrees;
  } catch {
    return [];
  }
}

function isGitRepo(dir) {
  try {
    statSync(join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

// --- Picker state shared via temp file ---
// Format: four lines — "<idx>\n<cleanup 0|1>\n<pending>\n<ts ms>". `pending` is
// the lazy-load stage: 0 = idle, 1 = fast list loading (show spinner if it runs
// past the delay), 2 = spinner shown, 3 = fast list loading after spinner,
// 4 = dirty scan in progress. `ts` marks when the current stage began, so the
// spinner/shimmer only appear once a stage has run longer than LOADER_DELAY_MS.
// Legacy shorter formats parse. Written atomically (temp + rename) because it's
// read by other processes many times per second during animation.
function readState(file) {
  try {
    const [a, b, p, t, f] = readFileSync(file, 'utf-8').split('\n');
    return {
      idx: parseInt(a, 10) || 0,
      cleanup: b === '1',
      pending: parseInt(p, 10) || 0,
      ts: parseInt(t, 10) || 0,
      filter: f || 'all',
    };
  } catch {
    return { idx: 0, cleanup: false, pending: 0, ts: 0, filter: 'all' };
  }
}

function writeState(file, { idx, cleanup, pending, ts, filter }) {
  // `filter` persists across writes unless explicitly changed (so the status
  // filter survives tab switches); `ts` stamps now on every write (phase start).
  if (filter === undefined) {
    try { filter = readState(file).filter; } catch { filter = 'all'; }
  }
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${idx}\n${cleanup ? '1' : '0'}\n${pending || 0}\n${ts ?? Date.now()}\n${filter}`);
  renameSync(tmp, file);
}

// --- Cleanup detection helpers ---
function getDefaultBranch(repoPath) {
  try {
    const ref = execSync('git symbolic-ref refs/remotes/origin/HEAD', {
      cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const name = ref.replace('refs/remotes/origin/', '');
    if (name) return name;
  } catch {}
  for (const cand of ['develop', 'main', 'master']) {
    try {
      execSync(`git rev-parse --verify --quiet origin/${cand}`, {
        cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'],
      });
      return cand;
    } catch {}
  }
  return 'develop';
}

// One call per repo: branch -> { ts (last commit unix), gone (upstream deleted) }
function getRefInfo(repoPath) {
  const map = new Map();
  try {
    const out = execSync(
      "git for-each-ref --format '%(refname:short)|%(committerdate:unix)|%(upstream:track)' refs/heads",
      { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    for (const line of out.split('\n')) {
      if (!line) continue;
      const [name, ts, track] = line.split('|');
      map.set(name, { ts: parseInt(ts, 10) || 0, gone: (track || '').includes('gone') });
    }
  } catch {}
  return map;
}

// One call per repo: the set of local branches already merged into the default
// branch. Replaces an O(N) fan-out of `git merge-base` calls with a single one.
function getMergedSet(repoPath, defaultBranch) {
  const set = new Set();
  try {
    const out = execSync(
      `git branch --merged origin/${defaultBranch} --format '%(refname:short)'`,
      { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    for (const line of out.split('\n')) {
      const b = line.trim();
      if (b) set.add(b);
    }
  } catch {}
  return set;
}

function isDirty(wtPath) {
  try {
    const out = execSync('git status --porcelain', {
      cwd: wtPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

// Async dirty check for the list — concurrent, and `-uno` skips the untracked
// scan (stat'ing node_modules etc.), which is ~7x faster and dodges the
// multi-second worst cases. It only reports tracked/staged changes; untracked
// files are still caught by the full `isDirty` check at deletion time, and
// `git worktree remove` itself refuses on any untracked/modified files.
function isDirtyAsync(wtPath) {
  return new Promise((resolve) => {
    exec('git status --porcelain -uno', { cwd: wtPath, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      resolve(!err && stdout.trim().length > 0);
    });
  });
}

// Map over items with a bounded concurrency pool; preserves input order.
async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// Human-readable age from a unix timestamp, colored by staleness.
function formatAge(ts) {
  if (!ts) return { text: '  ?', days: 0, color: c.dim };
  const days = Math.floor((Date.now() / 1000 - ts) / 86400);
  let text;
  if (days < 1) text = 'today';
  else if (days < 14) text = `${days}d`;
  else if (days < 70) text = `${Math.floor(days / 7)}w`;
  else text = `${Math.floor(days / 30)}mo`;
  const color = days >= 30 ? c.red : days >= 14 ? c.yellow : c.dim;
  return { text, days, color };
}

// Combine precomputed signals into a worktree's cleanup status. `merged` and
// `dirty` are passed in (computed in bulk) so this stays a pure, cheap function.
function getCleanupInfo(branch, merged, dirty, refInfo) {
  const info = refInfo.get(branch) || { ts: 0, gone: false };
  const gone = info.gone;
  const age = formatAge(info.ts);
  // Removing a worktree keeps the branch, so unmerged work isn't lost — only
  // uncommitted (dirty) changes are true data loss. "safe" = nothing to lose.
  const done = merged || gone;
  const risky = dirty || !done;
  return { merged, gone, dirty, done, risky, age };
}

// Colored badges for a worktree row in cleanup mode. Uses the soft reset (SR)
// so the row-level background highlight isn't wiped between badges.
function cleanupBadges(ci) {
  const parts = [];
  if (ci.merged) parts.push(`${c.green}✓ merged${SR}`);
  if (ci.gone) parts.push(`${c.green}⬆ gone${SR}`);
  if (ci.dirty) parts.push(`${c.red}● dirty${SR}`);
  if (!ci.done && !ci.dirty) parts.push(`${c.red}${c.bold}⚠ unmerged${SR}`);
  return parts.join('  ');
}

// --- Build entry list (cleanup path is async + parallelized) ---
async function getEntries(cleanup = false, withDirty = false, statusFilter = 'all', countsFile = null) {
  const repos = getAllRepos().filter(({ name }) => !(repoFilter && !name.startsWith(repoFilter)));
  if (cleanup) return getCleanupEntries(repos, withDirty, statusFilter, countsFile);

  const entries = [];
  for (const { name, repoPath } of repos) {
    for (const wt of getWorktrees(repoPath)) {
      const isMain = wt.path === repoPath;
      const branch = wt.branch || '???';
      const dirName = basename(wt.path);
      const isActive = activeCwd === wt.path || activeCwd.startsWith(wt.path + '/');

      let mtime = 0;
      try { mtime = statSync(wt.path).mtimeMs; } catch {}

      let repoCol, branchCol, dirCol;
      if (isActive) {
        const marker = `${c.bold}${c.white}▸ ${c.reset}`;
        repoCol = `${marker}${c.bold}${c.cyan}${name.padEnd(18)}${c.reset}`;
        branchCol = `${c.bold}${c.green}${branch.padEnd(45)}${c.reset}`;
        dirCol = `${c.bold}${c.white}${dirName}${c.reset}`;
      } else {
        repoCol = `  ${c.cyan}${name.padEnd(18)}${c.reset}`;
        branchCol = isMain
          ? `${c.dim}${branch.padEnd(45)}${c.reset}`
          : `${c.green}${branch.padEnd(45)}${c.reset}`;
        dirCol = isMain
          ? `${c.dim}${dirName}${c.reset} ${c.yellow}[repo]${c.reset}`
          : `${c.magenta}${dirName}${c.reset}`;
      }

      entries.push({ display: `${repoCol} ${branchCol} ${dirCol}`, path: wt.path, repo: name, mtime });
    }
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  return entries;
}

// Cleanup entries. The cheap signals (merged/gone/age) come from one
// `git branch --merged` + one for-each-ref per repo. The expensive per-worktree
// `git status` (dirty) scan runs only when `withDirty` is set — the first pass
// omits it so the list appears in ~1s, then a background pass fills dirty in.
async function getCleanupEntries(repos, withDirty = false, statusFilter = 'all', countsFile = null) {
  const meta = repos.map(({ name, repoPath }) => {
    const defaultBranch = getDefaultBranch(repoPath);
    return { name, repoPath, refInfo: getRefInfo(repoPath), mergedSet: getMergedSet(repoPath, defaultBranch) };
  });

  // Flatten to the set of candidate worktrees (skip base checkouts / detached).
  const jobs = [];
  for (const m of meta) {
    for (const wt of getWorktrees(m.repoPath)) {
      if (wt.path === m.repoPath) continue;
      const branch = wt.branch || '';
      if (!branch || branch === '(detached)') continue;
      jobs.push({ m, wtPath: wt.path, branch });
    }
  }

  const dirtyFlags = withDirty
    ? await mapPool(jobs, 16, (job) => isDirtyAsync(job.wtPath))
    : jobs.map(() => false);

  const entries = jobs.map((job, i) => {
    const { m, wtPath, branch } = job;
    const ci = getCleanupInfo(branch, m.mergedSet.has(branch), dirtyFlags[i], m.refInfo);
    const rank = ci.dirty ? 2 : ci.done ? 0 : 1;
    const rowDim = ci.dirty ? c.dim : '';
    // Neutral branch color (status is shown by badge + age). Soft reset (SR) so a
    // marked/current row's background highlight spans the whole line.
    const repoCol = `  ${rowDim}${c.cyan}${m.name.padEnd(16)}${SR}`;
    const branchCol = `${rowDim}\x1b[38;5;252m${branch.slice(0, 40).padEnd(41)}${SR}`;
    const dirCol = `${rowDim}${c.magenta}${basename(wtPath).slice(0, 24).padEnd(25)}${SR}`;
    const ageCol = `${ci.age.color}${ci.age.text.padStart(5)}${SR}`;
    return {
      display: `${repoCol} ${branchCol} ${dirCol} ${ageCol}  ${cleanupBadges(ci)}`,
      path: wtPath,
      repo: m.name,
      rank,
      days: ci.age.days,
      merged: ci.merged,
      gone: ci.gone,
      dirty: ci.dirty,
    };
  });

  // Worst-first: safe candidates on top (oldest first), risky/dirty at the bottom.
  entries.sort((a, b) => (a.rank - b.rank) || (b.days - a.days));

  // Counts are always the TOTAL per bucket (independent of the active filter) so
  // the footer tallies stay stable while the filter narrows the visible rows.
  if (countsFile) {
    const counts = {
      removable: entries.filter((e) => e.rank === 0).length,
      unmerged: entries.filter((e) => e.rank === 1).length,
      dirty: entries.filter((e) => e.rank === 2).length,
    };
    try {
      writeFileSync(`${countsFile}.tmp`, JSON.stringify(counts));
      renameSync(`${countsFile}.tmp`, countsFile);
    } catch {}
  }

  const f = STATUS_FILTERS.find((x) => x.value === statusFilter) || STATUS_FILTERS[0];
  return entries.filter((e) => f.match(e));
}

// --- --list-fzf ---
if (listFzf) {
  const withDirty = process.argv.includes('--with-dirty');
  const statusIdx = process.argv.indexOf('--status');
  const statusFilter = statusIdx !== -1 ? process.argv[statusIdx + 1] : 'all';
  const cfIdx = process.argv.indexOf('--counts-file');
  const countsFile = cfIdx !== -1 ? process.argv[cfIdx + 1] : null;
  // getCleanupEntries writes the (total) counts cache and returns filtered rows.
  const entries = await getEntries(cleanupMode, withDirty, statusFilter, countsFile);
  for (const e of entries) {
    console.log(`${e.display}\t${e.path}\t${e.repo}`);
  }
  process.exit(0);
}

// --- --list ---
if (listOnly) {
  for (const e of await getEntries()) {
    console.log(`${e.display}  →  ${e.path}`);
  }
  process.exit(0);
}

// --- wait for any key (used to keep messages visible inside fzf execute) ---
function waitForKey(msg) {
  return new Promise((resolve) => {
    process.stderr.write(`\n${c.dim}${msg || 'Press any key to continue...'}${c.reset}`);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');
    process.stdin.once('data', () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve();
    });
  });
}

// --- --delete ---
const deleteIdx = process.argv.indexOf('--delete');
if (deleteIdx !== -1) {
  const wtPath = process.argv[deleteIdx + 1];
  if (!wtPath) {
    process.stderr.write(`${c.yellow}No worktree path provided.${c.reset}\n`);
    await waitForKey();
    process.exit(1);
  }

  const found = getAllRepos().find(({ repoPath }) =>
    getWorktrees(repoPath).some((wt) => wt.path === wtPath),
  );

  if (!found) {
    process.stderr.write(`${c.yellow}Worktree not found: ${wtPath}${c.reset}\n`);
    await waitForKey();
    process.exit(1);
  }

  const { name: repoName, repoPath } = found;

  if (wtPath === repoPath) {
    process.stderr.write(`${c.yellow}Cannot delete base repo checkout.${c.reset}\n`);
    await waitForKey();
    process.exit(1);
  }

  const branch = getWorktrees(repoPath).find((wt) => wt.path === wtPath)?.branch || '???';
  process.stderr.write(
    `\n${c.yellow}Delete worktree?${c.reset}\n` +
    `  Repo:   ${c.cyan}${repoName}${c.reset}\n` +
    `  Branch: ${c.green}${branch}${c.reset}\n` +
    `  Path:   ${c.dim}${wtPath}${c.reset}\n\n` +
    `${c.yellow}Press Y to confirm, any other key to cancel: ${c.reset}`,
  );

  await new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');
    process.stdin.once('data', (key) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write('\n');

      if (key.toLowerCase() !== 'y') {
        process.stderr.write(`${c.dim}Cancelled.${c.reset}\n`);
        process.exit(0);
      }

      try {
        execSync(`git worktree remove ${JSON.stringify(wtPath)}`, {
          cwd: repoPath,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        process.stderr.write(`${c.green}Deleted: ${basename(wtPath)} (${branch})${c.reset}\n`);
      } catch (err) {
        const msg = err.stderr?.trim() || err.message;
        if (msg.includes('contains modified or untracked files')) {
          process.stderr.write(
            `${c.yellow}Worktree has uncommitted changes. Clean it up first or use 'git worktree remove --force'.${c.reset}\n`,
          );
        } else {
          process.stderr.write(`${c.yellow}${msg}${c.reset}\n`);
        }
      }
      resolve();
    });
  });

  process.exit(0);
}

// --- --bulk-delete: remove several worktrees at once (cleanup mode Enter) ---
if (bulkDeleteMode) {
  const sep = process.argv.indexOf('--');
  const paths = sep !== -1 ? process.argv.slice(sep + 1).filter(Boolean) : [];

  const readOneKey = () => new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');
    process.stdin.once('data', (key) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve(key.toLowerCase());
    });
  });

  // Resolve each path to its repo/branch and classify (skip base checkouts).
  const items = [];
  for (const wtPath of paths) {
    const found = getAllRepos().find(({ repoPath }) =>
      getWorktrees(repoPath).some((wt) => wt.path === wtPath),
    );
    if (!found) continue;
    if (wtPath === found.repoPath) continue; // never the base repo
    const branch = getWorktrees(found.repoPath).find((wt) => wt.path === wtPath)?.branch || '???';
    items.push({ wtPath, repoName: found.name, repoPath: found.repoPath, branch, dirty: isDirty(wtPath) });
  }

  const scopeIdx = process.argv.indexOf('--sweep-scope');
  const sweepScope = scopeIdx !== -1 ? process.argv[scopeIdx + 1] : null;

  if (items.length === 0) {
    process.stderr.write(
      sweepScope
        ? `${c.green}No merged/gone worktrees to sweep in ${c.bold}${sweepScope}${c.reset}${c.green}.${c.reset}\n`
        : `${c.yellow}Nothing to remove.${c.reset}\n`,
    );
    await waitForKey();
    process.exit(0);
  }

  const clean = items.filter((i) => !i.dirty);
  const dirty = items.filter((i) => i.dirty);

  const heading = sweepScope
    ? `Sweep ${items.length} merged/gone worktree${items.length > 1 ? 's' : ''} in ${c.cyan}${sweepScope}${c.reset}${c.bold}?`
    : `Remove ${items.length} worktree${items.length > 1 ? 's' : ''}?`;
  process.stderr.write(`\n${c.bold}${heading}${c.reset}\n\n`);
  for (const i of items) {
    const tag = i.dirty ? `${c.red}● dirty${c.reset}` : `${c.green}✓ clean${c.reset}`;
    process.stderr.write(
      `  ${c.cyan}${i.repoName.padEnd(14)}${c.reset} ${c.green}${i.branch.slice(0, 38).padEnd(39)}${c.reset} ${tag}\n`,
    );
  }
  process.stderr.write(
    `\n  ${c.green}${clean.length} clean${c.reset}` +
    (dirty.length ? `, ${c.red}${dirty.length} with uncommitted changes${c.reset}` : '') + '\n',
  );

  const removeOne = (i, force) => {
    try {
      execSync(`git worktree remove${force ? ' --force' : ''} ${JSON.stringify(i.wtPath)}`, {
        cwd: i.repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      });
      process.stderr.write(`  ${c.green}✓ removed${c.reset} ${c.dim}${basename(i.wtPath)}${c.reset}\n`);
    } catch (err) {
      const msg = err.stderr?.trim() || err.message;
      process.stderr.write(`  ${c.yellow}✗ ${basename(i.wtPath)}: ${msg}${c.reset}\n`);
    }
  };

  // Confirm & remove the clean ones.
  if (clean.length) {
    process.stderr.write(`\n${c.yellow}Press Y to remove the ${clean.length} clean worktree${clean.length > 1 ? 's' : ''}, any other key to skip: ${c.reset}`);
    const key = await readOneKey();
    process.stderr.write('\n');
    if (key === 'y') {
      for (const i of clean) removeOne(i, false);
    } else {
      process.stderr.write(`${c.dim}Skipped clean worktrees.${c.reset}\n`);
    }
  }

  // Dirty ones need an explicit, separate force confirmation (data loss).
  if (dirty.length) {
    process.stderr.write(
      `\n${c.red}${c.bold}${dirty.length} worktree${dirty.length > 1 ? 's have' : ' has'} uncommitted changes.${c.reset}\n` +
      `${c.red}Press F to force-remove (this permanently discards those changes), any other key to keep: ${c.reset}`,
    );
    const key = await readOneKey();
    process.stderr.write('\n');
    if (key === 'f') {
      for (const i of dirty) removeOne(i, true);
    } else {
      process.stderr.write(`${c.dim}Kept worktrees with changes.${c.reset}\n`);
    }
  }

  await waitForKey();
  process.exit(0);
}

// --- --config: interactive editor ---
if (configMode) {
  const repos = getAllRepos().map(({ name }) => name);

  while (true) {
    const currentCfg = loadConfigFile(configPath);

    const lines = repos.map((name) => {
      const cmd = currentCfg.commands?.[name];
      const cmdDisplay = cmd
        ? `\x1b[32m${cmd}\x1b[0m`
        : `\x1b[2m(no command)\x1b[0m`;
      return `\x1b[36m${name.padEnd(20)}\x1b[0m ${cmdDisplay}\t${name}`;
    }).join('\n');

    let selectedRepo;
    try {
      const fzf = spawn('fzf', [
        '--height=40%',
        '--reverse',
        '--ansi',
        '--delimiter=\t',
        '--with-nth=1',
        '--header=\x1b[2mREPO                 COMMAND  (Esc to exit)\x1b[0m',
      ], { stdio: ['pipe', 'pipe', 'inherit'] });

      fzf.stdin.write(lines);
      fzf.stdin.end();

      const result = await new Promise((resolve, reject) => {
        let out = '';
        fzf.stdout.on('data', (d) => { out += d; });
        fzf.on('close', (code) => {
          if (code === 0) resolve(out.trim());
          else reject();
        });
      });

      selectedRepo = result.split('\t').pop();
    } catch {
      break;
    }

    if (!selectedRepo) break;

    const currentCmd = currentCfg.commands?.[selectedRepo] || '';
    process.stderr.write(
      `\n${c.cyan}${selectedRepo}${c.reset} — current: ${currentCmd ? `${c.green}${currentCmd}${c.reset}` : `${c.dim}(none)${c.reset}`}\n`,
    );
    process.stderr.write(`${c.dim}Enter new command (empty to remove, Esc to go back):${c.reset}\n`);

    let answer;
    try {
      answer = await rawPrompt(`${c.yellow}> ${c.reset}`);
    } catch {
      continue;
    }

    const trimmed = answer.trim();
    const commands = { ...currentCfg.commands };
    if (trimmed) {
      commands[selectedRepo] = trimmed;
    } else {
      delete commands[selectedRepo];
    }
    saveCommands(configPath, commands);
    process.stderr.write(
      trimmed
        ? `${c.green}Saved: ${selectedRepo} → ${trimmed}${c.reset}\n\n`
        : `${c.dim}Removed command for ${selectedRepo}${c.reset}\n\n`,
    );
  }

  process.exit(0);
}

// --- --watch: filesystem watcher for live reload ---
if (watchMode) {
  const port = process.argv[process.argv.indexOf('--watch') + 1];
  const filterArg = repoFilter ? ` --filter '${repoFilter}'` : '';
  const cwdArg = ` --cwd '${activeCwd}'`;
  const reloadCmd = `node '${SCRIPT_PATH}' --list-fzf${filterArg}${cwdArg}`;
  const watchers = [];

  let reloadTimer = null;
  function triggerReload() {
    if (reloadTimer) return;
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      // Rebuild from live state so a filesystem change (e.g. a worktree just
      // removed) preserves the active tab + cleanup mode. In cleanup mode, kick
      // the lazy load (spinner -> fast -> dirty) so it stays fast + non-blocking.
      let body = `reload(${reloadCmd})`;
      if (tabFile) {
        const st = readState(tabFile);
        if (st.cleanup) {
          writeState(tabFile, { idx: st.idx, cleanup: true, pending: 1 });
          body = `reload(${buildListReload(st.idx, true, false)})+refresh-preview`;
        } else {
          body = `reload(${buildListReload(st.idx, false)})`;
        }
      }
      fetch(`http://localhost:${port}`, {
        method: 'POST',
        body,
      }).catch(() => {
        cleanup();
        process.exit(0);
      });
    }, 300);
  }

  // Delay watcher: reveals a loader only once a stage outlasts LOADER_DELAY_MS,
  // so fast tabs/scans never flash one. Each reveal is a single POST — no
  // per-frame re-render — so there's nothing to flicker.
  //  - stage 1 (fast list) outlasts delay -> insert the body spinner (stage 2)
  //  - stage 4 (dirty scan) outlasts delay -> show static "scanning dirty" (stage 5)
  const post = (body) => fetch(`http://localhost:${port}`, { method: 'POST', body }).catch(() => {});
  let animTimer = null;
  if (tabFile) {
    animTimer = setInterval(() => {
      let st;
      try { st = readState(tabFile); } catch { return; }
      if (!st.cleanup) return;
      const elapsed = Date.now() - st.ts;
      if (elapsed <= LOADER_DELAY_MS) return;
      if (st.pending === 1) {
        writeState(tabFile, { idx: st.idx, cleanup: true, pending: 2 });
        post(`reload(${spinnerReloadCmd(st.idx)})`);
      } else if (st.pending === 4) {
        writeState(tabFile, { idx: st.idx, cleanup: true, pending: 5 });
        post('refresh-preview');
      }
    }, 110);
  }

  function cleanup() {
    for (const w of watchers) w.close();
    if (animTimer) clearInterval(animTimer);
  }

  for (const { repoPath } of getAllRepos()) {
    const wtMetaDir = join(repoPath, '.git', 'worktrees');
    if (existsSync(wtMetaDir)) {
      watchers.push(watch(wtMetaDir, triggerReload));
    }
  }

  for (const wtDir of cfg.worktreesDirs) {
    if (existsSync(wtDir)) {
      watchers.push(watch(wtDir, triggerReload));
    }
  }

  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('SIGINT', () => { cleanup(); process.exit(0); });

  process.stdin.resume();
} else {
  // --- Default: interactive fzf picker ---
  const filterArg = repoFilter ? ` --filter '${repoFilter}'` : '';
  const cwdArg = ` --cwd '${activeCwd}'`;
  const reloadCmd = `node '${SCRIPT_PATH}' --list-fzf${filterArg}${cwdArg}`;
  const port = 10000 + Math.floor(Math.random() * 50000);

  // Tab navigation temp file
  const tabTmpFile = join(tmpdir(), `wt-tabs-${process.pid}`);
  writeFileSync(tabTmpFile, '0');

  const cycleCmd = (dir) =>
    `node '${SCRIPT_PATH}' --cycle-tab ${dir} --tab-file '${tabTmpFile}' --cwd '${activeCwd}'`;

  try {
    const watchArgs = [SCRIPT_PATH, '--watch', String(port), '--cwd', activeCwd, '--tab-file', tabTmpFile];
    if (repoFilter) watchArgs.push('--filter', repoFilter);
    const watcher = spawn('node', watchArgs, {
      stdio: 'ignore',
      detached: true,
    });
    watcher.unref();

    const enterCmd = `node '${SCRIPT_PATH}' --handle-enter --tab-file '${tabTmpFile}' --cwd '${activeCwd}'`;

    const selected = execSync(
      `node '${SCRIPT_PATH}' --list-fzf${filterArg}${cwdArg} | fzf \
        --height=40% \
        --reverse \
        --ansi \
        --multi \
        --highlight-line \
        --pointer='▶' \
        --marker='▌' \
        --color='pointer:green:bold,marker:bright-yellow:bold,current-bg:236,selected-bg:240' \
        --delimiter='\t' \
        --with-nth=1 \
        --header=' ' \
        --preview="node '${SCRIPT_PATH}' --preview-command {3} --context {2} --tab-file '${tabTmpFile}'" \
        --preview-window='bottom,2,border-top' \
        --listen=${port} \
        --bind="start:transform(${cycleCmd('init')})" \
        --bind="load:transform(node '${SCRIPT_PATH}' --handle-load --tab-file '${tabTmpFile}' --cwd '${activeCwd}')" \
        --bind="ctrl-r:transform(${cycleCmd('init')})" \
        --bind="ctrl-x:transform(node '${SCRIPT_PATH}' --toggle-cleanup --tab-file '${tabTmpFile}' --cwd '${activeCwd}')" \
        --bind="ctrl-f:transform(node '${SCRIPT_PATH}' --handle-fetch --tab-file '${tabTmpFile}' --cwd '${activeCwd}')" \
        --bind="ctrl-g:transform(node '${SCRIPT_PATH}' --handle-sweep --tab-file '${tabTmpFile}' --cwd '${activeCwd}')" \
        --bind="ctrl-s:transform(node '${SCRIPT_PATH}' --handle-status cycle --tab-file '${tabTmpFile}' --cwd '${activeCwd}')" \
        --bind="alt-0:transform(node '${SCRIPT_PATH}' --handle-status all --tab-file '${tabTmpFile}' --cwd '${activeCwd}')" \
        --bind="alt-1:transform(node '${SCRIPT_PATH}' --handle-status merged --tab-file '${tabTmpFile}' --cwd '${activeCwd}')" \
        --bind="alt-2:transform(node '${SCRIPT_PATH}' --handle-status gone --tab-file '${tabTmpFile}' --cwd '${activeCwd}')" \
        --bind="alt-3:transform(node '${SCRIPT_PATH}' --handle-status dirty --tab-file '${tabTmpFile}' --cwd '${activeCwd}')" \
        --bind="alt-4:transform(node '${SCRIPT_PATH}' --handle-status unmerged --tab-file '${tabTmpFile}' --cwd '${activeCwd}')" \
        --bind="alt-5:transform(node '${SCRIPT_PATH}' --handle-status safe --tab-file '${tabTmpFile}' --cwd '${activeCwd}')" \
        --bind="?:transform(node '${SCRIPT_PATH}' --handle-help --tab-file '${tabTmpFile}')" \
        --bind="ctrl-a:select-all+refresh-preview" \
        --bind="tab:toggle+down+refresh-preview" \
        --bind="shift-tab:toggle+up+refresh-preview" \
        --bind="ctrl-o:transform(node '${SCRIPT_PATH}' --handle-skip --tab-file '${tabTmpFile}')" \
        --bind="ctrl-e:transform(node '${SCRIPT_PATH}' --handle-code --tab-file '${tabTmpFile}')" \
        --bind="ctrl-d:transform(node '${SCRIPT_PATH}' --handle-delete --tab-file '${tabTmpFile}' --cwd '${activeCwd}')" \
        --bind="change:first" \
        --bind="right:transform(${cycleCmd('right')})" \
        --bind="left:transform(${cycleCmd('left')})" \
        --bind="enter:transform(${enterCmd} -- {+2})"`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'inherit'] },
    ).trim();

    // In cleanup mode Enter never accepts (it removes + reloads), so a returned
    // selection only comes from normal/config mode. Guard against multi-select
    // by taking the first accepted line.
    const parts = (selected.split('\n')[0] || '').split('\t');
    const skipCmd = parts[0] === 'SKIP';
    const codeCmd = parts[0] === 'CODE';
    const path = parts[1];
    const repo = parts[2];
    if (path) {
      console.log(`${path}\t${repo}\t${skipCmd ? 'skip' : codeCmd ? 'CODE' : ''}`);
    }

    try { process.kill(-watcher.pid); } catch {}
  } catch {
    // noop — user cancelled or fzf error
  } finally {
    for (const f of [tabTmpFile, `${tabTmpFile}.tmp`, `${tabTmpFile}.counts`, `${tabTmpFile}.counts.tmp`]) {
      try { unlinkSync(f); } catch {}
    }
  }
}
