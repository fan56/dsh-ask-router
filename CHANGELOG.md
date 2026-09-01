# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Changed
- **BREAKING — dsh host floor `>= 0.1.2-alpha.3`, rc-line support dropped**: the rc-era provider-slot path is deleted — `ctx.userQuestions.registerProvider` ownership, the DUPLICATE_PROVIDER yield (`isDuplicateProviderError`), and the "load before the UI bundles" ordering requirement are all gone; the `'user-questions/request'` cordis waterfall answerer (return to answer, `next()` to delegate) is the single registration path
- README rewritten accordingly: no slot, no load-order rule, and the rc-era "never install into a web profile" ban is history (waterfall answerers coexist)

### Added
- Boot smoke (`npm run smoke`, `scripts/smoke-boot.mjs`): mounts the packed plugin into a scratch dsh profile and boots it with the real dsh CLI; CI gates on it, installs the host from the rolling `@alpha` dist-tag (latest still points at the dropped rc line), and gains a daily schedule

## [0.2.0] - 2026-08-29

### Added
- alpha-era (v0.1.2-alpha+) host support: when `ctx.userQuestions.registerProvider` is absent, register as a `'user-questions/request'` cordis waterfall answerer (return to answer, `next()` to delegate); with zero surfaces the router steps aside for a co-present native answerer (e.g. the web UI)
- 4 unit tests covering `apply()` on both host eras (slot registration/disposal, DUPLICATE yield, zero-surface delegation, multi-surface fan-out)

### Changed
- README rewritten: why the plugin exists, its sharper alpha-era positioning (upstream solved coexistence but is queue-based, not race-based), demo video, and the web-profile ban now scoped to rc-era hosts only

### Fixed
- rc-era (≤ v0.1.1) behavior unchanged: the provider-slot path, DUPLICATE_PROVIDER yielding, and load-order requirements are preserved verbatim

## [0.1.1] - 2026-08-29

### Changed
- npm metadata-only release: add keywords (dsh, dsh-plugin, deepseek-harness, ask-user, routing) for registry discoverability; no code changes
