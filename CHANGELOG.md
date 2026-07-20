# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Open-source communication surface: roadmap, contributing guide, code of
  conduct, security policy, issue/PR templates, CI, and CODEOWNERS.
- `/ask` endpoint, minimal web UI, and `teamctx ask "<question>" [--role <slug>]`
  CLI command for asking questions grounded in team context.
- Decisions as first-class objects: contributions now record a `source`
  (`cli` or `web`), and nodes backed by a `--decision` contribution render
  inline provenance markers (`*[decision — author, date, via source]*`) in
  `shared.md`, in every compiled role file, and in `teamctx ask` answers.

## [0.1.0] - 2026-06-14

### Added
- Initial release: `teamctx` CLI and Vercel API for AI-native team context.
