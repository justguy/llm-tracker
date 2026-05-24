// Per-project board with Session Hub integration
// Shows how the existing Project-Phalanx board upgrades:
//   - new "Sessions" strip below the KPI bar
//   - task cards get an inline session badge when a session is bound
//   - drop a task onto the strip to attach/start a session

function SessionBoardIntegration({ onOpenSession, onStart, onAttach }) {
  return (
    <div style={{
      fontFamily: shSans,
      background: SH.bg,
      width: 1440,
      border: `1px solid ${SH.rule}`,
    }}>
      <BIB_TopBar />
      <BIB_KpiStrip />
      <BIB_SessionRail onOpenSession={onOpenSession} onStart={onStart} onAttach={onAttach} />
      <BIB_BoardHead />
      <BIB_Lane onOpenSession={onOpenSession} onStart={onStart} />
    </div>
  );
}

function BIB_TopBar() {
  return (
    <div style={{
      display: 'flex', alignItems: 'center',
      padding: '12px 22px',
      borderBottom: `1px solid ${SH.rule}`,
      background: SH.paper, gap: 22,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3, letterSpacing: 1 }}>LLM·TRACKER</span>
        <span style={{ fontSize: 18, fontWeight: 600, letterSpacing: -0.3 }}>Project Phalanx</span>
        <span style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3, padding: '2px 6px', border: `1px solid ${SH.rule}` }}>REV 948</span>
        <span style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3, padding: '2px 6px', border: `1px solid ${SH.rule}` }}>[PIN]</span>
      </div>
      <div style={{ flex: 1 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ fontSize: 11, color: SH.ink3, marginRight: 4 }}>agent</span>
        <Bracket active>NEXT</Bracket>
        <Bracket>BLOCKERS</Bracket>
        <Bracket>CHANGED</Bracket>
      </div>
      <div style={{ width: 1, height: 18, background: SH.rule }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ fontSize: 11, color: SH.ink3, marginRight: 4 }}>sessions</span>
        <Bracket tone="ok">3 ACTIVE</Bracket>
        <Bracket tone="block">1 APPROVAL</Bracket>
        <Bracket>HUB ↗</Bracket>
      </div>
      <div style={{ width: 1, height: 18, background: SH.rule }} />
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 10px', border: `1px solid ${SH.rule}`,
        background: SH.bg, minWidth: 220,
      }}>
        <span style={{ fontFamily: shMono, fontSize: 11, color: SH.ink3 }}>⌘K</span>
        <span style={{ fontSize: 12, color: SH.ink2 }}>filter · search · run command</span>
      </div>
    </div>
  );
}

function BIB_KpiStrip() {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '320px 1fr 280px',
      borderBottom: `1px solid ${SH.rule}`,
      background: SH.paper,
    }}>
      <div style={{ padding: '14px 22px', borderRight: `1px solid ${SH.rule}` }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 32, fontWeight: 600, letterSpacing: -0.5, lineHeight: 1 }}>88<span style={{ fontSize: 14, color: SH.ink3 }}>%</span></span>
          <span style={{ fontFamily: shMono, fontSize: 11, color: SH.ink3 }}>328 of 381 tasks complete</span>
        </div>
        <div style={{ marginTop: 10, height: 4, background: SH.ruleSoft }}>
          <div style={{ width: '88%', height: '100%', background: SH.ok }} />
        </div>
      </div>
      <div style={{ padding: '14px 22px', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 18 }}>
        <SmStat label="complete" value={328} dot={SH.ok} />
        <SmStat label="in progress" value={6} dot={SH.warn} />
        <SmStat label="not started" value={43} dot={SH.ink3} />
        <SmStat label="blocked" value={11} dot={SH.block} />
      </div>
      <div style={{ padding: '14px 20px', borderLeft: `1px solid ${SH.rule}`, background: SH.accentSoft }}>
        <LaneHead style={{ color: SH.accent, marginBottom: 4 }}>* Recommended next</LaneHead>
        <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.3 }}>Verify Semantix advisory intake UI</div>
        <div style={{ display: 'flex', gap: 4, marginTop: 8 }}>
          <Bracket active>PICK</Bracket>
          <Bracket>READ</Bracket>
        </div>
      </div>
    </div>
  );
}

function SmStat({ label, value, dot }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: dot, display: 'inline-block' }} />
        <span style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3, letterSpacing: 0.5, textTransform: 'uppercase' }}>{label}</span>
      </div>
      <div style={{ fontSize: 22, fontWeight: 600, lineHeight: 1 }}>{value}</div>
    </div>
  );
}

// ── Session rail (NEW) ──────────────────────────────────────
function BIB_SessionRail({ onOpenSession, onStart, onAttach }) {
  const sessions = [
    { id: 'ses-7Q4F', tier: 'codex',  state: 'active',   stateLabel: 'ACTIVE · 2m',      task: 'rm-semantix-alignment-intake',          profile: 'code-implementer', model: 'sonnet-4.5', sandbox: 'workspace', ctxUsed: 62 },
    { id: 'ses-K2WX', tier: 'hybrid', state: 'approval', stateLabel: 'APPROVAL · 38s',   task: 'rm-plane-global-completion-gap-register',profile: 'reviewer',         model: 'opus-4.5',   sandbox: 'workspace', ctxUsed: 84 },
    { id: 'ses-9HCM', tier: 'mcp',    state: 'contexth', stateLabel: 'CTX HIGH · 89%',   task: 'rm-runtime-required-handle-truth',       profile: 'planner',          model: 'sonnet-4.5', sandbox: 'readonly',  ctxUsed: 178 },
    { id: 'ses-2NEW', tier: 'mcp',    state: 'active',   stateLabel: 'ACTIVE · 47s',     task: 'rm-spec-studio-flow-proof',              profile: 'code-implementer', model: 'sonnet-4.5', sandbox: 'workspace', ctxUsed: 31 },
  ];
  return (
    <div style={{
      borderBottom: `1px solid ${SH.rule}`,
      background: SH.paperAlt,
      padding: '12px 22px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
        <LaneHead style={{ color: SH.accent, fontWeight: 600 }}>● Sessions · 4 in this project</LaneHead>
        <span style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3 }}>drag a task card onto a session to attach · onto [+] to start a new one</span>
        <div style={{ flex: 1 }} />
        <Bracket dense>FILTER</Bracket>
        <Bracket dense>SORT: URGENCY</Bracket>
        <Bracket dense dim>COLLAPSE</Bracket>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr) 200px', gap: 10 }}>
        {sessions.map(s => <RailCard key={s.id} s={s} onOpen={onOpenSession} onAttach={onAttach} />)}
        <NewSessionDrop onStart={onStart} />
      </div>
    </div>
  );
}

function RailCard({ s, onOpen, onAttach }) {
  const [over, setOver] = React.useState(false);
  const tone = s.state === 'active'   ? 'ok'
             : s.state === 'approval' ? 'block'
             : s.state === 'quiet'    ? 'warn'
             : s.state === 'contexth' ? 'info'
             :                          'ink2';
  const c = tone === 'ok' ? SH.ok : tone === 'block' ? SH.block : tone === 'warn' ? SH.warn : tone === 'info' ? SH.info : SH.ink2;
  return (
    <div
      className={'sh-drop-target' + (over ? ' is-over' : '')}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('application/x-task-id')) { e.preventDefault(); e.dataTransfer.dropEffect = 'link'; } }}
      onDragEnter={(e) => { if (e.dataTransfer.types.includes('application/x-task-id')) setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        const taskId = e.dataTransfer.getData('application/x-task-id');
        setOver(false);
        if (taskId && onAttach) onAttach(taskId, s.id);
      }}
      style={{
      background: SH.paper,
      border: `1px solid ${SH.rule}`,
      borderLeft: `3px solid ${c}`,
      padding: '8px 10px',
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3 }}>{s.id}</span>
        <span style={{ flex: 1 }} />
        <CapTier tier={s.tier} />
      </div>
      <div style={{ fontSize: 12, fontWeight: 600 }}>{s.profile}</div>
      <div style={{ fontFamily: shMono, fontSize: 10, color: SH.ink2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {s.task}
      </div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        fontFamily: shMono, fontSize: 10, color: c,
        background: tone === 'ok' ? SH.okSoft : tone === 'block' ? SH.blockSoft : tone === 'warn' ? SH.warnSoft : tone === 'info' ? SH.infoSoft : SH.bgSink,
        padding: '3px 6px',
      }}>
        <Dot tone={tone} pulse={s.state === 'active' || s.state === 'approval'} />
        {s.stateLabel}
      </div>
      {/* live row: model + sandbox + ctx */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
        <ModelChip model={s.model} />
        <SandboxChip mode={s.sandbox} />
      </div>
      <ContextMeter used={s.ctxUsed} total={200} width={100} compact />
      <div style={{ display: 'flex', gap: 3, marginTop: 2 }}>
        <Bracket dense onClick={onOpen}>OPEN</Bracket>
        <Bracket dense dim>CHAT</Bracket>
        <Bracket dense dim>RESTART</Bracket>
      </div>
    </div>
  );
}

function NewSessionDrop({ onStart }) {
  const [over, setOver] = React.useState(false);
  return (
    <div
      className={'sh-drop-target' + (over ? ' is-over' : '')}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('application/x-task-id')) { e.preventDefault(); e.dataTransfer.dropEffect = 'link'; } }}
      onDragEnter={(e) => { if (e.dataTransfer.types.includes('application/x-task-id')) setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        const taskId = e.dataTransfer.getData('application/x-task-id');
        setOver(false);
        if (taskId && onStart) onStart(taskId);
      }}
      style={{
      border: `1px dashed ${SH.accent}77`,
      background: SH.accentSoft,
      padding: '8px 10px',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 6, textAlign: 'center',
    }}>
      <span style={{ fontFamily: shMono, fontSize: 18, color: SH.accent, fontWeight: 600 }}>+</span>
      <span style={{ fontFamily: shMono, fontSize: 10, color: SH.accent, letterSpacing: 0.6 }}>
        drop task here<br/>or click to start
      </span>
      <div style={{ display: 'flex', gap: 3 }}>
        <Bracket dense active onClick={onStart}>RUN</Bracket>
        <Bracket dense>ATTACH</Bracket>
      </div>
    </div>
  );
}

// ── Board head ──────────────────────────────────────────────
function BIB_BoardHead() {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14,
      padding: '10px 22px',
      background: SH.paper,
      borderBottom: `1px solid ${SH.rule}`,
    }}>
      <LaneHead>view</LaneHead>
      <Bracket active dense>SWIMLANE</Bracket>
      <Bracket dense dim>TREE</Bracket>
      <Bracket dense dim>GRAPH</Bracket>
      <div style={{ flex: 1 }} />
      <LaneHead>status</LaneHead>
      <Bracket dense>COMPLETE · 328</Bracket>
      <Bracket dense active>IN PROGRESS · 6</Bracket>
      <Bracket dense>NOT STARTED · 43</Bracket>
      <Bracket dense dim>DEFERRED · 4</Bracket>
    </div>
  );
}

// ── Lane with session-bound task cards ─────────────────────
function BIB_Lane({ onOpenSession, onStart }) {
  return (
    <div style={{ background: SH.paper, padding: '14px 22px', display: 'grid', gridTemplateColumns: '240px 1fr 1fr 1fr', gap: 0, borderBottom: `1px solid ${SH.rule}` }}>
      <div style={{
        background: SH.bg, padding: '14px 18px',
        borderRight: `1px solid ${SH.rule}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <span style={{ fontFamily: shMono, color: SH.accent, fontSize: 11 }}>▾</span>
          <span style={{ fontSize: 13, fontWeight: 600 }}>GOVERNANCE & TRUST</span>
          <span style={{ flex: 1 }} />
          <Bracket dense onClick={() => onStart && onStart(null)}>+ NEXT IN LANE</Bracket>
        </div>
        <div style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3, letterSpacing: 0.5, marginBottom: 8 }}>
          109 TASKS · 4 ACTIVE
        </div>
        <div style={{ fontSize: 11, color: SH.ink2, lineHeight: 1.5 }}>
          Control-plane safety, approval surfaces, separation, and operator trust seams.
        </div>
      </div>
      <BoundTaskCell
        id="rm-plane-global-completion-gap-register"
        title="Track global plane-separation completion gaps"
        body="Own the explicit broader global-completion bar from the 2026-05-19 evidence register without reopening reviewer-closed bounded plane-separation slices."
        sessionId="ses-K2WX"
        sessionState="approval"
        sessionTier="hybrid"
        onOpen={onOpenSession}
      />
      <BoundTaskCell
        id="rm-semantix-alignment-intake"
        title="Semantix alignment intake before Staff"
        body="Add Semantix as a pre-Staff alignment layer that produces a typed user-approved alignment packet before Staff decomposes the project."
        sessionId="ses-7Q4F"
        sessionState="active"
        sessionTier="codex"
        onOpen={onOpenSession}
      />
      <UnboundTaskCell
        id="rm-runtime-helper-file-materialization"
        title="Runtime helper-file / checklist materialization"
        body="Owns the remaining provider-native helper-file, checklist, or workflow-pack-aware runtime materialization scope split out of the closed row-5 runtime-config seam."
        onStart={() => onStart && onStart('rm-runtime-helper-file-materialization')}
      />
    </div>
  );
}

function BoundTaskCell({ id, title, body, sessionId, sessionState, sessionTier, onOpen }) {
  const stateMap = {
    active:   { tone: 'ok',    label: 'SESSION ACTIVE',   bg: SH.okSoft,    color: SH.ok    },
    approval: { tone: 'block', label: 'SESSION · APPROVAL', bg: SH.blockSoft, color: SH.block },
    quiet:    { tone: 'warn',  label: 'SESSION QUIET',    bg: SH.warnSoft,  color: SH.warn  },
  };
  const st = stateMap[sessionState];
  return (
    <div style={{ borderLeft: `1px solid ${SH.rule}`, padding: '14px 16px', minHeight: 260 }}>
      <div style={{
        border: `1px solid ${SH.rule}`,
        borderLeft: `3px solid ${st.color}`,
        background: SH.paper,
        padding: '12px 14px',
        display: 'flex', flexDirection: 'column', gap: 8,
        position: 'relative',
      }}>
        <div style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3 }}>{id}</div>
        <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.3 }}>{title}</div>
        <div style={{ fontSize: 12, color: SH.ink2, lineHeight: 1.5 }}>{body}</div>

        {/* Session binding badge */}
        <div style={{
          marginTop: 4,
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '6px 8px',
          background: st.bg,
          border: `1px solid ${st.color}33`,
        }}>
          <Dot tone={st.tone} pulse />
          <span style={{ fontFamily: shMono, fontSize: 10, letterSpacing: 0.5, color: st.color, fontWeight: 600 }}>
            {st.label}
          </span>
          <span style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3 }}>{sessionId}</span>
          <CapTier tier={sessionTier} />
          <span style={{ flex: 1 }} />
          <Bracket dense active tone={st.tone} onClick={onOpen}>OPEN ↗</Bracket>
        </div>

        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 2 }}>
          <Bracket dense>READ</Bracket>
          <Bracket dense>WHY</Bracket>
          <Bracket dense>EXEC</Bracket>
          <Bracket dense>VERIFY</Bracket>
          <Bracket dense>HANDOFF</Bracket>
        </div>
      </div>
    </div>
  );
}

function UnboundTaskCell({ id, title, body, onStart }) {
  const [dragging, setDragging] = React.useState(false);
  return (
    <div style={{ borderLeft: `1px solid ${SH.rule}`, padding: '14px 16px', minHeight: 260 }}>
      <div
        className={'sh-draggable' + (dragging ? ' sh-dragging' : '')}
        draggable={true}
        onDragStart={(e) => {
          e.dataTransfer.setData('application/x-task-id', id);
          e.dataTransfer.effectAllowed = 'link';
          setDragging(true);
        }}
        onDragEnd={() => setDragging(false)}
        style={{
        border: `1px solid ${SH.rule}`,
        background: SH.paper,
        padding: '12px 14px',
        display: 'flex', flexDirection: 'column', gap: 8,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{
            fontFamily: shMono, fontSize: 9, letterSpacing: 0.6,
            color: SH.ink3, padding: '1px 5px',
            background: SH.bgSink, border: `1px solid ${SH.rule}`,
          }}>⠦ drag</span>
          <span style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3 }}>{id}</span>
        </div>
        <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.3 }}>{title}</div>
        <div style={{ fontSize: 12, color: SH.ink2, lineHeight: 1.5 }}>{body}</div>

        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
          <Bracket dense>READ</Bracket>
          <Bracket dense>WHY</Bracket>
          <Bracket dense>EXEC</Bracket>
          <Bracket dense>VERIFY</Bracket>
          <Bracket dense active tone="accent" onClick={onStart}>+ RUN SESSION</Bracket>
        </div>
      </div>
    </div>
  );
}

window.SessionBoardIntegration = SessionBoardIntegration;
