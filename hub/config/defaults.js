// SH-0-03: §25 workspace-config defaults, transcribed VERBATIM from
// llm_tracker_session_hub_TDD_v0.5.md lines ~2660–2809 (the `sessionHub:`
// YAML block). This is the merge-base for every loaded workspace config and
// the wholesale return value when no config file is present.
//
// sh-0-07 will tighten the SCHEMA (per-block enforcement) but the SHAPE of
// these defaults is final. Do not mutate this object at runtime; it is
// deep-frozen below so any accidental mutation throws.

const SESSION_HUB_DEFAULTS = {
  activity: {
    heartbeatEveryMinutes: 5,
    missingHeartbeatAfterMinutes: 12,
    dumbTerminalQuietAfterMinutes: 10,
    dumbTerminalQuietEscalateAfterMinutes: 25,
    appServerDisconnectedWarningAfterSeconds: 60,
    contextHighPercent: 85
  },

  stdio: {
    liveTail: true,
    captureToDisk: false,
    promptOnFirstCapture: true,
    memoryRingBytes: 262144,
    maxBytes: 5242880,
    rotatedSegments: 3
  },

  runtimeStore: {
    eventLogMode: "single",
    snapshotDebounceMs: 250,
    snapshotMaxAgeMs: 5000,
    snapshotMaxEventsPending: 250,
    flushOnShutdown: true,
    splitWhenLogExceedsMb: 250,
    splitWhenColdRebuildExceedsMs: 5000
  },

  worktrees: {
    recommendOnSharedWorktree: true,
    recommendOnTaskSessionStart: true,
    autoCreateWithoutConfirmation: false,
    allowTrustedAutoCreateOnLaunch: true,
    defaultNamingPattern: "{projectSlug}/{taskId}-{shortTitle}"
  },

  notifications: {
    attentionPushWs: true,
    desktopNotificationsDefault: false,
    humanApprovalStyle: "attention_item"
  },

  completionGates: {
    uiCompleteMode: "block_required_missing",
    allowHumanOverride: true,
    overrideRequiresReason: true,
    warnOnDirectTrackerCompleteWithMissingGates: true
  },

  crossProjectQueue: {
    enabled: true,
    scope: "workspace",
    requireHumanConfirmForMultiLaunch: true,
    maxInitialLaunches: 3
  },

  trustedLocalMode: {
    enabled: false,
    neverAutoApproveTerminalPrompts: true, // non-overridable

    // Background automation (all OFF by default)
    autoCreateWorktreeOnLaunch: false,
    autoRolloverOnContextHigh: false,
    autoRunVerifyCommands: false,
    autoApproveProviderRequests: false,
    autoLaunchCrossProjectQueue: false,
    autoArchiveStoppedSessions: false,
    stdioCaptureToDiskDefault: false,

    // User-initiated powerful actions (ON by default)
    allowDirectContextInjectionOnUserLaunch: true,
    allowStdinInjectionOnUserAction: true,
    allowSessionRestartOnUserAction: true,
    allowVerifyCommandRunOnUserAction: true,
    allowWorktreeCreationFromUI: true,
    allowProviderReviewFromUI: true,
    requireConfirmationForCrossProjectLaunch: true
  },

  providers: {
    codex_cli: {
      kind: "generic_pty",
      command: ["codex"],
      mcpContract: true
    },

    claude_code: {
      kind: "generic_pty",
      command: ["claude"],
      mcpContract: true
    },

    kimi: {
      kind: "generic_pty",
      command: ["kimi"],
      mcpContract: true
    },

    gemini: {
      kind: "generic_pty",
      command: ["gemini"],
      mcpContract: true
    },

    codex_app_server: {
      kind: "structured_provider",
      command: ["codex", "app-server", "--listen", "stdio://"],
      transportPreference: ["stdio", "unix"], // "websocket" is upstream-experimental
      preferGeneratedSchema: true,
      schemaVendorPath: "vendor/codex-app-server",
      fallbackProvider: "generic_pty",
      authMode: "external_codex_auth",
      hubSessionTokenEnv: "LT_SESSION_TOKEN"
    }
  },

  watcher: {
    backend: "chokidar", // chokidar | node_fs_watch
    usePolling: false,
    atomic: true,
    awaitWriteFinish: false,
    coalesceMs: 200,
    maxBatchSize: 500,
    ignore: [
      ".git/**",
      "node_modules/**",
      "dist/**",
      "build/**",
      ".next/**",
      "coverage/**",
      "target/**",
      ".tmp/**",
      "vendor/**",
      ".cache/**"
    ]
  },

  processLifecycle: {
    stopSignal: "SIGINT",
    sigintGraceMs: 5000,
    forceKillSignal: "SIGKILL"
  },

  // v0.7 design-integration additions:

  modelSwap: {
    defaultMode: "successor_restart", // vs live_when_capable
    showLiveSwapWhenCapable: true,
    liveSwapKeepCtxDefault: true
  },

  untaskedSessions: {
    allowed: true,
    unboundAttentionAfterMinutes: 5,
    unboundAutoArchiveAfterHours: 72
  },

  attach: {
    requireConfirmation: true, // never auto-bind on drop
    contextOverflowWarnPercent: 0.85,
    autoStartQueuedOnCompletionGraceSec: 5
  },

  launcher: {
    singleFunnel: true, // CI guard: only SessionBrief/RunSessionWizard
    allowAddTaskInline: true, // opens NewTaskFormDraft; writes tracker before launch
    globalNewSessionPicker: ["pick_task", "untasked", "attach_existing"]
  }
};

export const WORKSPACE_CONFIG_DEFAULTS = Object.freeze({
  sessionHub: SESSION_HUB_DEFAULTS
});

// Deep-freeze so the defaults are immutable through nested mutation too. The
// loader deep-clones the defaults before merging, so this is belt-and-braces.
function deepFreeze(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  for (const value of Object.values(obj)) deepFreeze(value);
  return Object.freeze(obj);
}

deepFreeze(WORKSPACE_CONFIG_DEFAULTS);

export function cloneDefaults() {
  // Structured clone gives us a deep, mutable copy suitable for merging into.
  // (Object.freeze is non-transitive across structuredClone by design.)
  return structuredClone(WORKSPACE_CONFIG_DEFAULTS);
}
