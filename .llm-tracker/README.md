# Repo-Local Tracker File

This directory is **not** a tracker workspace and should **not** run its own daemon.

It exists only to keep this project's tracker JSON versioned in Git while a **shared daemon workspace** serves as the single source of truth.

## Layout

- `trackers/llm-tracker.json`
  - the tracked project file for this repo
- no local `settings.json`
- no local `templates/`
- no local `patches/` workflow

## Shared-Daemon Flow

1. Start the shared daemon on the central workspace, for example:

```bash
node bin/llm-tracker.js --path ~/.llm-tracker --daemon
```

2. Link this repo-local tracker file into that shared workspace:

```bash
node bin/llm-tracker.js link llm-tracker \
  /Users/adilevinshtein/Documents/dev/llm-project-tracker/.llm-tracker/trackers/llm-tracker.json \
  --path ~/.llm-tracker
```

3. After linking:

- the shared daemon automatically watches the linked tracker file for changes
- the shared daemon automatically watches the shared workspace `patches/` directory
- agents should use the shared workspace for HTTP and patch-file updates

## Important

- Do **not** run `llm-tracker --path ./.llm-tracker --daemon`
- Do **not** treat this directory as a standalone workspace
- Do **not** drop patch files here if the shared workspace is the source of truth

## Agent Contract

For the full current agent contract, command surface, and schema:

- [workspace-template/README.md](../workspace-template/README.md)
