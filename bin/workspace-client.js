import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getDaemonStatus } from "../hub/runtime.js";

export const DEFAULT_WORKSPACE = join(homedir(), ".llm-tracker");
export const DEFAULT_PORT = 4400;

export function loadWorkspaceSettings(workspace) {
  const file = join(workspace, "settings.json");
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return {};
  }
}

export function validPort(value) {
  const parsed = parseInt(value, 10);
  return !isNaN(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : null;
}

export function resolveWorkspace(flag) {
  const fromFlag = flag || process.env.LLM_TRACKER_HOME;
  return resolve(fromFlag || DEFAULT_WORKSPACE);
}

export function resolvePort(workspace, flagPort) {
  const wsSettings = loadWorkspaceSettings(workspace);
  const daemonStatus = getDaemonStatus(workspace);
  return (
    validPort(flagPort) ||
    validPort(process.env.LLM_TRACKER_PORT) ||
    validPort(wsSettings.port) ||
    (daemonStatus.running ? validPort(daemonStatus.meta?.port) : null) ||
    DEFAULT_PORT
  );
}

export async function httpRequest(workspace, portFlag, method, path, body) {
  const port = resolvePort(workspace, portFlag);
  const url = `http://127.0.0.1:${port}${path}`;
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  const token = process.env.LLM_TRACKER_TOKEN;
  if (token) headers["Authorization"] = `Bearer ${token}`;
  try {
    const res = await fetch(url, {
      method,
      headers: Object.keys(headers).length ? headers : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    return { status: res.status, body: json, port, url };
  } catch (error) {
    return {
      status: 0,
      body: { error: error.message },
      port,
      url
    };
  }
}
