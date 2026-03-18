# Contributing to Agent Town

Thank you for your interest in contributing to Agent Town!

## Prerequisites

- [Bun](https://bun.sh/) v1.1 or later
- A terminal multiplexer: [zellij](https://zellij.dev/) or [tmux](https://github.com/tmux/tmux)
- [Claude Code](https://claude.ai/code) installed (for testing with real sessions)

## Getting Started

1. Clone the repository
2. Install dependencies: `bun install`
3. Start development: `./dev.sh`
4. Open the dashboard: `http://localhost:4680`

## Development Workflow

### Running Tests

```bash
bun test              # All tests
bun test --filter agent   # Agent package only
bun test --filter server  # Server package only
```

### Linting & Formatting

We use [Biome](https://biomejs.dev/) for linting and formatting:

```bash
bunx biome check .          # Check for issues
bunx biome check --write .  # Auto-fix issues
```

### Project Structure

```
agent-town/
  shared/   — Shared types and utilities (no runtime deps)
  agent/    — Per-machine agent (session discovery, heartbeats)
  server/   — Central server (HTTP/WS hub, dashboard serving)
  dashboard/ — React SPA (Vite)
```

### Making Changes

1. Create a feature branch from `main`
2. Write tests first (TDD: Red-Green-Refactor)
3. Implement the minimal code to pass tests
4. Run `bun test` to verify no regressions
5. Run `bunx biome check .` to verify code quality
6. Commit with [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat: add SSH remote host support`
   - `fix: prevent command injection in launch endpoint`
   - `refactor: extract env cleanup helper`
   - `test: add server API endpoint tests`
   - `docs: update README with multi-host setup`

### Code Style

See [CLAUDE.md](./CLAUDE.md) for detailed TypeScript coding rules. Key points:

- TypeScript strict mode — no `any`
- Always handle errors (never silent catches)
- Extract magic numbers into named constants
- Add `aria-label` to interactive UI elements
- Co-locate tests with source files

## Reporting Issues

When reporting bugs, please include:

- Steps to reproduce
- Expected vs actual behavior
- Your OS, Bun version, and multiplexer (zellij/tmux)
- Relevant log output (`LOG_LEVEL=debug`)
