# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Hook-free status detection: the agent reads each session's visible tmux/zellij screen and flags approval prompts (`action_required`) and running turns (`working`) (2026-11-18)
- Pi provider with active-branch JSONL discovery, transcript search, exact process/session mapping, resume/delete support, and dashboard controls (2026-09-10)
- Codex CLI provider with SQLite/rollout discovery, transcript parsing, process mapping, native resume/delete commands, and dashboard controls (2026-09-10)
- Gemini CLI provider: third supported agent type with session discovery from `~/.gemini/tmp/`, JSON-based message parsing, and process detection (2026-03-21)
- Git diff preview with file navigation and syntax-highlighted diffs per session (2026-03-21)
- Configurable keyboard navigation with customizable shortcuts (j/k, Enter, f, t, s, /, ?) (2026-03-21)
- Unified activity feed for cross-session status change notifications (2026-03-21)
- Mobile-responsive layout with three breakpoints (2026-03-21)
- Browser notifications and sound alerts for session status changes (2026-03-21)
- Token usage tracking (input/output token counts) per session (2026-03-21)
- Enhanced message history with tool call grouping and toggle controls (2026-03-20)
- Full-width cards and true fullscreen session view (2026-03-23)
- "Display:" label on thinking/tools toggle controls (2026-03-23)
- 292 additional tests for 9 previously untested modules (2026-03-19)

### Changed
- Multiplexer control (create, type, rename, kill) lives in `agent/src/mux-control.ts`; launch, resume, and reconnect share one startup sequence, and typed text is sent to tmux literally (2026-11-18)
- Message search is a provider method (`searchMessages`) instead of a per-agent if-chain; shared snippet and JSON helpers replace duplicated copies (2026-11-18)
- Terminal relay uses Bun's built-in pseudo-terminal instead of a Python helper; the agent now needs only Bun (2026-11-18)
- Dashboard is bundled with `bun build` instead of Vite; Markdown is rendered by a small in-house parser that never injects HTML and only links http(s)/mailto (2026-11-18)
- Terminal fit, Unicode widths, and link detection are implemented locally instead of xterm addons; remaining dependencies are pinned to exact versions (2026-11-18)
- Removed cost estimation, kept token tracking only (2026-03-22)
- Moved tool/thinking toggles to header as switch controls (2026-03-21)
- Extracted shared utilities and constants to reduce duplication (2026-03-18)
- Broke up heartbeat and send-text functions into focused helpers (2026-03-18)

### Fixed
- Gemini CLI text sending and git diff directory resolution (2026-03-21)
- Full-width cards, true fullscreen view, and terminal blinking (2026-03-23)
- Agent-type-aware text sending for Claude Code with bracketed paste (2026-03-19)
- Strengthened validateProjectDir with path canonicalization (2026-03-18)

### Security
- Server and agent bind to `127.0.0.1` by default (`AGENT_TOWN_HOST`, `AGENT_TOWN_TERMINAL_HOST`); agents bind to all interfaces only when pointed at a non-loopback server (2026-11-18)
- Shared access token in `~/.agent-town/token` (mode 600, generated on first run) required on every API and WebSocket request between dashboard, server and agents; compared in constant time (2026-11-18)
- Origin allowlist on all API requests and WebSocket upgrades, blocking cross-site WebSocket hijacking and CSRF (`AGENT_TOWN_ALLOWED_ORIGINS` for extra origins) (2026-11-18)
- POST/PUT bodies must be `application/json` (multipart on upload endpoints) (2026-11-18)
- Dashboard sign-in via `#token=` login link or token prompt; token kept in `sessionStorage` (2026-11-18)
- SSH nodes receive the token over SSH stdin and use loopback-only tunnels (2026-11-18)
### Removed
- Claude Code hook installation (local and remote), the `/api/hook-event` endpoint, the hook store, and the `enableHooks` node setting (2026-11-18)
- OpenCode SDK client and SSE event stream; OpenCode is read from its SQLite database only (2026-11-18)
- Legacy process-mapping keys without an agent type (2026-11-18)
- Dependencies: `@opencode-ai/sdk`, `react-markdown`, `remark-gfm`, `rehype-highlight`, `@xterm/addon-fit`, `@xterm/addon-unicode11`, `@xterm/addon-web-links`, `vite`, `@vitejs/plugin-react` (2026-11-18)


## [0.1.0] - 2026-03-18

### Added
- Multi-agent support: Claude Code and OpenCode via provider abstraction
- Provider plugin architecture for adding new AI coding agents
- Session discovery from JSONL files (Claude Code) and SQLite/SDK (OpenCode)
- Process-to-multiplexer session mapping via `/proc` inspection
- Real-time status updates via Claude Code hooks and OpenCode SSE events
- Terminal relay: attach to zellij/tmux sessions from the browser
- Launch and resume agent sessions from the dashboard
- Multi-machine support with SSH tunnels and remote agent deployment
- Session renaming from the dashboard
- Rich message view with conversation history
- Settings panel with persistent preferences
- Browser notifications for session status changes
- Project CLAUDE.md with TypeScript coding rules
- CONTRIBUTING.md with development workflow guide
- Biome linter and formatter configuration
- .editorconfig for consistent editor settings

### Changed
- Extracted shared utilities to reduce code duplication
- Improved error handling with proper logging and user feedback

### Fixed
- Input validation on launch/resume API endpoints (prevent command injection)
- Shell escaping for command construction
- Path traversal validation using canonical path comparison
- Information disclosure in error responses (sanitized stderr)
- SSH key path validation
- Security headers on HTTP responses
- Bare catch blocks replaced with proper error logging (46+ instances)
- Explicit return types on all exported functions
