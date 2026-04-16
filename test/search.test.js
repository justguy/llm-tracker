import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { validProject } from "./fixtures.js";
import {
  buildFuzzySearchPayload,
  buildSearchPayload,
  setSemanticExtractorFactoryForTests,
  setSemanticRuntimeFactoriesForTests,
  setSemanticWasmModuleLoadersForTests
} from "../hub/search.js";

function makeKeywordEmbedderFactory(keywords) {
  return async () => async (input) => {
    const lower = String(input || "").toLowerCase();
    const row = keywords.map((keyword) => (lower.includes(keyword) ? 1 : 0));
    let norm = 0;
    for (const value of row) norm += value * value;
    const scaled = norm > 0 ? row.map((value) => value / Math.sqrt(norm)) : row;
    return { data: Float32Array.from(scaled) };
  };
}

afterEach(() => {
  setSemanticExtractorFactoryForTests(null);
  setSemanticRuntimeFactoriesForTests();
  setSemanticWasmModuleLoadersForTests();
});

test("buildSearchPayload returns semantic matches from the local embedder", async () => {
  setSemanticExtractorFactoryForTests(
    makeKeywordEmbedderFactory(["parallel", "route", "flow", "investor", "cost", "approval"])
  );

  const project = validProject({
    tasks: [
      {
        id: "t-017",
        title: "Parallel execution branch/variant route-flow proof",
        goal: "Prove the branch and route flow.",
        status: "in_progress",
        placement: { swimlaneId: "exec", priorityId: "p0" },
        dependencies: [],
        context: { tags: ["parallel-execution"] }
      },
      {
        id: "t-018",
        title: "Investor demo cost surface",
        goal: "Show cost savings honestly.",
        status: "not_started",
        placement: { swimlaneId: "ops", priorityId: "p1" },
        dependencies: [],
        context: { tags: ["investor-demo", "cost"] }
      }
    ]
  });
  project.meta.rev = 21;

  const payload = await buildSearchPayload({
    slug: "test-project",
    data: project,
    query: "parallel route flow",
    limit: 5,
    workspace: "/tmp/search-test"
  });

  assert.equal(payload.project, "test-project");
  assert.equal(payload.mode, "semantic");
  assert.equal(payload.model, "Xenova/all-MiniLM-L6-v2");
  assert.equal(payload.matches.length, 1);
  assert.equal(payload.matches[0].id, "t-017");
  assert.ok(payload.matches[0].score >= 0.9);
});

test("buildFuzzySearchPayload returns approximate lexical matches", () => {
  const project = validProject();
  project.meta.rev = 12;
  project.tasks[0].title = "Approval manifest validator";
  project.tasks[0].goal = "Validate the approval manifest before execution.";
  project.tasks[0].comment = "Needed before shipping the approval flow.";
  project.tasks[0].references = ["src/manifest.js:1-20"];
  project.tasks[1].context = {
    tags: ["background-daemon", "runtime"],
    notes: "Needs daemon runtime cleanup before restart."
  };

  const payload = buildFuzzySearchPayload({
    slug: "test-project",
    data: project,
    query: "approvl manfest",
    limit: 5
  });

  assert.equal(payload.project, "test-project");
  assert.equal(payload.mode, "fuzzy");
  assert.equal(payload.matches[0].id, "t1");
  assert.ok(payload.matches[0].matchedOn.includes("title") || payload.matches[0].matchedOn.includes("goal"));

  const tagPayload = buildFuzzySearchPayload({
    slug: "test-project",
    data: project,
    query: "background daemon",
    limit: 5
  });
  assert.equal(tagPayload.matches[0].id, "t2");
  assert.ok(tagPayload.matches[0].matchedOn.includes("tag") || tagPayload.matches[0].matchedOn.includes("notes"));
});

test("buildSearchPayload falls back to fuzzy matches when semantic runtime is unavailable", async () => {
  setSemanticExtractorFactoryForTests(async () => {
    throw new Error("onnxruntime native binding missing");
  });

  const project = validProject({
    tasks: [
      {
        id: "t-017",
        title: "Parallel execution branch/variant route-flow proof",
        goal: "Prove the branch and route flow.",
        status: "in_progress",
        placement: { swimlaneId: "exec", priorityId: "p0" },
        dependencies: []
      }
    ]
  });
  project.meta.rev = 22;

  const payload = await buildSearchPayload({
    slug: "test-project",
    data: project,
    query: "parallel route flow",
    limit: 5,
    workspace: "/tmp/search-test"
  });

  assert.equal(payload.mode, "semantic");
  assert.equal(payload.backend, "fuzzy_fallback");
  assert.equal(payload.warning, "semantic search unavailable in this environment; using fuzzy fallback");
  assert.equal(payload.matches[0].id, "t-017");
});

test("buildSearchPayload falls back from native backend to local wasm semantic runtime", async () => {
  setSemanticRuntimeFactoriesForTests({
    nativeFactory: async () => async () => {
      throw new Error("onnxruntime-node native binding missing");
    },
    wasmFactory: makeKeywordEmbedderFactory(["parallel", "route", "flow", "investor"])
  });

  const project = validProject({
    tasks: [
      {
        id: "t-017",
        title: "Parallel execution branch/variant route-flow proof",
        goal: "Prove the branch and route flow.",
        status: "in_progress",
        placement: { swimlaneId: "exec", priorityId: "p0" },
        dependencies: []
      },
      {
        id: "t-018",
        title: "Investor demo cost surface",
        goal: "Show cost savings honestly.",
        status: "not_started",
        placement: { swimlaneId: "ops", priorityId: "p1" },
        dependencies: []
      }
    ]
  });
  project.meta.rev = 23;

  const payload = await buildSearchPayload({
    slug: "test-project",
    data: project,
    query: "parallel route flow",
    limit: 5,
    workspace: "/tmp/search-test"
  });

  assert.equal(payload.mode, "semantic");
  assert.equal(payload.backend, "semantic");
  assert.match(payload.warning, /local wasm runtime/i);
  assert.equal(payload.matches[0].id, "t-017");
});

test("buildSearchPayload does not force an unsupported wasm device in the local fallback path", async () => {
  const fakeEnv = { backends: { onnx: { wasm: {} } } };
  const pipelineCalls = [];
  setSemanticRuntimeFactoriesForTests({
    nativeFactory: async () => async () => {
      throw new Error("onnxruntime-node native binding missing");
    }
  });
  setSemanticWasmModuleLoadersForTests({
    onnxWebLoader: async () => ({ default: { fake: true } }),
    transformersWebLoader: async () => ({
      env: fakeEnv,
      pipeline: async (...args) => {
        pipelineCalls.push(args);
        return makeKeywordEmbedderFactory(["parallel", "route", "flow", "investor"])();
      }
    })
  });

  const project = validProject({
    tasks: [
      {
        id: "t-017",
        title: "Parallel execution branch/variant route-flow proof",
        goal: "Prove the branch and route flow.",
        status: "in_progress",
        placement: { swimlaneId: "exec", priorityId: "p0" },
        dependencies: []
      },
      {
        id: "t-018",
        title: "Investor demo cost surface",
        goal: "Show cost savings honestly.",
        status: "not_started",
        placement: { swimlaneId: "ops", priorityId: "p1" },
        dependencies: []
      }
    ]
  });
  project.meta.rev = 24;

  const payload = await buildSearchPayload({
    slug: "test-project",
    data: project,
    query: "parallel route flow",
    limit: 5,
    workspace: "/tmp/search-test"
  });

  assert.equal(payload.mode, "semantic");
  assert.equal(payload.backend, "semantic");
  assert.match(payload.warning, /local wasm runtime/i);
  assert.equal(payload.matches[0].id, "t-017");
  assert.equal(fakeEnv.allowLocalModels, false);
  assert.deepEqual(pipelineCalls, [[
    "feature-extraction",
    "Xenova/all-MiniLM-L6-v2",
    { device: "auto" }
  ]]);
});
