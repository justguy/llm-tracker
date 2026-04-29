# Changelog

## 1.1.0 (2026-04-29)

### Bug Fixes

* make linked repo-local tracker files the only project truth so branch checkouts and rollbacks carry task state with code.
* add `llm-tracker repair-linked-overlays` for explicit one-time migration of legacy shared runtime overlays into linked tracker files.
* fix boolean CLI flag parsing when adjacent flags are passed without values.

## [1.0.0](https://github.com/justguy/llm-tracker/compare/llm-tracker-v0.2.0...llm-tracker-v1.0.0) (2026-04-24)

### BREAKING CHANGES

* promote the migration-required tracker contract and UI redesign from the internal `0.2.0` line to the public `1.0.0` release.

### Features

* add the Variant A2 board redesign with top-bar agent actions, command palette, hero strip, inline task drawer, settings modal, and light/dark themes.
* add task tree grouping with `kind: "group"` plus `parent_id` containment, while keeping blocker semantics on `dependencies[]`.
* add the derived dependency graph view and optional containment overlay.
* add repo-linked tracker guidance for durable state, runtime overlays, branch-safe patching, and post-merge cleanliness.

## [0.2.0](https://github.com/justguy/llm-tracker/compare/llm-tracker-v0.1.1...llm-tracker-v0.2.0) (2026-04-15)


### Features

* add per-project history with undo-to-revision ([#6](https://github.com/justguy/llm-tracker/issues/6)) ([1937e0e](https://github.com/justguy/llm-tracker/commit/1937e0e6e8e4fd426181697372aa0c2500d26998))
* add per-task comments with hover popover ([#12](https://github.com/justguy/llm-tracker/issues/12)) ([d74b837](https://github.com/justguy/llm-tracker/commit/d74b8378134e4b23ca4641e15de54155d5908192))
* add per-task reference field (path:line) ([#10](https://github.com/justguy/llm-tracker/issues/10)) ([6e1bdca](https://github.com/justguy/llm-tracker/commit/6e1bdcae9d181e58b65ecebb0bba9fb77aa6a686))
* expandable and editable scratchpad per project pane ([#15](https://github.com/justguy/llm-tracker/issues/15)) ([10a93fd](https://github.com/justguy/llm-tracker/commit/10a93fd713f723aedc9c0778ab72997d03d7ebf8))
* pin multiple projects with split workspace layout ([#13](https://github.com/justguy/llm-tracker/issues/13)) ([532d2fa](https://github.com/justguy/llm-tracker/commit/532d2faff28d62149e297247cfe6dcc602a5ff74))


### Bug Fixes

* make workspace accessible when overview drawer is pinned ([#5](https://github.com/justguy/llm-tracker/issues/5)) ([742dc7b](https://github.com/justguy/llm-tracker/commit/742dc7bd467b65aa80d18d603a682a4da9c7988f))


### Documentation

* document the issue to PR to release workflow in README ([#9](https://github.com/justguy/llm-tracker/issues/9)) ([784bc89](https://github.com/justguy/llm-tracker/commit/784bc892750c86b9bf074ccd7dc9be2342e24835))
