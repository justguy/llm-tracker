// Triage — what needs you, now.
// Different from Hub: Hub = "show me the world", Triage = "show me what needs me, in priority order".
// Dense rows, inline actions, evidence drill-down on every state.

function SessionTriage({ onOpenSession, onRollover, onModel, onRestart, sessions }) {
  const [openEvidence, setOpenEvidence] = React.useState(null); // session id

  // ── group by priority ─────────────────────────────────
  const groups = [
    {
      key: 'now', label: 'NOW · urgent · blocks progress', tone: 'block',
      items: sessions.filter(s => s.attention === 'approval_needed'),
    },
    {
      key: 'soon', label: 'SOON · review · degraded state', tone: 'info',
      items: sessions.filter(s => s.attention === 'context_high' || s.attention === 'sandbox_escape_requested'),
    },
    {
      key: 'watch', label: 'WATCH · check · ambiguous', tone: 'warn',
      items: sessions.filter(s => s.attention === 'quiet' || s.attention === 'no_heartbeat'),
    },
    {
      key: 'paused', label: 'PAUSED · blocked or waiting', tone: 'block',
      items: sessions.filter(s => s.attention === 'blocked_on_dep' || s.attention === 'worktree_conflict' || s.attention === 'outside_allowed_paths'),
    },
  ];

  const totalAttention = groups.reduce((n, g) => n + g.items.length, 0);

  return (
    <div style={{
      fontFamily: shSans,
      background: SH.bg,
      width: 1440,
      border: `1px solid ${SH.rule}`,
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 14,
        padding: '12px 22px',
        background: SH.paper,
        borderBottom: `1px solid ${SH.rule}`,
      }}>
        <span style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3, letterSpacing: 1.2 }}>LLM·TRACKER</span>
        <span style={{ fontSize: 18, fontWeight: 600 }}>Triage</span>
        <span style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3, padding: '2px 6px', border: `1px solid ${SH.rule}` }}>
          {totalAttention} session{totalAttention !== 1 ? 's' : ''} need you
        </span>
        <div style={{ flex: 1 }} />
        <span style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3 }}>
          updated 2s ago · auto-refresh ON
        </span>
      </div>

      {/* Body */}
      <div style={{ background: SH.paper, padding: '0 0 16px' }}>
        {totalAttention === 0 && (
          <div style={{
            padding: '60px 22px',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
            background: SH.okSoft,
          }}>
            <Dot tone="ok" size={10} />
            <div style={{ fontSize: 18, fontWeight: 600, color: SH.ok }}>All ambient.</div>
            <div style={{ fontFamily: shMono, fontSize: 11, color: SH.ink2 }}>
              No sessions need attention. 7 running.
            </div>
          </div>
        )}
        {groups.map(g => g.items.length === 0 ? null : (
          <TriageGroup key={g.key} group={g}
            openEvidence={openEvidence} setOpenEvidence={setOpenEvidence}
            onOpenSession={onOpenSession} onRollover={onRollover} onRestart={onRestart} onModel={onModel} />
        ))}
      </div>
    </div>
  );
}

function TriageGroup({ group, openEvidence, setOpenEvidence, onOpenSession, onRollover, onRestart, onModel }) {
  const c = group.tone === 'block' ? SH.block
          : group.tone === 'warn'  ? SH.warn
          : group.tone === 'info'  ? SH.info
          :                          SH.ink2;
  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 22px',
        background: SH.paperAlt,
        borderBottom: `1px solid ${SH.ruleSoft}`,
        borderTop: `1px solid ${SH.ruleSoft}`,
      }}>
        <Dot tone={group.tone} size={7} />
        <span style={{ fontFamily: shMono, fontSize: 11, color: c, letterSpacing: 1, fontWeight: 600 }}>
          {group.label}
        </span>
        <span style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3 }}>· {group.items.length}</span>
      </div>
      {group.items.map(it => (
        <TriageRow key={it.id} it={it}
          evidenceOpen={openEvidence === it.id}
          toggleEvidence={() => setOpenEvidence(openEvidence === it.id ? null : it.id)}
          onOpenSession={onOpenSession} onRollover={onRollover} onRestart={onRestart} onModel={onModel} />
      ))}
    </div>
  );
}

function TriageRow({ it, evidenceOpen, toggleEvidence, onOpenSession, onRollover, onRestart, onModel }) {
  const tone = it.tone || (
    it.attention === 'approval_needed' || it.attention === 'sandbox_escape_requested' ? 'block'
    : it.attention === 'context_high' ? 'info'
    : it.attention === 'quiet' || it.attention === 'no_heartbeat' || it.attention === 'outside_allowed_paths' ? 'warn'
    : 'ink2'
  );
  const c = tone === 'block' ? SH.block : tone === 'warn' ? SH.warn : tone === 'info' ? SH.info : SH.ink2;
  return (
    <div style={{
      background: SH.paper,
      borderBottom: `1px solid ${SH.ruleSoft}`,
      borderLeft: `3px solid ${c}`,
    }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: '76px 110px 1fr auto',
        gap: 14, alignItems: 'center',
        padding: '12px 22px',
      }}>
        <span style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3 }}>{it.id}</span>
        <CapTier tier={it.tier} />
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: SH.ink }}>{it.profile}</span>
            <span style={{
              fontFamily: shMono, fontSize: 9, letterSpacing: 0.5,
              color: c, background: c === SH.block ? SH.blockSoft : c === SH.warn ? SH.warnSoft : c === SH.info ? SH.infoSoft : SH.bgSink,
              padding: '2px 6px',
            }}>
              {ATTENTION_LABELS[it.attention]} · {it.dur}
            </span>
            <SourceLabel src={it.src} />
            <span style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3, marginLeft: 4 }}>{it.proj}</span>
          </div>
          <div style={{ fontFamily: shMono, fontSize: 11, color: SH.ink2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {it.detail}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          {it.actions.map((a, i) => (
            <Bracket key={i} dense active={a.primary} tone={a.tone} dim={a.dim}
              onClick={
                a.kind === 'open'     ? onOpenSession :
                a.kind === 'rollover' ? onRollover :
                a.kind === 'restart'  ? onRestart :
                a.kind === 'model'    ? onModel :
                undefined
              }>{a.label}</Bracket>
          ))}
          <Bracket dense dim onClick={toggleEvidence}>{evidenceOpen ? '▾ why' : '▸ why'}</Bracket>
        </div>
      </div>

      {evidenceOpen && <EvidencePanel it={it} />}
    </div>
  );
}

function EvidencePanel({ it }) {
  const ev = ATTENTION_EVIDENCE[it.attention];
  if (!ev) return null;
  return (
    <div style={{
      padding: '12px 22px 14px 102px',
      background: SH.bg,
      borderTop: `1px dashed ${SH.rule}`,
      display: 'grid', gridTemplateColumns: '180px 1fr', gap: 12,
      fontFamily: shMono, fontSize: 11, color: SH.ink2, lineHeight: 1.6,
    }}>
      <EvKV k="source"      v={ev.source} />
      <EvKV k="event"       v={ev.event} />
      <EvKV k="received"    v={it.receivedAt || '38s ago'} />
      <EvKV k="why"         v={ev.why} multiline />
      <EvKV k="clears when" v={ev.clears} multiline tone="ok" />
      <EvKV k="if ignored"  v={ev.ignored} multiline tone="warn" />
    </div>
  );
}

function EvKV({ k, v, multiline, tone }) {
  const c = tone === 'ok' ? SH.ok : tone === 'warn' ? SH.warn : tone === 'block' ? SH.block : SH.ink;
  return (
    <>
      <span style={{ color: SH.ink3, textTransform: 'lowercase', letterSpacing: 0.5 }}>{k}</span>
      <span style={{ color: c, gridColumn: '2', whiteSpace: multiline ? 'normal' : 'nowrap' }}>{v}</span>
    </>
  );
}

// ── attention type taxonomy ──────────────────────────────
const ATTENTION_LABELS = {
  approval_needed:           'APPROVAL NEEDED',
  sandbox_escape_requested:  'SANDBOX ESCAPE',
  context_high:              'CONTEXT HIGH',
  quiet:                     'QUIET',
  no_heartbeat:              'NO HEARTBEAT',
  blocked_on_dep:            'BLOCKED ON DEP',
  worktree_conflict:         'WORKTREE CONFLICT',
  outside_allowed_paths:     'OUTSIDE ALLOWED PATHS',
};

const ATTENTION_EVIDENCE = {
  approval_needed: {
    source: 'app_server · thread.approval',
    event:  'exec_approval_request #4821',
    why:    'The agent issued a tool call requiring human confirmation. This is a structured signal — not derived. Adapter is waiting for a response.',
    clears: 'when an approval_resolved event arrives (approve/deny/timeout).',
    ignored: 'auto-deny after 5 minutes. Session may stall.',
  },
  sandbox_escape_requested: {
    source: 'app_server · thread.approval (kind: sandbox)',
    event:  'sandbox_escape_request #4823',
    why:    'Agent asked to write to or run a command outside the current sandbox boundary.',
    clears: 'approve once / approve for session / escalate sandbox / deny.',
    ignored: 'agent retries or hangs.',
  },
  context_high: {
    source: 'tracker_session_heartbeat',
    event:  'ctx_pct ≥ 0.85 reported by adapter',
    why:    'Context window is at 89%. Quality degrades fast above this. A deterministic successor pack is ready.',
    clears: 'rollover started OR context drops (manual prune / shorter messages).',
    ignored: 'agent will silently lose ability to keep instruction-level focus.',
  },
  quiet: {
    source: 'derived_activity (watcher + stdio)',
    event:  'no stdio change in 12m on dumb-terminal session',
    why:    'A dumb-terminal session has no structured state. Quiet may mean approval, error, or success. UI cannot distinguish.',
    clears: 'human ack OR stdio resumes OR session restarted.',
    ignored: 'session may be effectively dead.',
  },
  no_heartbeat: {
    source: 'derived (mcp heartbeat overdue)',
    event:  'last heartbeat 6m ago, expected ≤ 2m',
    why:    'MCP session has not sent heartbeat. Process is alive but adapter may be stuck.',
    clears: 'heartbeat resumes OR human pings session.',
    ignored: 'will eventually be marked stale.',
  },
  blocked_on_dep: {
    source: 'tracker_session_blocked',
    event:  'reason: needs t-024 snapshot artifact',
    why:    'Session reported it cannot continue without a dependency. Dep is currently in flight on another session.',
    clears: 'tracker_session_unblocked event OR dep completes.',
    ignored: 'no work happening here.',
  },
  worktree_conflict: {
    source: 'watcher_git (derived)',
    event:  'shared worktree write overlap',
    why:    'Two sessions are writing to the same files in the same worktree. Last 4 files in engine/operations/ touched by both within 90s.',
    clears: 'pause one session OR split into separate worktrees.',
    ignored: 'one session may overwrite the other; review confusion likely.',
  },
  outside_allowed_paths: {
    source: 'watcher_git (derived)',
    event:  'file write outside repos.allowed_paths',
    why:    'Session wrote to a path not in its configured allowed list. Not an explicit approval — derived from filesystem evidence.',
    clears: 'add path to allowed list OR session stops writing there.',
    ignored: 'closeout sweep may flag.',
  },
};

// ── synthetic triage items derived from the global hub sessions ─
const TRIAGE_DEFAULT = [
  {
    id: 'ses-K2WX', tier: 'hybrid', profile: 'reviewer', proj: 'phalanx',
    attention: 'approval_needed', src: 'structured', dur: '38s',
    detail: '$ rm -rf .runtime/snapshots/expired/* · outside repos.allowed_paths',
    receivedAt: '38s ago',
    actions: [
      { label: 'APPROVE',  tone: 'block', primary: true,  kind: 'open' },
      { label: 'DENY',     tone: 'block', kind: 'open' },
      { label: 'OPEN CHAT',                kind: 'open' },
      { label: 'ESCALATE', tone: 'warn',  kind: 'open' },
    ],
  },
  {
    id: 'ses-9HCM', tier: 'mcp', profile: 'planner', proj: 'phalanx',
    attention: 'context_high', src: 'reported', dur: '89%',
    detail: 'ctx 178k / 200k · successor pack ready (deterministic)',
    actions: [
      { label: 'ROLLOVER',  tone: 'info', primary: true, kind: 'rollover' },
      { label: 'PREVIEW',    kind: 'rollover' },
      { label: 'OPEN',       kind: 'open' },
      { label: 'EXTEND CTX', dim: true,    kind: 'open' },
    ],
  },
  {
    id: 'ses-3FT8', tier: 'dumb', profile: 'code-runner', proj: 'llm-tracker',
    attention: 'quiet', src: 'derived', dur: '12m',
    detail: 'no stdio change · dumb terminal · ambiguous (could be approval/error/success)',
    actions: [
      { label: 'STDIO',   tone: 'warn', primary: true, kind: 'open' },
      { label: 'PING',                                  kind: 'open' },
      { label: 'RESTART', tone: 'warn',                kind: 'restart' },
      { label: 'ACK',     dim: true,                    kind: 'open' },
    ],
  },
  {
    id: 'ses-PR2D', tier: 'mcp', profile: 'reviewer', proj: 'hoplon',
    attention: 'blocked_on_dep', src: 'structured', dur: '8m',
    detail: 'reason: needs t-024 snapshot artifact · in flight on ses-V2QJ (same worktree)',
    actions: [
      { label: 'ASK ses-V2QJ', tone: 'info', primary: true, kind: 'open' },
      { label: 'OPEN',                                       kind: 'open' },
      { label: 'UNBLOCK',     dim: true,                    kind: 'open' },
    ],
  },
];

window.SessionTriage = SessionTriage;
window.TRIAGE_DEFAULT = TRIAGE_DEFAULT;
window.ATTENTION_LABELS = ATTENTION_LABELS;
window.ATTENTION_EVIDENCE = ATTENTION_EVIDENCE;
