import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Creates a temp workspace with the standard hub subdirectories.
export function makeWorkspace(prefix = "llm-tracker-test-") {
  const ws = mkdtempSync(join(tmpdir(), prefix));
  for (const sub of ["trackers", ".snapshots", ".history"]) {
    mkdirSync(join(ws, sub), { recursive: true });
  }
  return ws;
}

export function validProject(overrides = {}) {
  return {
    meta: {
      name: "Test Project",
      slug: "test-project",
      swimlanes: [
        { id: "exec", label: "Execution" },
        { id: "ops", label: "Operator" }
      ],
      priorities: [
        { id: "p0", label: "P0 / Now" },
        { id: "p1", label: "P1 / Next" }
      ],
      scratchpad: ""
    },
    tasks: [
      {
        id: "t1",
        title: "Task 1",
        status: "not_started",
        placement: { swimlaneId: "exec", priorityId: "p0" },
        dependencies: [],
        context: { tags: ["alpha"] }
      },
      {
        id: "t2",
        title: "Task 2",
        status: "in_progress",
        placement: { swimlaneId: "exec", priorityId: "p0" },
        dependencies: ["t1"],
        assignee: "claude"
      },
      {
        id: "t3",
        title: "Task 3",
        status: "complete",
        placement: { swimlaneId: "ops", priorityId: "p1" }
      }
    ],
    ...overrides
  };
}
