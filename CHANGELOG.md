# Changelog

## [0.3.0](https://github.com/justguy/llm-tracker/compare/v0.2.0...v0.3.0) (2026-04-24)


### Features

* add atomic task pick flow ([c0d9812](https://github.com/justguy/llm-tracker/commit/c0d9812feffe677549334b92a2293b009c87772f))
* add blockers and changed task intelligence ([67f78a2](https://github.com/justguy/llm-tracker/commit/67f78a2113eb5372a96019f0a94ddbdcefcb7a90))
* add deterministic next-task ranking ([aedbaef](https://github.com/justguy/llm-tracker/commit/aedbaef7b23cb634e04ca7ad5d6a9ad4711dd575))
* add execute and verify task packs ([1f68249](https://github.com/justguy/llm-tracker/commit/1f68249f46ca2f45502b3a510f836d3565e1b4d9))
* add favicon from project logo ([db68d91](https://github.com/justguy/llm-tracker/commit/db68d910b02cca9f6b4304aa6076a452e263926e))
* add help endpoint for agent contract ([bc3463f](https://github.com/justguy/llm-tracker/commit/bc3463f6ecfd794255267a748074faf15bada3df))
* add intelligence UI surfaces ([8343d87](https://github.com/justguy/llm-tracker/commit/8343d8778d1bbd165043fb7c46718d388d344ed7))
* add MCP resources and prompts ([9d09a51](https://github.com/justguy/llm-tracker/commit/9d09a519a77ad59f43db26c46fd398b48ba15327))
* add MCP tracker tools ([c745d70](https://github.com/justguy/llm-tracker/commit/c745d70985ad3a3daa990b98f377d0e196a2c471))
* add opt-in background daemon mode ([118f7fe](https://github.com/justguy/llm-tracker/commit/118f7fe87ad5e19a46c175dbb46e79664f982e70))
* add persistent swimlane ordering controls ([e4d1409](https://github.com/justguy/llm-tracker/commit/e4d1409696e0d731d671ec44d9f877400f95604f))
* add runtime overlays and MCP patch tools ([1c4622b](https://github.com/justguy/llm-tracker/commit/1c4622bf2f39c7d52888933689917587faa5f8c0))
* add runtime overlays and MCP patch tools ([#19](https://github.com/justguy/llm-tracker/issues/19)) ([031d561](https://github.com/justguy/llm-tracker/commit/031d5610c2166257bbba5b9e3fdc656a3c14084b))
* add semantic and fuzzy task search ([22bf68d](https://github.com/justguy/llm-tracker/commit/22bf68d5702d445986756cac9f2e966ea41d2d66))
* add status and history MCP tools ([ea0a0e4](https://github.com/justguy/llm-tracker/commit/ea0a0e4e3ca3aa71ada83fe03661b6798e38e204))
* add task brief packs and snippet cache ([c3c8e7d](https://github.com/justguy/llm-tracker/commit/c3c8e7d123b8110d271e043875b3fe4d18e4d984))
* add tracker reload and daemon restart recovery ([967e940](https://github.com/justguy/llm-tracker/commit/967e940a1fbd2ee6bf416d1c86db5c8e64888e5d))
* add why and decisions retrieval packs ([b6933a1](https://github.com/justguy/llm-tracker/commit/b6933a17547ad8e15095712dc22e4912d0a6558f))
* collapse header and clarify linked patch writes ([a30841c](https://github.com/justguy/llm-tracker/commit/a30841c4b14c431c3d9ee4704801fc67f290012f))
* complete pre-semantic intelligence UI ([94549cf](https://github.com/justguy/llm-tracker/commit/94549cfc99cdff250d08125815d94a1f5815d93a))
* harden local hub security and add deleted-project restore ([d2b09a2](https://github.com/justguy/llm-tracker/commit/d2b09a24ff998ff2d19cfa528e03b6e3a058112c))
* **hub:** null-valued context patches delete keys; log silent rewrites ([2dcdbb9](https://github.com/justguy/llm-tracker/commit/2dcdbb9da16007084ab094429ecf4da6a0f8ad9e))
* land A2 hero and inline drawer slices ([a8450c7](https://github.com/justguy/llm-tracker/commit/a8450c78b9e0d45b5d76c4dccbd35c10ce9fe8df))
* refine task card copy controls ([041a5fd](https://github.com/justguy/llm-tracker/commit/041a5fdb2af01419ba86ef2f174616779b22e9d9))
* restore mcp server on official sdk ([eb0c1bf](https://github.com/justguy/llm-tracker/commit/eb0c1bf8726a5b1ac3ddbb94893b470bd0fe92dc))
* **ui:** collapse hides hero strip too and shows a live summary ([780884d](https://github.com/justguy/llm-tracker/commit/780884d22a2f2cacad6d2df775dfd34ed698b70b))
* **ui:** drop .project-pane-header entirely ([8bc4075](https://github.com/justguy/llm-tracker/commit/8bc407548f21adebf88e55da3ac0dcbd18700cff))
* **ui:** drop redundant project eyebrow + title from hero-col--left ([7797da1](https://github.com/justguy/llm-tracker/commit/7797da1ccc9c6c4d7d06912ad2309c5be9781d2f))
* **ui:** drop top-bar eyebrow "LLM·TRACKER" ([2a3cdd1](https://github.com/justguy/llm-tracker/commit/2a3cdd102e553a6bffffcfd05b4500acfd34c781))
* **ui:** hoist scratchpad above banner-row at app level ([dbfa8ef](https://github.com/justguy/llm-tracker/commit/dbfa8efa3d8d63e8afd86a9de474f81b889333b6))
* **ui:** pin button moves to top bar; drop redundant pane header and progress strip ([ad1e821](https://github.com/justguy/llm-tracker/commit/ad1e821ea45f8fed625770715eb53c4ab8c9e2d2))
* **ui:** t21 adopt A2 design tokens and typography ([ff0ccbb](https://github.com/justguy/llm-tracker/commit/ff0ccbb45f48281b984db57531488424864cf445))
* **ui:** t22 rebuild top bar with agent/history clusters, K-palette stub, overflow ([2f7e7e7](https://github.com/justguy/llm-tracker/commit/2f7e7e71254d79ad0972bd0892f5217bc54896c3))
* **ui:** t23 add hero strip with project, status grid, Recommended Next ([51c8356](https://github.com/justguy/llm-tracker/commit/51c8356c1f5083aea914d5b2ce3dfbc9b19ed011))
* **ui:** t24 ship ⌘K command palette ([ce44d80](https://github.com/justguy/llm-tracker/commit/ce44d8051bad9d4ac76589fc81cb23d802535721))
* **ui:** t25 rework task card into three-tier A2 layout with bracket action row ([cdcb3e0](https://github.com/justguy/llm-tracker/commit/cdcb3e0713208ceb7c759ba4b987325c64bd4cc2))
* **ui:** t26 collapse scratchpad to one-line NOTE row with expand/edit ([f70480d](https://github.com/justguy/llm-tracker/commit/f70480d52f9f8929571fba803dda21ce7d1d3ed3))
* **ui:** t28 refresh collapsed swimlane rows to 44px status strip ([d40cae5](https://github.com/justguy/llm-tracker/commit/d40cae5c17368fc6b906c54c4c2ce7b34e5cf2f8))
* **ui:** t29 polish dark theme against Variant C reference ([bdb5992](https://github.com/justguy/llm-tracker/commit/bdb5992f2efea5ff596094998a6784f86fea755c))
* **ui:** t30 accessibility, keyboard, and theme parity sweep ([4dcc83c](https://github.com/justguy/llm-tracker/commit/4dcc83c1358ba2615affb358c418126ebd426efc))
* **ui:** t31 add Bracket button primitive ([1b67216](https://github.com/justguy/llm-tracker/commit/1b67216577bd711224bbfb44be803151a189e10c))
* **ui:** t32 add project ▾ dropdown with quick-switch and overview footer ([11e9c5a](https://github.com/justguy/llm-tracker/commit/11e9c5aa33166f6672833ecf774d676a5d7e57f0))
* **ui:** t33 polish top-bar ⋯ overflow menu with grouped entries ([d428604](https://github.com/justguy/llm-tracker/commit/d4286043a15e8cf21c194e5e15c98f7b34529b48))
* **ui:** t34 polish drag visuals for task cards ([80d29f4](https://github.com/justguy/llm-tracker/commit/80d29f4188d9aa45955f55f8b65073e171499b9b))
* **ui:** t35 render WHY/EXEC/VERIFY content shapes inside the task drawer ([42da807](https://github.com/justguy/llm-tracker/commit/42da807466a3970040828cd2239f1f5364ad52ce))
* **ui:** wire top-bar expand/collapse toggle ([28cd9cb](https://github.com/justguy/llm-tracker/commit/28cd9cb3a785779ba0c3caee7586e9803cb77b3c))


### Bug Fixes

* add offline semantic search fallback ([cd284d4](https://github.com/justguy/llm-tracker/commit/cd284d43505f28cd569c751d931b6654bcf23c39))
* align collapsed swimlane rows ([2cdd4d8](https://github.com/justguy/llm-tracker/commit/2cdd4d8a8dbc41648f99816bd9511b42759728bb))
* close review gaps in hub security and restore flow ([97f2703](https://github.com/justguy/llm-tracker/commit/97f2703cd6a687eac37bcecf4bb2144785a8a387))
* harden daemon shutdown and legacy patch compatibility ([fb52ba9](https://github.com/justguy/llm-tracker/commit/fb52ba972ad9e3c4e20c521a4d56ab5a866d11bf))
* harden semantic search and task intel ui ([e4d775c](https://github.com/justguy/llm-tracker/commit/e4d775c6ff4a38ee8076dec6fc5da6978cdafaa1))
* harden tracker patch guardrails and shortcuts ([b569dc7](https://github.com/justguy/llm-tracker/commit/b569dc7c637e71ed94b2f518d78082fd509a5d91))
* make patch writes authoritative ([0a32212](https://github.com/justguy/llm-tracker/commit/0a322125adc2b8c98390297b346d88d972cfdafb))
* prefer bounded next tasks over roadmap rows ([633f405](https://github.com/justguy/llm-tracker/commit/633f405e945bc82703dfe6eb60ffbb5ce24f952d))
* preserve linked tracker edits during overlay reload ([a69b607](https://github.com/justguy/llm-tracker/commit/a69b6075daedb65707f470b6f18634f8ec45325c))
* resolve linked tracker snippets from repo root ([b06dfe2](https://github.com/justguy/llm-tracker/commit/b06dfe285343d3521b85a45911b83d257fb8e566))
* **tracker:** keep runtime artifacts out of git ([732b03b](https://github.com/justguy/llm-tracker/commit/732b03b78492e05986b0e96557d81eef6ab792d8))
* **ui:** clamp hero-next reason to 2 lines ([b6bd618](https://github.com/justguy/llm-tracker/commit/b6bd618fcee70e92ff837981cf3d1766b7c1445e))
* **ui:** let hero strip use natural 119px height + 1px margin top/bottom ([4ac486a](https://github.com/justguy/llm-tracker/commit/4ac486ae9718730f63dd6f9e4b366f79d569b3e2))
* **ui:** lock hero strip to 136px total height ([e74d2ec](https://github.com/justguy/llm-tracker/commit/e74d2ec89509c33b60d4bc7242c64b24ab77aa5e))
* **ui:** restore top-bar layout rules pruned by t29 ([602ad7d](https://github.com/justguy/llm-tracker/commit/602ad7daa9574dfa0bf437b61f5096d5eb054473))
* **ui:** route [READ] bracket back to the task modal ([e8ec6e9](https://github.com/justguy/llm-tracker/commit/e8ec6e9ff2378cd21c734a689b3f5e4038db1b44))
* **ui:** route hero [READ] to the task modal, not the inline drawer ([db3c7a5](https://github.com/justguy/llm-tracker/commit/db3c7a5a02a08b2f718776d4853d9e90942defcd))
* wire drawer fallback modes to task modal ([7842d9a](https://github.com/justguy/llm-tracker/commit/7842d9ac1c0e01747c4d57bdc90633436e213a7f))


### Documentation

* add existing-project backfill playbook ([3f22e2e](https://github.com/justguy/llm-tracker/commit/3f22e2ea3569b3e9fc6dd7bdb3939e4756758ccc))
* add migration guide for 0.1.x to 0.2.0 ([8930b3b](https://github.com/justguy/llm-tracker/commit/8930b3bb0f613402bf5ac84de52b9336afe4d1f3))
* call out the landing gate for linked repo-local trackers ([9848b3e](https://github.com/justguy/llm-tracker/commit/9848b3e82501c09e1c59175a7469e49a81e7c94a))
* clarify linked tracker git handling ([cbead8d](https://github.com/justguy/llm-tracker/commit/cbead8de6237882b123a157edac055685ae9ad5e))
* clarify local MCP registration ([7f4e9b3](https://github.com/justguy/llm-tracker/commit/7f4e9b3163737021a13bd86266c77123e6c40a37))
* clarify retrieval-only backfill batches ([1c23374](https://github.com/justguy/llm-tracker/commit/1c23374f2677ee2fdf0fb51562c571dc12d311d1))
* clarify safe symlink relink flow ([0e8bd6f](https://github.com/justguy/llm-tracker/commit/0e8bd6faa60eb6e28676a1387da0182436387059))
* refresh README + ARCHITECTURE for the A2 redesign ([2781f49](https://github.com/justguy/llm-tracker/commit/2781f49f5aee61165b983a9cf121ff066a6c75ab))
* **workspace-template:** align /help contract with A2 UI surfaces ([0ceb556](https://github.com/justguy/llm-tracker/commit/0ceb5564f7e7889d70d45b72e3ec35bbdb8fa29e))


### Refactors

* dedupe query command formatting ([19a2fac](https://github.com/justguy/llm-tracker/commit/19a2facf3bd8c26d82ca27c738948a71d3d4bae1))

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
