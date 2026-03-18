# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Project CLAUDE.md with TypeScript coding rules
- CONTRIBUTING.md with development workflow guide
- Biome linter and formatter configuration
- .editorconfig for consistent editor settings

### Fixed
- Input validation on launch/resume API endpoints (prevent command injection)
- Silent error swallowing across dashboard and agent

### Changed
- Extracted shared utilities to reduce code duplication
- Improved error handling with proper logging and user feedback
