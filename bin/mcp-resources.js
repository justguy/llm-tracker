import { loadProjectEntry, readWorkspaceHelp, listProjectEntries } from "../hub/project-loader.js";
import {
  HELP_URI,
  PROJECTS_URI,
  WORKSPACE_RUNTIME_URI,
  WORKSPACE_STATUS_URI,
  buildProjectStatusUri,
  makeResourceContent,
  parseProjectStatusUri,
  projectStatusPayload,
  summarizeProject,
  workspaceRuntimePayload,
  workspaceStatusPayload
} from "./mcp-context-data.js";

export function listResources(workspace) {
  const projects = listProjectEntries(workspace).map(summarizeProject);

  return [
    {
      uri: HELP_URI,
      name: "Workspace Help",
      description: "Full workspace agent contract, including daemon and patch workflow rules.",
      mimeType: "text/markdown"
    },
    {
      uri: WORKSPACE_STATUS_URI,
      name: "Workspace Status",
      description: "Structured workspace, daemon, and project status overview.",
      mimeType: "application/json"
    },
    {
      uri: WORKSPACE_RUNTIME_URI,
      name: "Workspace Runtime",
      description: "Daemon state, MCP daemon rule, and patch-file workflow details.",
      mimeType: "application/json"
    },
    {
      uri: PROJECTS_URI,
      name: "Projects",
      description: "Structured summaries for all known projects in the workspace.",
      mimeType: "application/json"
    },
    ...projects.map((project) => ({
      uri: buildProjectStatusUri(project.slug),
      name: `${project.slug} Status`,
      description: `Structured status for project ${project.slug}.`,
      mimeType: "application/json"
    }))
  ];
}

export function readResource(workspace, uri) {
  switch (uri) {
    case HELP_URI: {
      const help = readWorkspaceHelp(workspace);
      if (!help.ok) {
        throw new Error(`Workspace help is unavailable at ${help.path}: ${help.message}`);
      }
      return makeResourceContent(uri, "text/markdown", help.text);
    }
    case WORKSPACE_STATUS_URI:
      return makeResourceContent(
        uri,
        "application/json",
        JSON.stringify(workspaceStatusPayload(workspace), null, 2)
      );
    case WORKSPACE_RUNTIME_URI:
      return makeResourceContent(
        uri,
        "application/json",
        JSON.stringify(workspaceRuntimePayload(workspace), null, 2)
      );
    case PROJECTS_URI:
      return makeResourceContent(
        uri,
        "application/json",
        JSON.stringify(
          {
            workspace,
            projectCount: listProjectEntries(workspace).length,
            projects: listProjectEntries(workspace).map(summarizeProject)
          },
          null,
          2
        )
      );
    default: {
      const slug = parseProjectStatusUri(uri);
      if (!slug) {
        throw new Error(`Unknown resource: ${uri}`);
      }
      const entry = loadProjectEntry(workspace, slug);
      if (!entry.ok) {
        throw new Error(`Failed to load project "${slug}" from ${entry.path}: ${entry.message}`);
      }
      return makeResourceContent(
        uri,
        "application/json",
        JSON.stringify(projectStatusPayload(workspace, entry), null, 2)
      );
    }
  }
}
