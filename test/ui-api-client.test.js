import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deleteProject,
  fuzzySearchUrl,
  postProjectJson,
  projectApiUrl
} from "../ui/api-client.js";

test("projectApiUrl encodes project slugs consistently", () => {
  assert.equal(projectApiUrl("demo project"), "/api/projects/demo%20project");
  assert.equal(projectApiUrl("demo/project", "patch"), "/api/projects/demo%2Fproject/patch");
});

test("fuzzySearchUrl encodes slug and query parameters", () => {
  assert.equal(
    fuzzySearchUrl("demo/project", "ship now?"),
    "/api/projects/demo%2Fproject/fuzzy-search?q=ship%20now%3F&limit=12"
  );
});

test("postProjectJson sends encoded POST JSON and parsed response body", async () => {
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      statusText: "OK",
      async json() {
        return { ok: true };
      }
    };
  };

  try {
    const result = await postProjectJson("demo/project", "pick", { taskId: "t/1" });
    assert.equal(calls[0].url, "/api/projects/demo%2Fproject/pick");
    assert.equal(calls[0].options.method, "POST");
    assert.equal(calls[0].options.headers["Content-Type"], "application/json");
    assert.equal(calls[0].options.body, JSON.stringify({ taskId: "t/1" }));
    assert.deepEqual(result.body, { ok: true });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("postProjectJson can preserve bodyless POST requests", async () => {
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      statusText: "OK",
      async json() {
        return {};
      }
    };
  };

  try {
    await postProjectJson("demo", "undo");
    assert.equal(calls[0].url, "/api/projects/demo/undo");
    assert.equal(calls[0].options.method, "POST");
    assert.equal("headers" in calls[0].options, false);
    assert.equal("body" in calls[0].options, false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("deleteProject uses the encoded project URL", async () => {
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      statusText: "OK",
      async json() {
        return {};
      }
    };
  };

  try {
    await deleteProject("demo/project");
    assert.equal(calls[0].url, "/api/projects/demo%2Fproject");
    assert.equal(calls[0].options.method, "DELETE");
  } finally {
    globalThis.fetch = previousFetch;
  }
});
