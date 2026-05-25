import { runSessionAttachCommand } from "../../hub/cli/session-attach.js";

export async function cmdSession(args, { resolveWorkspace, httpRequest } = {}) {
  await runSessionAttachCommand({ args, resolveWorkspace, httpRequest });
}
