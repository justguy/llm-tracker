import { test } from "node:test";
import assert from "node:assert/strict";
import { ProjectPane } from "../ui/project-pane.js";

function testProjectPane(props = {}) {
  return ProjectPane({
    project: {
      data: {
        meta: { name: "Alpha Control Plane" },
        tasks: []
      },
      derived: {
        counts: { complete: 126 },
        pct: 66,
        total: 198
      }
    },
    slug: "alpha",
    isActive: true,
    solo: false,
    pinned: false,
    onFocus: () => {},
    onTogglePin: () => {},
    filter: "",
    searchMode: "filter",
    boardView: "swimlane",
    fuzzyMatchMap: null,
    statusFilters: new Set(),
    blockFilters: new Set(),
    onMove: () => {},
    onToggleCollapse: () => {},
    onMoveLane: () => {},
    onDeleteTask: () => {},
    onSaveComment: () => {},
    onOpenTask: () => {},
    openTaskId: null,
    openTaskMode: "brief",
    onCloseTask: () => {},
    onOpenTaskModal: () => {},
    runtimeSessions: [],
    runtimeJobs: [],
    scratchpadExpanded: false,
    onToggleScratchpad: () => {},
    onSaveScratchpad: () => {},
    ...props
  });
}

function childByClass(vnode, className) {
  const children = Array.isArray(vnode.props?.children)
    ? vnode.props.children
    : [vnode.props?.children];
  return children.find((child) => child?.props?.class === className) || null;
}

test("ProjectPane shows a named row with unpin action for pinned projects", () => {
  let unpinnedSlug = null;
  const vnode = testProjectPane({
    pinned: true,
    onTogglePin: (slug) => {
      unpinnedSlug = slug;
    }
  });

  const header = childByClass(vnode, "project-pane-header");
  assert.ok(header);
  const [name, progress, button] = header.props.children;

  assert.equal(name.props.children, "Alpha Control Plane");
  assert.deepEqual(progress.props.children[0].props.children, [66, "%"]);
  assert.equal(progress.props.children[1].props.children, "126 of 198 tasks complete.");
  assert.equal(button.type, "button");
  assert.equal(button.props.children, "[UNPIN]");

  let stopped = 0;
  button.props.onClick({ stopPropagation: () => { stopped += 1; } });
  assert.equal(stopped, 1);
  assert.equal(unpinnedSlug, "alpha");
});

test("ProjectPane omits the project row when the pane is not pinned", () => {
  const vnode = testProjectPane({ pinned: false });
  assert.equal(childByClass(vnode, "project-pane-header"), null);
});
