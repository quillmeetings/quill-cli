# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- `--fields` with five or more names no longer drops the extra columns in TOON (`--agent`) and human table output. TOON lists now keep every field; the human table stays at four columns unless `--fields` is passed.
- Failures Quill reports as an `<error code>` tag in a normal response (for example `update_note` on a missing note) now produce the error envelope and exit code 1 instead of a success message.
- `quill threads list` shows `name`, `meetings_count`, and `created_at` instead of only `id`.
- Note lists include each note's `title`.
- Transcript, notes, and other message text no longer contain raw XML entities such as `&apos;`.

## [0.2.0] - 2026-10-08

Verified compatible with Quill desktop 2.9.2.

### Added

- CI workflow running syntax check, lint, and tests on every push and pull request (Node 20 and 22).
- ESLint with a minimal flat config and `npm run lint` (also part of `prepublishOnly`).
- `--offset` support for `quill meetings list` and `quill search` so `next_offset` hints are actionable.
- Unit tests for CLI option/flag/date parsing, command aliases, pagination, and the browse view's pure helpers.
- `CONTRIBUTING.md`, this changelog, and GitHub issue templates.
- README/SKILL.md documentation of the error envelope, exit-code contract, and guidance to treat meeting content as untrusted data in agent contexts.

### Fixed

- `--today`, `--yesterday`, and bare `--since YYYY-MM-DD` dates now use the local timezone instead of UTC, so day filters match the user's calendar.
- `next_offset` is only emitted when the underlying MCP tool actually accepts an offset parameter.

## [0.1.1] - 2026-06-03

### Added

- `quill doctor` setup diagnostics with per-check remediation.
- npm trusted publishing workflow with provenance.

### Fixed

- Hardened CLI onboarding, agent contract, and release pipeline.

## [0.1.0] - 2026-05-19

### Added

- Initial release: curated meeting commands, interactive browse TUI, raw MCP escape hatch, JSON/TOON/human output, agent mode.
