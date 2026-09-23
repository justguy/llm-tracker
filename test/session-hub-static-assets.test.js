import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHub } from "../hub/server.js";

const TEST_TIMEOUT = 10000;

function setupWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "lt-session-hub-assets-"));
  for (const sub of ["trackers", "patches", ".snapshots", ".history", ".runtime"]) {
    mkdirSync(join(ws, sub), { recursive: true });
  }
  writeFileSync(join(ws, "README.md"), "# Session Hub assets test\n");
  return ws;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

test("live hub serves mounted Session Hub modules and styles", { timeout: TEST_TIMEOUT }, async () => {
  const workspace = setupWorkspace();
  const port = await findFreePort();
  let hub = null;
  try {
    hub = await startHub({ workspace, port, uiDir: join(process.cwd(), "ui") });
    const base = `http://127.0.0.1:${port}`;
    const assets = [
      "/app.js",
      "/session-hub/ToolShelf.js",
      "/session-hub/ChatComposer.js",
      "/session-hub/SessionDetailDock.js",
      "/session-hub/SessionDetailDock.css",
      "/session-hub/ToolShelf.css",
      "/session-hub/ChatComposer.css",
    ];
    for (const asset of assets) {
      const res = await fetch(`${base}${asset}`);
      assert.equal(res.status, 200, asset);
      assert.match(await res.text(), /\S/, asset);
    }
  } finally {
    if (hub) await hub.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});
