<div align="center">

# node-version-check

**Catch Node.js version mismatches before they break your CI — across `.nvmrc`, `engines`, and runtime**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue?labelColor=0B0A09)](LICENSE)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen?labelColor=0B0A09)](package.json)
[![Node >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen?labelColor=0B0A09)](package.json)

</div>

## Install

```bash
npx github:NickCirv/node-version-check
```

Or with the short alias:

```bash
npx github:NickCirv/node-version-check nvc --help
```

## Usage

```bash
# Check current project (reads .nvmrc, .node-version, .tool-versions, engines.node)
nvc

# Scan a monorepo — shows engines.node per package with compatibility status
nvc --scan .
nvc --scan ./packages

# Sync .nvmrc and .node-version to match package.json engines.node
nvc --fix

# Check latest LTS vs your running version (fetches from nodejs.org)
nvc --latest

# Compatibility matrix: packages × Node LTS versions
nvc --matrix

# CI mode — exits 1 on mismatch; supports GitHub Actions annotations
nvc ci
nvc ci --format github
```

| Flag | Description |
|------|-------------|
| `--scan [dir]` | Monorepo walk for `engines.node` mismatches |
| `--fix` | Update `.nvmrc` / `.node-version` from `engines.node` |
| `--latest` | Live LTS check from nodejs.org |
| `--matrix [dir]` | Package × Node LTS compatibility table |
| `--dir <path>` | Target directory (default: cwd) |
| `--format github` | GitHub Actions annotation output (ci command) |
| `--help`, `-h` | Show help |

## What it does

Reads every version-pinning file in your project (`.nvmrc`, `.node-version`, `.tool-versions`, `package.json engines.node`) and compares each against the Node version currently running. In monorepos, `--scan` walks all sub-packages and flags inconsistent `engines.node` ranges. `--fix` writes the corrected version back to `.nvmrc` and `.node-version` after a confirmation prompt. The hand-rolled semver parser supports `>=`, `^`, `~`, `x`, compound ranges, and `||` — no `semver` package required.

## CI integration

```yaml
# .github/workflows/check.yml
- name: Check Node version
  run: npx github:NickCirv/node-version-check ci --format github
```

Exits `0` when all requirements are satisfied; exits `1` and emits `::error::` annotations on mismatch.

## Environment

| Variable | Effect |
|----------|--------|
| `NO_COLOR=1` | Disable colored output |

---
<sub>Zero dependencies · Node >=18 · MIT · by <a href="https://github.com/NickCirv">NickCirv</a></sub>
