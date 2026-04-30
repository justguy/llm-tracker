import { ensureHubResponse } from "./shared.js";
import { clampStaleAfterRevs } from "../../hub/hygiene.js";

function formatLane(lane, index) {
  const flag = lane.removable ? "removable" : "keep";
  const lines = [`  ${index + 1}. ${lane.id}  ${flag}  tasks=0`];
  if (lane.label) lines.push(`     ${lane.label}`);
  if (lane.reason) lines.push(`     reason: ${lane.reason}`);
  return lines.join("\n");
}

function formatPriority(priority, index) {
  const lines = [`  ${index + 1}. ${priority.id}  unused`];
  if (priority.label) lines.push(`     ${priority.label}`);
  return lines.join("\n");
}

function formatStale(task, index) {
  const lines = [
    `  ${index + 1}. ${task.id}  ${task.priorityId || "p?"}  ${task.swimlaneId || "?"}  in_progress`
  ];
  lines.push(`     ${task.title}`);
  const meta = [];
  if (task.assignee) meta.push(`assignee=${task.assignee}`);
  if (task.lastTouchedRev != null) meta.push(`lastTouchedRev=${task.lastTouchedRev}`);
  if (task.revsSinceTouched != null) meta.push(`revsSinceTouched=${task.revsSinceTouched}`);
  if (task.lastTouchedAt) meta.push(`lastTouchedAt=${task.lastTouchedAt}`);
  if (meta.length > 0) lines.push(`     ${meta.join(" · ")}`);
  return lines.join("\n");
}

function formatMissing(task, index) {
  const lines = [
    `  ${index + 1}. ${task.id}  ${task.priorityId || "p?"}  ${task.swimlaneId || "?"}  ${task.status}`
  ];
  lines.push(`     ${task.title}`);
  if (task.blocking_on?.length > 0) {
    lines.push(`     blocking on: ${task.blocking_on.join(", ")}`);
  }
  if (task.decision_required?.length > 0) {
    lines.push(`     decision required: ${task.decision_required.join(", ")}`);
  }
  if (task.missingFields?.length > 0) {
    lines.push(`     missing: ${task.missingFields.join(", ")}`);
  }
  return lines.join("\n");
}

export async function cmdHygiene(args, { resolveWorkspace, httpRequest }) {
  const workspace = resolveWorkspace(args.flags.path);
  const slug = args._[1];
  if (!slug) {
    console.error(
      "Usage: llm-tracker hygiene <slug> [--json] [--stale-after-revs N]"
    );
    process.exit(1);
  }

  const staleAfterRaw = args.flags["stale-after-revs"] ?? args.flags.staleAfterRevs;
  const staleAfterRevs =
    staleAfterRaw === undefined
      ? 10
      : clampStaleAfterRevs(Number(staleAfterRaw));

  const path = `/api/projects/${slug}/hygiene?staleAfterRevs=${staleAfterRevs}`;
  const { status, body } = await httpRequest(workspace, args.flags.port, "GET", path);
  ensureHubResponse(status, body, "Hygiene");

  if (args.flags.json) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  console.log(`  ${body.project}  rev ${body.rev ?? "?"}  generated ${body.generatedAt}`);
  console.log(
    `  empty=${body.counts.emptySwimlanes}  removable=${body.counts.removableSwimlanes}  orphaned=${body.counts.orphanedPriorities}  stale=${body.counts.staleInProgress}  unexplained=${body.counts.blockedWithoutReason}  decision-gated-no-comment=${body.counts.decisionGatedWithoutComment}  threshold=${body.thresholds.staleAfterRevs}`
  );

  if (body.emptySwimlanes.length > 0) {
    console.log("  EMPTY SWIMLANES");
    for (const [index, lane] of body.emptySwimlanes.entries()) {
      console.log(formatLane(lane, index));
    }
  }

  if (body.orphanedPriorities.length > 0) {
    console.log("  ORPHANED PRIORITIES");
    for (const [index, priority] of body.orphanedPriorities.entries()) {
      console.log(formatPriority(priority, index));
    }
  }

  if (body.staleInProgress.length > 0) {
    console.log("  STALE IN_PROGRESS");
    for (const [index, task] of body.staleInProgress.entries()) {
      console.log(formatStale(task, index));
    }
  }

  if (body.blockedWithoutReason.length > 0) {
    console.log("  BLOCKED WITHOUT REASON");
    for (const [index, task] of body.blockedWithoutReason.entries()) {
      console.log(formatMissing(task, index));
    }
  }

  if (body.decisionGatedWithoutComment.length > 0) {
    console.log("  DECISION-GATED WITHOUT COMMENT");
    for (const [index, task] of body.decisionGatedWithoutComment.entries()) {
      console.log(formatMissing(task, index));
    }
  }

  if (
    body.emptySwimlanes.length === 0 &&
    body.orphanedPriorities.length === 0 &&
    body.staleInProgress.length === 0 &&
    body.blockedWithoutReason.length === 0 &&
    body.decisionGatedWithoutComment.length === 0
  ) {
    console.log("  no hygiene findings");
  }
}
