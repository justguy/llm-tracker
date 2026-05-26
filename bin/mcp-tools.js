import { createReadTools } from "./mcp-read-tools.js";
import { createJobTools } from "./mcp-job-tools.js";
import { createSessionTools } from "./mcp-session-tools.js";
import { createWriteTools } from "./mcp-write-tools.js";

export function createTools(workspace, portFlag) {
  const tools = [
    ...createReadTools(workspace),
    ...createWriteTools(workspace, portFlag),
    ...createSessionTools(workspace, portFlag),
    ...createJobTools(workspace, portFlag)
  ];
  return new Map(tools.map((tool) => [tool.name, tool]));
}
