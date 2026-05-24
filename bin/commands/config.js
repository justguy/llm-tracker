// SH-0-03 CLI subcommand shim. Mirrors the shape of the other
// bin/commands/<name>.js files: parse just enough to determine which inner
// runner to invoke, then delegate to the real implementation in hub/cli/.
// (Putting the logic under hub/ keeps it test-importable without spawning
// the bin script.)

import { runConfigCommand } from "../../hub/cli/config.js";

export async function cmdConfig(args, { resolveWorkspace } = {}) {
  if (typeof resolveWorkspace !== "function") {
    console.error("config: resolveWorkspace dependency not provided");
    process.exit(1);
  }
  const workspaceRoot = resolveWorkspace(args.flags.path);
  await runConfigCommand({ args, workspaceRoot });
}
