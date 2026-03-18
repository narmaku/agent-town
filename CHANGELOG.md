# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

### Fixed
- Input validation on launch/resume API endpoints (prevent command injection)
- Shell escaping for command construction
- Path traversal validation using canonical path comparison
- Information disclosure in error responses (sanitized stderr)
- SSH key path validation
- Security headers on HTTP responses
- Bare catch blocks replaced with proper error logging (46+ instances)
- Explicit return types on all exported functions
