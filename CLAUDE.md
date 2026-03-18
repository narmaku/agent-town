# Agent Town — Development Guide

## Project Overview

Dashboard for monitoring and controlling AI coding agent sessions across machines.
Supports multiple agent types (Claude Code, OpenCode, and future agents) via a provider abstraction.
Monorepo: `shared/`, `agent/`, `server/`, `dashboard/`.

## Development Mode

This project is in **fast-development mode**. Breaking changes are allowed freely —
there is no need for backward compatibility, deprecation shims, or migration paths.
Heavy refactoring is encouraged when it improves architecture or extensibility.

## Stack

- **Runtime:** Bun (not Node.js)
- **Language:** TypeScript (strict mode)
- **Frontend:** React 19 + Vite
- **Styling:** Plain CSS (no framework)
- **Testing:** `bun test` (Bun native test runner)
- **Linter/Formatter:** Biome
- **Package Manager:** Bun workspaces

## Commands

```bash
# Development
./dev.sh                  # Start all services (server + agent + dashboard build)
bun install               # Install dependencies

# Testing
bun test                  # Run all tests
bun test --filter agent   # Run agent tests only
bun test --filter server  # Run server tests only
bun test --filter shared  # Run shared tests only

# Linting & Formatting
bunx biome check .        # Lint + format check
bunx biome check --write .  # Auto-fix lint + format issues

# Build
cd dashboard && bunx vite build  # Build dashboard for production
```

## Architecture

```
Browser (React SPA)
  |  WebSocket + HTTP
  v
Server (Bun HTTP/WS, port 4680)
  |  HTTP proxy
  v
Agent (per-machine, port 4681)
  |  discovers sessions, maps processes
  v
Multiplexer Sessions (zellij / tmux)
```

- **shared/** — Types, logger. No runtime dependencies.
- **agent/** — Runs on each machine. Uses provider plugins to discover sessions from
  multiple AI coding agents (Claude Code, OpenCode, etc.), maps them to multiplexer
  sessions via process inspection, sends heartbeats to server.
  - **agent/src/providers/** — Agent provider abstraction. Each provider implements
    session discovery, process detection, CLI commands, and hook/event handling for
    a specific AI coding agent.
- **server/** — Central hub. Receives heartbeats, stores machine state, proxies commands
  to agents, serves the dashboard SPA.
- **dashboard/** — React SPA. Connects via WebSocket for real-time updates.

## TypeScript Coding Rules

### Code Organization
- Import statements at the top of the file, after any comments.
- Group imports: Node built-ins, external packages, internal modules. Separate groups with a blank line.
- One module per file. Keep files focused on a single responsibility.
- Prefer named exports over default exports.

### Type Safety
- Never use `any`. Use `unknown` and narrow with type guards.
- Add explicit return types to exported functions.
- Use `interface` for object shapes, `type` for unions/intersections/aliases.
- Validate external data at system boundaries (API inputs, file parsing) with runtime checks.
- Always pass radix to `parseInt()`: `parseInt(value, 10)`.

### Error Handling
- Never use bare `catch {}` or `catch(() => {})`. Always log or handle the error.
- Use specific error messages that include context (what failed, which ID, etc.).
- At API boundaries, return structured error responses with appropriate HTTP status codes.
- Use the project logger (`createLogger`) — never raw `console.log/error`.

### Functions & Methods
- Keep functions small and focused on a single responsibility.
- Prefer pure functions where possible.
- Extract repeated logic into shared utilities (DRY).
- Use descriptive names: `discoverSessions()` not `getSessions()`.

### Constants
- Extract magic numbers and strings into named constants.
- Group related constants at the top of the module or in a shared constants file.
- Use `as const` for literal types.

### Testing
- Test framework: `bun:test` (describe, test, expect, beforeEach, afterEach, spyOn).
- Co-locate test files with source: `foo.ts` -> `foo.test.ts`.
- Follow Red-Green-Refactor: write failing test, make it pass, clean up.
- Test public API, not implementation details.
- Use factory helpers (e.g., `makeHeartbeat()`) to build test data.
- Clean up side effects in `afterEach()`.

### Naming Conventions
- Files: `kebab-case.ts` (e.g., `session-parser.ts`)
- Interfaces/Types: `PascalCase` (e.g., `SessionInfo`)
- Functions/Variables: `camelCase` (e.g., `discoverSessions`)
- Constants: `UPPER_SNAKE_CASE` for true constants (e.g., `HEARTBEAT_INTERVAL_MS`)
- Test descriptions: plain English, describe behavior not implementation

### Security
- Never interpolate user input into shell commands without validation.
- Validate and sanitize all inputs at API boundaries.
- Use array-form `Bun.spawn(["cmd", "arg"])`, never string-form shell execution.
- Restrict file paths to expected directories (no path traversal).

### Logging
- Use `createLogger("module")` from `@agent-town/shared`.
- Levels: debug < info < warn < error (default: info, env: `LOG_LEVEL`).
- Log at appropriate levels: debug for internals, info for lifecycle events,
  warn for recoverable issues, error for failures.

### React / Dashboard
- Prefer functional components with hooks.
- Memoize expensive computations with `useMemo` / `useCallback`.
- Add `aria-label` to all interactive elements (buttons, inputs, links).
- Centralize API endpoint paths as constants.
- Never use `any` in component props — define explicit interfaces.
- Handle and display errors from API calls to the user.
