import { ensureHubResponse } from "./shared.js";

export async function cmdReload(args, { resolveWorkspace, httpRequest }) {
  const workspace = resolveWorkspace(args.flags.path);
  const slug = args._[1] || null;
  const path = slug ? `/api/projects/${slug}/reload` : "/api/reload";

  const { status, body } = await httpRequest(workspace, args.flags.port, "POST", path);
  ensureHubResponse(status, body, "Reload");

  if (args.flags.json) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  if (slug) {
    console.log(`Reloaded ${slug}.`);
    if (typeof body.rev === "number") console.log(`  rev: ${body.rev}`);
    if (body.noop) console.log("  no file changes detected");
    return;
  }

  console.log(`Reloaded ${body.reloaded?.length || 0} projects.`);
  for (const item of body.reloaded || []) {
    console.log(`  ${item.slug}  rev ${item.rev ?? "?"}${item.noop ? "  noop" : ""}`);
  }
  if ((body.errors || []).length > 0) {
    console.log("  errors:");
    for (const item of body.errors) {
      console.log(`    ${item.slug || "unknown"}: ${item.message}`);
    }
  }
}
