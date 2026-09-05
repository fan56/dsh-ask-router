# Changelog

All notable changes to this project will be documented in this file.

## [0.4.1] - 2026-09-05

### Changed
- Clean-uninstall documentation + an uninstall leg in the boot smoke asserting removal reconciles the profile tree back to stock: a README 卸载 (Uninstall) section (`dsh plugin --profile <name> remove @aiwayds/dsh-ask-router` — the host splices the bundles entry and drops the patch layer; the plugin keeps zero on-disk state, so the ask_user_question waterfall falls through to other answerers, with dsh-tui-pi answering as itself and fail-closed when neither is present), and the stale cordis.patch.yml "Do NOT install into a web profile" comment corrected to match the README (the upstream web apiproxy gained duplicate tolerance after that comment was written)

## [0.4.0] - 2026-09-03

### Changed
- **BREAKING — dsh host floor `>= 0.1.2-alpha.3`, rc-line support dropped**: the rc-era provider-slot path is deleted — `ctx.userQuestions.registerProvider` ownership, the DUPLICATE_PROVIDER yield (`isDuplicateProviderError`), and the "load before the UI bundles" ordering requirement are all gone; the `'user-questions/request'` cordis waterfall answerer (return to answer, `next()` to delegate) is the single registration path
- README rewritten accordingly: no slot, no load-order rule, and the rc-era "never install into a web profile" ban is history (waterfall answerers coexist)
- CI/release rides the dsh RC/stable line: the host closure resolves at runtime to the newest of the `latest`/`next` dist-tags — the retired `@alpha` dist-tag is no longer followed (policy 2026-09-03)
- dsh host floor re-declared as `>= 0.1.2-rc.1`; the alpha line is no longer a supported target
- README declares RC/stable-only support (CI and releases resolve the newest `latest`/`next` dist-tag at runtime; the alpha line is no longer supported)

### Added
- Boot smoke (`npm run smoke`, `scripts/smoke-boot.mjs`): mounts the packed plugin into a scratch dsh profile and boots it with the real dsh CLI; CI gates on it, installs the host from the rolling rc/stable line (see Changed), and gains a daily schedule

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
