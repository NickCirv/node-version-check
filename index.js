#!/usr/bin/env node
// node-version-check — zero-dependency Node.js version checker
// Checks .nvmrc, .node-version, package.json engines, .tool-versions

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, resolve, dirname } from 'path';
import * as https_module from 'https';

// ─── Semver Utilities ────────────────────────────────────────────────────────

function parseNodeVersion(ver) {
  if (!ver) return null;
  const cleaned = ver.trim().replace(/^v/, '');
  const match = cleaned.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2] ?? '0', 10),
    patch: parseInt(match[3] ?? '0', 10),
    raw: ver.trim(),
  };
}

function versionToInt(major, minor = 0, patch = 0) {
  return major * 1_000_000 + minor * 1_000 + patch;
}

function parseVersionInt(ver) {
  const p = parseNodeVersion(ver);
  if (!p) return null;
  return versionToInt(p.major, p.minor, p.patch);
}

/**
 * Hand-rolled semver range check — no external packages.
 * Supports: >=18, >=18.0.0, ^18, ~18.0, 18.x, 18, >=16 <20, lts/*
 * Returns: { compatible: bool, reason: string }
 */
function checkRange(range, currentVersion) {
  if (!range) return { compatible: null, reason: 'no range' };

  const cur = parseNodeVersion(currentVersion);
  if (!cur) return { compatible: null, reason: 'unparseable current version' };

  const cleanRange = range.trim();

  // LTS aliases — we can only know "current is LTS or not" without external data
  if (/^lts\//i.test(cleanRange) || cleanRange.toLowerCase() === 'lts/*') {
    // Can't statically verify LTS aliases — flag as unknown
    return { compatible: null, reason: `LTS alias: ${cleanRange} (check manually)` };
  }

  // Compound range: >=16 <20
  if (/\s+/.test(cleanRange) && !cleanRange.includes('||')) {
    const parts = cleanRange.split(/\s+/);
    for (const part of parts) {
      const result = checkRange(part, currentVersion);
      if (result.compatible === false) return result;
    }
    return { compatible: true, reason: `satisfies ${cleanRange}` };
  }

  // OR ranges: >=16 || >=18
  if (cleanRange.includes('||')) {
    const parts = cleanRange.split('||');
    for (const part of parts) {
      const result = checkRange(part.trim(), currentVersion);
      if (result.compatible === true) return { compatible: true, reason: `satisfies ${part.trim()}` };
    }
    return { compatible: false, reason: `satisfies none of ${cleanRange}` };
  }

  const curInt = versionToInt(cur.major, cur.minor, cur.patch);

  // >= operator
  if (cleanRange.startsWith('>=')) {
    const req = parseNodeVersion(cleanRange.slice(2));
    if (!req) return { compatible: null, reason: 'unparseable range' };
    const reqInt = versionToInt(req.major, req.minor, req.patch);
    return {
      compatible: curInt >= reqInt,
      reason: `${currentVersion} ${curInt >= reqInt ? '>=' : '<'} ${cleanRange.slice(2)}`,
    };
  }

  // > operator
  if (cleanRange.startsWith('>')) {
    const req = parseNodeVersion(cleanRange.slice(1));
    if (!req) return { compatible: null, reason: 'unparseable range' };
    const reqInt = versionToInt(req.major, req.minor, req.patch);
    return {
      compatible: curInt > reqInt,
      reason: `${currentVersion} ${curInt > reqInt ? '>' : '<='} ${cleanRange.slice(1)}`,
    };
  }

  // <= operator
  if (cleanRange.startsWith('<=')) {
    const req = parseNodeVersion(cleanRange.slice(2));
    if (!req) return { compatible: null, reason: 'unparseable range' };
    const reqInt = versionToInt(req.major, req.minor, req.patch);
    return {
      compatible: curInt <= reqInt,
      reason: `${currentVersion} ${curInt <= reqInt ? '<=' : '>'} ${cleanRange.slice(2)}`,
    };
  }

  // < operator
  if (cleanRange.startsWith('<')) {
    const req = parseNodeVersion(cleanRange.slice(1));
    if (!req) return { compatible: null, reason: 'unparseable range' };
    const reqInt = versionToInt(req.major, req.minor, req.patch);
    return {
      compatible: curInt < reqInt,
      reason: `${currentVersion} ${curInt < reqInt ? '<' : '>='} ${cleanRange.slice(1)}`,
    };
  }

  // ^ operator: compatible with major version (^18 = >=18.0.0 <19.0.0)
  if (cleanRange.startsWith('^')) {
    const req = parseNodeVersion(cleanRange.slice(1));
    if (!req) return { compatible: null, reason: 'unparseable range' };
    const compatible = cur.major === req.major && curInt >= versionToInt(req.major, req.minor, req.patch);
    return {
      compatible,
      reason: `${currentVersion} ${compatible ? 'satisfies' : 'does not satisfy'} ^${req.major}`,
    };
  }

  // ~ operator: compatible with minor version (~18.0 = >=18.0.0 <18.1.0)
  if (cleanRange.startsWith('~')) {
    const req = parseNodeVersion(cleanRange.slice(1));
    if (!req) return { compatible: null, reason: 'unparseable range' };
    const compatible = cur.major === req.major && cur.minor === req.minor && curInt >= versionToInt(req.major, req.minor, req.patch);
    return {
      compatible,
      reason: `${currentVersion} ${compatible ? 'satisfies' : 'does not satisfy'} ~${req.major}.${req.minor}`,
    };
  }

  // x wildcard: 18.x or 18.*
  if (/\.x$/.test(cleanRange) || /\.\*$/.test(cleanRange)) {
    const req = parseNodeVersion(cleanRange.replace(/[.][x*]$/, ''));
    if (!req) return { compatible: null, reason: 'unparseable range' };
    const compatible = cur.major === req.major;
    return { compatible, reason: `${currentVersion} major ${compatible ? '==' : '!='} ${req.major}` };
  }

  // Exact or partial version: 18 or 18.0 or 18.0.0
  const req = parseNodeVersion(cleanRange);
  if (req) {
    // If only major specified, treat as major match
    const hasMinor = /^\d+\.\d+/.test(cleanRange);
    const hasPatch = /^\d+\.\d+\.\d+/.test(cleanRange);
    let compatible;
    if (hasPatch) {
      compatible = curInt === versionToInt(req.major, req.minor, req.patch);
    } else if (hasMinor) {
      compatible = cur.major === req.major && cur.minor === req.minor;
    } else {
      compatible = cur.major === req.major;
    }
    return { compatible, reason: `${currentVersion} ${compatible ? '==' : '!='} ${cleanRange}` };
  }

  return { compatible: null, reason: `unknown range format: ${cleanRange}` };
}

// ─── File Readers ─────────────────────────────────────────────────────────────

function readNvmrc(dir) {
  const f = join(dir, '.nvmrc');
  if (!existsSync(f)) return null;
  try {
    return readFileSync(f, 'utf8').trim();
  } catch { return null; }
}

function readNodeVersion(dir) {
  const f = join(dir, '.node-version');
  if (!existsSync(f)) return null;
  try {
    return readFileSync(f, 'utf8').trim();
  } catch { return null; }
}

function readToolVersions(dir) {
  const f = join(dir, '.tool-versions');
  if (!existsSync(f)) return null;
  try {
    const content = readFileSync(f, 'utf8');
    const match = content.match(/^nodejs\s+(.+)$/m);
    return match ? match[1].trim() : null;
  } catch { return null; }
}

function readPackageEngines(dir) {
  const f = join(dir, 'package.json');
  if (!existsSync(f)) return null;
  try {
    const pkg = JSON.parse(readFileSync(f, 'utf8'));
    return pkg?.engines?.node ?? null;
  } catch { return null; }
}

function readPackageJson(dir) {
  const f = join(dir, 'package.json');
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch { return null; }
}

// ─── Display Helpers ──────────────────────────────────────────────────────────

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';

function colorize(text, color) {
  if (process.env.NO_COLOR || !process.stdout.isTTY) return text;
  return `${color}${text}${RESET}`;
}

function statusIcon(compatible) {
  if (compatible === true) return colorize('✅', GREEN);
  if (compatible === false) return colorize('❌', RED);
  return colorize('⚠️', YELLOW);
}

function pad(str, len) {
  const s = String(str);
  return s.length >= len ? s : s + ' '.repeat(len - s.length);
}

// ─── HTTP Utility ─────────────────────────────────────────────────────────────

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https_module.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Failed to parse JSON: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

// ─── Command: check (default) ────────────────────────────────────────────────

function cmdCheck(dir) {
  const current = process.version;
  console.log(colorize(`\nNode Version Check`, BOLD));
  console.log(colorize(`Current Node: ${current}`, CYAN));
  console.log(colorize(`Directory: ${dir}\n`, DIM));

  const sources = [
    { label: '.nvmrc', value: readNvmrc(dir), type: 'version' },
    { label: '.node-version', value: readNodeVersion(dir), type: 'version' },
    { label: '.tool-versions (nodejs)', value: readToolVersions(dir), type: 'version' },
    { label: 'package.json engines.node', value: readPackageEngines(dir), type: 'range' },
  ];

  let anyMismatch = false;
  let anySource = false;

  for (const src of sources) {
    if (!src.value) {
      console.log(`  ${colorize('⚠️', YELLOW)}  ${pad(src.label, 30)} ${colorize('(not found)', DIM)}`);
      continue;
    }
    anySource = true;
    const result = checkRange(src.value, current);
    const icon = statusIcon(result.compatible);
    const valueStr = colorize(src.value, BOLD);
    const reasonStr = colorize(`(${result.reason})`, DIM);
    console.log(`  ${icon}  ${pad(src.label, 30)} ${valueStr} ${reasonStr}`);
    if (result.compatible === false) anyMismatch = true;
  }

  console.log('');

  if (!anySource) {
    console.log(colorize('  ⚠️  No version requirements found in this directory.', YELLOW));
    console.log(colorize('  Add engines.node to package.json or create an .nvmrc file.\n', DIM));
    return;
  }

  if (anyMismatch) {
    const nvmrc = readNvmrc(dir) || readNodeVersion(dir);
    console.log(colorize('  Version mismatch detected. Suggestions:', BOLD));
    if (nvmrc) {
      console.log(colorize(`    nvm use`, CYAN));
      console.log(colorize(`    nvm install ${nvmrc}`, CYAN));
    } else {
      const engines = readPackageEngines(dir);
      if (engines) {
        const req = parseNodeVersion(engines.replace(/[^0-9.]/g, ''));
        if (req) {
          console.log(colorize(`    nvm install ${req.major}`, CYAN));
          console.log(colorize(`    nvm use ${req.major}`, CYAN));
        }
      }
    }
    console.log('');
  } else {
    console.log(colorize('  All version requirements satisfied.\n', GREEN));
  }
}

// ─── Command: --scan ──────────────────────────────────────────────────────────

function walkPackages(dir, maxDepth = 4, depth = 0) {
  if (depth > maxDepth) return [];
  const results = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (['node_modules', '.git', '.cache', 'dist', 'build', '.next', 'coverage'].includes(entry.name)) continue;
      const subdir = join(dir, entry.name);
      const pkg = readPackageJson(subdir);
      if (pkg) {
        results.push({ path: subdir, name: pkg.name ?? entry.name, engines: pkg?.engines?.node ?? null, pkg });
      }
      results.push(...walkPackages(subdir, maxDepth, depth + 1));
    }
  } catch { /* skip unreadable dirs */ }
  return results;
}

function cmdScan(dir) {
  const current = process.version;
  console.log(colorize(`\nMonorepo Scan`, BOLD));
  console.log(colorize(`Current Node: ${current}`, CYAN));
  console.log(colorize(`Scanning: ${dir}\n`, DIM));

  // Include root if it has package.json
  const rootPkg = readPackageJson(dir);
  const packages = rootPkg ? [{ path: dir, name: rootPkg.name ?? '(root)', engines: rootPkg?.engines?.node ?? null, pkg: rootPkg }] : [];
  packages.push(...walkPackages(dir));

  if (packages.length === 0) {
    console.log(colorize('  No package.json files found.\n', YELLOW));
    return;
  }

  // Gather all unique engine requirements
  const engineCounts = {};
  for (const p of packages) {
    const e = p.engines ?? '(none)';
    engineCounts[e] = (engineCounts[e] ?? 0) + 1;
  }

  const hasInconsistency = Object.keys(engineCounts).filter(k => k !== '(none)').length > 1;

  console.log(colorize(`  Found ${packages.length} package(s)\n`, DIM));

  const nameLen = Math.min(40, Math.max(...packages.map(p => p.name.length)) + 2);
  const engLen = Math.min(30, Math.max(...packages.map(p => (p.engines ?? '(not set)').length)) + 2);

  console.log(`  ${colorize(pad('Package', nameLen), BOLD)} ${colorize(pad('engines.node', engLen), BOLD)} ${colorize('Compatible?', BOLD)}`);
  console.log('  ' + '─'.repeat(nameLen + engLen + 14));

  for (const p of packages) {
    const result = p.engines ? checkRange(p.engines, current) : { compatible: null };
    const icon = p.engines ? statusIcon(result.compatible) : colorize('⚠️', YELLOW);
    const engStr = p.engines ? colorize(p.engines, p.engines ? BOLD : DIM) : colorize('(not set)', DIM);
    const relPath = p.path === dir ? '.' : p.path.replace(dir + '/', '');
    console.log(`  ${icon}  ${pad(p.name, nameLen)} ${pad(p.engines ?? '(not set)', engLen)} ${colorize(relPath, DIM)}`);
  }

  console.log('');

  if (hasInconsistency) {
    console.log(colorize('  ⚠️  Inconsistent engines.node requirements detected:', YELLOW));
    for (const [eng, count] of Object.entries(engineCounts)) {
      if (eng !== '(none)') {
        console.log(`     ${colorize(eng, BOLD)}: ${count} package(s)`);
      }
    }
    console.log(colorize('  Consider aligning all packages to a single version range.\n', DIM));
  } else if (Object.keys(engineCounts).length === 1 && !engineCounts['(none)']) {
    console.log(colorize('  All packages have consistent version requirements.\n', GREEN));
  }
}

// ─── Command: --fix ───────────────────────────────────────────────────────────

async function cmdFix(dir) {
  console.log(colorize(`\nFix Version Files`, BOLD));
  console.log(colorize(`Directory: ${dir}\n`, DIM));

  const engines = readPackageEngines(dir);
  if (!engines) {
    console.log(colorize('  ❌ No engines.node found in package.json. Cannot determine target version.\n', RED));
    return;
  }

  // Extract major version number from engines range
  const majorMatch = engines.match(/\d+/);
  if (!majorMatch) {
    console.log(colorize(`  ❌ Could not extract version number from: ${engines}\n`, RED));
    return;
  }
  const target = majorMatch[0];

  console.log(`  engines.node: ${colorize(engines, BOLD)}`);
  console.log(`  Target version: ${colorize(target, CYAN)}\n`);

  const filesToUpdate = [
    { path: join(dir, '.nvmrc'), content: target, label: '.nvmrc' },
    { path: join(dir, '.node-version'), content: target, label: '.node-version' },
  ];

  const changes = [];
  for (const f of filesToUpdate) {
    const existing = existsSync(f.path) ? readFileSync(f.path, 'utf8').trim() : null;
    if (existing === target) {
      console.log(`  ${colorize('✅', GREEN)}  ${f.label} already set to ${colorize(target, BOLD)}`);
    } else {
      changes.push({ ...f, existing });
      const action = existing === null ? 'Create' : 'Update';
      const from = existing ? ` (was: ${colorize(existing, DIM)})` : '';
      console.log(`  ${colorize('→', CYAN)}  ${f.label}: ${action} → ${colorize(target, BOLD)}${from}`);
    }
  }

  if (changes.length === 0) {
    console.log(colorize('\n  All version files already up to date.\n', GREEN));
    return;
  }

  console.log('');

  // Prompt for confirmation
  const confirmed = await promptConfirm('  Apply these changes? (y/N) ');
  if (!confirmed) {
    console.log(colorize('  Aborted — no changes made.\n', YELLOW));
    return;
  }

  for (const f of changes) {
    writeFileSync(f.path, f.content + '\n', 'utf8');
    console.log(`  ${colorize('✅', GREEN)}  Written: ${f.label}`);
  }
  console.log('');
}

function promptConfirm(message) {
  return new Promise((resolve) => {
    process.stdout.write(message);
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (data) => {
      const answer = data.trim().toLowerCase();
      resolve(answer === 'y' || answer === 'yes');
    });
    process.stdin.resume();
  });
}

// ─── Command: --latest ────────────────────────────────────────────────────────

async function cmdLatest() {
  console.log(colorize(`\nNode.js Release Information`, BOLD));
  console.log(colorize(`Fetching from nodejs.org...\n`, DIM));

  let releases;
  try {
    releases = await httpsGet('https://nodejs.org/dist/index.json');
  } catch (err) {
    console.log(colorize(`  ❌ Failed to fetch release data: ${err.message}\n`, RED));
    return;
  }

  const current = process.version;
  const curParsed = parseNodeVersion(current);

  // Latest Current release
  const latestCurrent = releases[0];
  // Latest LTS
  const latestLTS = releases.find(r => r.lts !== false);
  // Current major's latest
  const currentMajorLatest = releases.find(r => {
    const v = parseNodeVersion(r.version);
    return v && v.major === curParsed.major;
  });

  function formatRelease(r) {
    if (!r) return 'N/A';
    const date = new Date(r.date).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    const lts = r.lts ? ` (LTS: ${r.lts})` : '';
    return `${r.version}${lts} — released ${date}`;
  }

  const isCurrentLTS = latestLTS && parseNodeVersion(latestLTS.version)?.major === curParsed.major;
  const isUpToDate = latestCurrent && parseNodeVersion(latestCurrent.version)?.major === curParsed.major;

  console.log(`  ${colorize('Running:', BOLD)}          ${colorize(current, CYAN)}`);
  console.log(`  ${colorize('Latest Current:', BOLD)}   ${colorize(latestCurrent?.version ?? 'N/A', isUpToDate ? GREEN : YELLOW)}`);
  console.log(`  ${colorize('Latest LTS:', BOLD)}       ${colorize(latestLTS?.version ?? 'N/A', isCurrentLTS ? GREEN : YELLOW)}`);

  if (currentMajorLatest && currentMajorLatest.version !== current) {
    console.log(`  ${colorize(`v${curParsed.major} Latest:`, BOLD)}     ${colorize(currentMajorLatest.version, YELLOW)}`);
  }

  console.log('');

  // Show last 3 LTS versions with EOL info
  const ltsReleases = releases.filter(r => r.lts !== false);
  const seen = new Set();
  const ltsVersions = [];
  for (const r of ltsReleases) {
    const v = parseNodeVersion(r.version);
    if (v && !seen.has(v.major)) {
      seen.add(v.major);
      ltsVersions.push(r);
    }
    if (ltsVersions.length >= 5) break;
  }

  console.log(colorize('  Recent LTS Releases:', BOLD));
  for (const r of ltsVersions) {
    const v = parseNodeVersion(r.version);
    const isCurrent = v?.major === curParsed.major;
    const icon = isCurrent ? colorize('→', CYAN) : ' ';
    const releaseDate = new Date(r.date).toLocaleDateString('en-US', { year: 'numeric', month: 'short' });
    console.log(`  ${icon} ${pad(r.version, 12)} LTS: ${pad(r.lts || 'N/A', 14)} Released: ${releaseDate}${isCurrent ? colorize(' ← you are here', DIM) : ''}`);
  }

  console.log('');

  if (!isUpToDate) {
    console.log(colorize(`  A newer version is available. Consider upgrading:\n`, YELLOW));
    console.log(colorize(`    nvm install node   # latest Current`, CYAN));
    console.log(colorize(`    nvm install --lts  # latest LTS`, CYAN));
    console.log('');
  } else {
    console.log(colorize('  You are running the latest major Node.js version.\n', GREEN));
  }
}

// ─── Command: --matrix ────────────────────────────────────────────────────────

async function cmdMatrix(dir) {
  console.log(colorize(`\nCompatibility Matrix`, BOLD));
  console.log(colorize(`Scanning: ${dir}\n`, DIM));

  // LTS versions to check against
  const ltsVersionsToCheck = ['18.20.0', '20.18.0', '22.13.0', '23.6.0'];

  const rootPkg = readPackageJson(dir);
  const packages = rootPkg ? [{ path: dir, name: rootPkg.name ?? '(root)', engines: rootPkg?.engines?.node ?? null }] : [];
  packages.push(...walkPackages(dir).map(p => ({ path: p.path, name: p.name, engines: p.engines })));

  if (packages.length === 0) {
    console.log(colorize('  No packages found.\n', YELLOW));
    return;
  }

  const nameLen = Math.min(40, Math.max(...packages.map(p => p.name.length)) + 2);
  const colWidth = 10;

  // Header
  const header = `  ${pad('Package', nameLen)}` + ltsVersionsToCheck.map(v => pad(`v${parseNodeVersion(v)?.major}`, colWidth)).join('');
  console.log(colorize(header, BOLD));
  console.log('  ' + '─'.repeat(nameLen + ltsVersionsToCheck.length * colWidth));

  for (const pkg of packages) {
    let row = `  ${pad(pkg.name, nameLen)}`;
    for (const ver of ltsVersionsToCheck) {
      if (!pkg.engines) {
        row += pad(colorize('⚠️ ', YELLOW), colWidth);
      } else {
        const result = checkRange(pkg.engines, ver);
        if (result.compatible === true) row += pad(colorize('✅', GREEN), colWidth);
        else if (result.compatible === false) row += pad(colorize('❌', RED), colWidth);
        else row += pad(colorize('⚠️ ', YELLOW), colWidth);
      }
    }
    console.log(row);
  }

  console.log('');
  console.log(colorize(`  Legend: ✅ compatible  ❌ incompatible  ⚠️  unknown/no requirement\n`, DIM));
}

// ─── Command: ci ──────────────────────────────────────────────────────────────

function cmdCI(dir, format) {
  const current = process.version;
  const sources = [
    { label: '.nvmrc', value: readNvmrc(dir) },
    { label: '.node-version', value: readNodeVersion(dir) },
    { label: '.tool-versions', value: readToolVersions(dir) },
    { label: 'package.json engines.node', value: readPackageEngines(dir) },
  ];

  let hasRequirement = false;
  let compatible = true;
  const issues = [];

  for (const src of sources) {
    if (!src.value) continue;
    hasRequirement = true;
    const result = checkRange(src.value, current);
    if (result.compatible === false) {
      compatible = false;
      issues.push({ label: src.label, value: src.value, reason: result.reason });
    }
  }

  if (!hasRequirement) {
    if (format === 'github') {
      console.log(`::warning file=package.json::node-version-check: No Node.js version requirements found`);
    } else {
      console.log(`WARN: No Node.js version requirements found in ${dir}`);
    }
    process.exit(0);
  }

  if (compatible) {
    if (format === 'github') {
      console.log(`::notice::node-version-check: Node ${current} satisfies all requirements`);
    } else {
      console.log(`OK: Node ${current} satisfies all requirements`);
    }
    process.exit(0);
  } else {
    for (const issue of issues) {
      if (format === 'github') {
        console.log(`::error::node-version-check: Node ${current} does not satisfy ${issue.label}: requires ${issue.value}`);
      } else {
        console.log(`FAIL: Node ${current} does not satisfy ${issue.label}: requires ${issue.value} (${issue.reason})`);
      }
    }
    process.exit(1);
  }
}

// ─── Help ─────────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
${colorize('node-version-check', BOLD)} ${colorize('v1.0.0', DIM)} — Zero-dependency Node.js version checker

${colorize('USAGE', BOLD)}
  nvc [command] [options]
  node-version-check [command] [options]

${colorize('COMMANDS', BOLD)}
  ${colorize('(default)', CYAN)}              Check current project version requirements
  ${colorize('--scan [dir]', CYAN)}           Scan monorepo for engines.node requirements
  ${colorize('--fix', CYAN)}                  Update .nvmrc/.node-version from package.json engines
  ${colorize('--latest', CYAN)}               Check latest Node.js LTS vs current version
  ${colorize('--matrix [dir]', CYAN)}         Compatibility matrix: packages × Node LTS versions
  ${colorize('ci', CYAN)}                     CI mode: exit 1 if requirements not met
  ${colorize('--help, -h', CYAN)}             Show this help

${colorize('OPTIONS', BOLD)}
  ${colorize('--dir <path>', CYAN)}           Target directory (default: current working directory)
  ${colorize('--format github', CYAN)}        GitHub Actions annotation format (ci command only)

${colorize('SOURCES CHECKED', BOLD)}
  .nvmrc                    nvm version file
  .node-version             node-version-manager file
  .tool-versions            asdf version file (nodejs entry)
  package.json engines.node npm engines field

${colorize('EXAMPLES', BOLD)}
  nvc                       Check current directory
  nvc --scan .              Scan monorepo from current dir
  nvc --scan ./packages     Scan specific subdirectory
  nvc --fix                 Auto-update .nvmrc and .node-version
  nvc --latest              Check for Node.js updates
  nvc --matrix              Show compatibility matrix
  nvc ci                    CI check (exits 1 on mismatch)
  nvc ci --format github    GitHub Actions annotations

${colorize('ENVIRONMENT', BOLD)}
  NO_COLOR=1                Disable colored output
`);
}

// ─── Main Entry ───────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  // Determine working directory
  let dir = process.cwd();
  const dirIdx = args.indexOf('--dir');
  if (dirIdx !== -1 && args[dirIdx + 1]) {
    dir = resolve(args[dirIdx + 1]);
  }

  const command = args[0];

  if (command === '--scan') {
    const scanDir = args[1] && !args[1].startsWith('--') ? resolve(args[1]) : dir;
    cmdScan(scanDir);
  } else if (command === '--fix') {
    await cmdFix(dir);
  } else if (command === '--latest') {
    await cmdLatest();
  } else if (command === '--matrix') {
    const matrixDir = args[1] && !args[1].startsWith('--') ? resolve(args[1]) : dir;
    await cmdMatrix(matrixDir);
  } else if (command === 'ci') {
    const format = args.includes('--format') ? args[args.indexOf('--format') + 1] : null;
    cmdCI(dir, format);
  } else if (!command || command.startsWith('--dir')) {
    cmdCheck(dir);
  } else {
    console.log(colorize(`Unknown command: ${command}`, RED));
    console.log(`Run ${colorize('nvc --help', CYAN)} for usage.\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(colorize(`\nFatal error: ${err.message}\n`, RED));
  process.exit(1);
});
