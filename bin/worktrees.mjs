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

import { execSync, spawn } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, statSync, watch, existsSync, unlinkSync } from 'node:fs';
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
  bgCyan: '\x1b[46m',
  black: '\x1b[30m',
  blue: '\x1b[34m',
};

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
    const hints = `${c.cyan}Enter${c.reset} ${c.dim}open${c.reset}  ${c.green}Ctrl-O${c.reset} ${c.dim}skip cmd${c.reset}  ${c.magenta}Ctrl-D${c.reset} ${c.dim}delete${c.reset}`;
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

// --- --handle-delete: transform action for BS key (skip on config tab) ---
if (handleDeleteMode && tabFile) {
  const tabs = ['ALL', ...getRepoNames(), CONFIG_TAB];
  let idx = 0;
  try { idx = parseInt(readFileSync(tabFile, 'utf-8').trim(), 10) || 0; } catch {}

  if (tabs[idx] === CONFIG_TAB) {
    // Config mode: no-op
    process.stdout.write('');
  } else {
    const selectedTab = tabs[idx];
    const filterArg = selectedTab === 'ALL' ? '' : ` --filter '${selectedTab}'`;
    const cwdArg = ` --cwd '${activeCwd}'`;
    const reloadCmd = `node '${SCRIPT_PATH}' --list-fzf${filterArg}${cwdArg}`;
    process.stdout.write(
      `execute(node '${SCRIPT_PATH}' --delete {2})+reload(${reloadCmd})`,
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

// --- --handle-enter: transform action based on current tab ---
if (handleEnterMode && tabFile) {
  const tabs = ['ALL', ...getRepoNames(), CONFIG_TAB];
  let idx = 0;
  try { idx = parseInt(readFileSync(tabFile, 'utf-8').trim(), 10) || 0; } catch {}

  if (tabs[idx] === CONFIG_TAB) {
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
function renderTabBar(tabs, activeIdx) {
  const isConfig = (t) => t.includes('config');
  const parts = tabs.map((t, i) => {
    if (i === activeIdx) return `${c.bgCyan}${c.bold}${c.black} ${t} ${c.reset}`;
    if (isConfig(t)) return `${c.yellow} ${t} ${c.reset}`;
    return `${c.dim} ${t} ${c.reset}`;
  });
  const bar = parts.join(`${c.dim}│${c.reset}`);
  const nav = `  ${c.yellow}◀ ▶${c.reset} ${c.dim}tabs${c.reset}`;
  return `${bar}${nav}`;
}

// --- --cycle-tab: advance tab index, output fzf transform actions ---
if (cycleTabIdx !== -1 && tabFile) {
  const direction = process.argv[cycleTabIdx + 1]; // 'right', 'left', or 'init'
  const tabs = ['ALL', ...getRepoNames(), CONFIG_TAB];
  let idx = 0;
  try { idx = parseInt(readFileSync(tabFile, 'utf-8').trim(), 10) || 0; } catch {}

  if (direction === 'right') idx++;
  else if (direction === 'left') idx--;
  // 'init' — no change

  if (idx < 0) idx = tabs.length - 1;
  if (idx >= tabs.length) idx = 0;

  const selectedTab = tabs[idx];
  const cwdArg = ` --cwd '${activeCwd}'`;

  // Config tab: swap list to repos+commands
  if (selectedTab === CONFIG_TAB) {
    writeFileSync(tabFile, String(idx));
    const reloadCmd = `node '${SCRIPT_PATH}' --list-config`;
    const header = renderTabBar(tabs, idx);
    process.stdout.write(`reload(${reloadCmd})+change-header(${header})`);
    process.exit(0);
  }

  writeFileSync(tabFile, String(idx));

  const filterArg = selectedTab === 'ALL' ? '' : ` --filter '${selectedTab}'`;
  const reloadCmd = `node '${SCRIPT_PATH}' --list-fzf${filterArg}${cwdArg}`;
  const header = renderTabBar(tabs, idx);

  process.stdout.write(`reload(${reloadCmd})+change-header(${header})`);
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

// --- Build entry list ---
function getEntries() {
  const entries = [];

  for (const { name, repoPath } of getAllRepos()) {
    if (repoFilter && !name.startsWith(repoFilter)) continue;

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

      entries.push({
        display: `${repoCol} ${branchCol} ${dirCol}`,
        path: wt.path,
        repo: name,
        mtime,
      });
    }
  }

  entries.sort((a, b) => b.mtime - a.mtime);
  return entries;
}

// --- --list-fzf ---
if (listFzf) {
  for (const e of getEntries()) {
    console.log(`${e.display}\t${e.path}\t${e.repo}`);
  }
  process.exit(0);
}

// --- --list ---
if (listOnly) {
  for (const e of getEntries()) {
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
      fetch(`http://localhost:${port}`, {
        method: 'POST',
        body: `reload(${reloadCmd})`,
      }).catch(() => {
        cleanup();
        process.exit(0);
      });
    }, 300);
  }

  function cleanup() {
    for (const w of watchers) w.close();
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
    const watchArgs = [SCRIPT_PATH, '--watch', String(port), '--cwd', activeCwd];
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
        --delimiter='\t' \
        --with-nth=1 \
        --header=' ' \
        --preview="node '${SCRIPT_PATH}' --preview-command {3} --context {2}" \
        --preview-window='bottom,2,border-top' \
        --listen=${port} \
        --bind="start:transform(${cycleCmd('init')})" \
        --bind="ctrl-r:reload(${reloadCmd})" \
        --bind="ctrl-o:transform(node '${SCRIPT_PATH}' --handle-skip --tab-file '${tabTmpFile}')" \
        --bind="ctrl-d:transform(node '${SCRIPT_PATH}' --handle-delete --tab-file '${tabTmpFile}' --cwd '${activeCwd}')" \
        --bind="change:first" \
        --bind="right:transform(${cycleCmd('right')})" \
        --bind="left:transform(${cycleCmd('left')})" \
        --bind="enter:transform(${enterCmd})"`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'inherit'] },
    ).trim();

    const parts = selected.split('\t');
    const skipCmd = parts[0] === 'SKIP';
    const path = parts[1];
    const repo = parts[2];
    if (path) {
      console.log(`${path}\t${repo}\t${skipCmd ? 'skip' : ''}`);
    }

    try { process.kill(-watcher.pid); } catch {}
  } catch {
    // noop — user cancelled or fzf error
  } finally {
    try { unlinkSync(tabTmpFile); } catch {}
  }
}
