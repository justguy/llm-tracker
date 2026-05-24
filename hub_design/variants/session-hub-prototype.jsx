// Interactive prototype shell — v0.4
// Views: BOARD · HUB · TRIAGE · RUN-SESSION
// Triage promoted to first-class nav. Attention strip carries inline actions.
// Brief renamed to Run Session everywhere visible.

function SessionHubPrototype() {
  const [view, setView]   = React.useState('hub');
  const [modal, setModal] = React.useState(null);
  const [briefMode, setBriefMode] = React.useState('new');
  const [briefTaskIds, setBriefTaskIds] = React.useState([]);
  const [briefLocked, setBriefLocked]   = React.useState(false);
  const [briefPredecessor, setBriefPredecessor] = React.useState(null);
  const [attach, setAttach] = React.useState(null); // { taskId, sessionId }
  const [toast, setToast]   = React.useState(null);

  const openRunNew = (taskId, opts = {}) => {
    setBriefMode('new');
    setBriefTaskIds(taskId ? [taskId] : []);
    setBriefLocked(!!opts.locked);
    setBriefPredecessor(null);
    setView('run');
  };
  const openRunRollover = (predecessor) => {
    setBriefMode('rollover');
    setBriefTaskIds(['rm-runtime-required-handle-truth']);
    setBriefLocked(true);
    setBriefPredecessor(predecessor || 'ses-9HCM');
    setView('run');
  };
  const openAttach = (taskId, sessionId) => {
    setAttach({ taskId, sessionId });
  };
  const confirmAttach = () => {
    const { taskId, sessionId } = attach;
    setAttach(null);
    setToast(`attached ${taskId} → ${sessionId} · binding written`);
  };

  const attention = { approval: 1, quiet: 1, ctx: 1, blocked: 1, total: 4 };

  return (
    <div style={{ position: 'relative', width: 1440, fontFamily: shSans }}>
      <NavBar
        view={view} setView={setView}
        attention={attention}
        onNewSession={() => openRunNew(null)}
        onModel={() => setModal('model')}
        onRestart={() => setModal('restart')}
      />
      <AttentionStrip
        attention={attention}
        view={view}
        onOpenTriage={() => setView('triage')}
        onRollover={() => openRunRollover('ses-9HCM')}
        onOpenSession={() => { setView('hub'); }}
      />

      <div style={{ position: 'relative', overflow: 'hidden' }}>
        {view === 'hub' && (
          <SessionHubGlobal
            onBrief={openRunNew}
            onRollover={() => openRunRollover('ses-9HCM')}
            onRestart={() => setModal('restart')}
            onModel={() => setModal('model')}
            defaultSizes={{ 'ses-K2WX': 'large' }}
          />
        )}
        {view === 'triage' && (
          <SessionTriage
            sessions={TRIAGE_DEFAULT}
            onOpenSession={() => setView('hub')}
            onRollover={() => openRunRollover('ses-9HCM')}
            onRestart={() => setModal('restart')}
            onModel={() => setModal('model')}
          />
        )}
        {view === 'board' && (
          <SessionBoardIntegration
            onOpenSession={() => setView('hub')}
            onStart={(taskId) => openRunNew(taskId, { locked: true })}
            onAttach={openAttach}
          />
        )}
        {view === 'run' && (
          <SessionBrief
            mode={briefMode}
            presetTaskIds={briefTaskIds}
            predecessor={briefPredecessor}
            lockedFromBoard={briefLocked}
            onCancel={() => setView(briefMode === 'rollover' ? 'hub' : 'board')}
            onLaunch={() => setView('hub')}
          />
        )}
      </div>

      {modal === 'model'   && <ModelSwitchModal onClose={() => setModal(null)} onConfirm={() => setModal(null)} />}
      {modal === 'restart' && <RestartModal     onClose={() => setModal(null)} onConfirm={() => setModal(null)} />}
      {attach && (
        <AttachTaskModal
          taskId={attach.taskId}
          sessionId={attach.sessionId}
          onClose={() => setAttach(null)}
          onConfirm={confirmAttach}
        />
      )}
      {toast && <AttachToast message={toast} onDismiss={() => setToast(null)} />}
    </div>
  );
}

function NavBar({ view, setView, attention, onNewSession, onModel, onRestart }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '8px 14px',
      background: SH.ink, color: SH.bg,
      borderBottom: `1px solid ${SH.ink}`,
    }}>
      <span style={{
        fontFamily: shMono, fontSize: 10, letterSpacing: 1.4,
        color: 'rgba(255,255,255,0.55)', marginRight: 8,
      }}>PROTOTYPE NAV</span>
      <NavBtn label="BOARD"   active={view === 'board'}   onClick={() => setView('board')} />
      <NavBtn label="HUB"     active={view === 'hub'}     onClick={() => setView('hub')} />
      <NavBtn label="TRIAGE"  active={view === 'triage'}  onClick={() => setView('triage')} badge={attention.total} />
      <NavBtn label="RUN SESSION" active={view === 'run'} onClick={() => setView('run')} />
      <span style={{ flex: 1 }} />
      <span style={{ fontFamily: shMono, fontSize: 10, color: 'rgba(255,255,255,0.5)', marginRight: 8 }}>
        global ·
      </span>
      <NavBtn label="+ NEW SESSION" onClick={onNewSession} />
      <NavBtn label="SWAP MODEL"    onClick={onModel} />
      <NavBtn label="RESTART…"      onClick={onRestart} />
    </div>
  );
}

function NavBtn({ label, active, onClick, badge }) {
  return (
    <span onClick={onClick} style={{
      fontFamily: shMono, fontSize: 11, letterSpacing: 0.4,
      padding: '3px 8px',
      border: `1px solid ${active ? SH.accent : 'rgba(255,255,255,0.18)'}`,
      background: active ? SH.accent : 'transparent',
      color: active ? '#fff' : 'rgba(255,255,255,0.78)',
      cursor: 'pointer', userSelect: 'none',
      display: 'inline-flex', alignItems: 'center', gap: 6,
    }}>
      [{label}]
      {badge ? <span style={{
        fontFamily: shMono, fontSize: 9, fontWeight: 600,
        padding: '0 5px', background: SH.block, color: '#fff',
        borderRadius: 8,
      }}>{badge}</span> : null}
    </span>
  );
}

function AttentionStrip({ attention, view, onOpenTriage, onRollover, onOpenSession }) {
  if (!attention.total) {
    return (
      <div style={{
        padding: '7px 18px',
        background: SH.okSoft,
        borderBottom: `1px solid ${SH.ok}33`,
        fontFamily: shMono, fontSize: 11, color: SH.ok, letterSpacing: 0.4,
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <Dot tone="ok" />
        all sessions ambient · nothing needs you
      </div>
    );
  }
  return (
    <div style={{
      padding: '8px 18px',
      background: SH.blockSoft,
      borderBottom: `1px solid ${SH.block}44`,
      display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
    }}>
      <span style={{ fontFamily: shMono, fontSize: 10, letterSpacing: 1, color: SH.block, fontWeight: 600 }}>
        ! ATTENTION
      </span>

      <AttentionItem tone="block" id="ses-K2WX" label="approval · shell out-of-sandbox" actions={[
        { label: 'APPROVE',   tone: 'block', primary: true, onClick: onOpenSession },
        { label: 'OPEN CHAT',                                onClick: onOpenSession },
      ]} />
      <AttentionItem tone="info" id="ses-9HCM" label="ctx 89%" actions={[
        { label: 'ROLLOVER',  tone: 'info',  primary: true, onClick: onRollover },
      ]} />
      <AttentionItem tone="warn"  id="ses-3FT8" label="quiet 12m · dumb-term" actions={[
        { label: 'STDIO',     tone: 'warn',  primary: true, onClick: onOpenSession },
        { label: 'PING',                                     onClick: onOpenSession },
      ]} />
      <AttentionItem tone="block" id="ses-PR2D" label="blocked on t-024" actions={[
        { label: 'ASK ses-V2QJ', tone: 'info', primary: true, onClick: onOpenSession },
      ]} />

      <span style={{ flex: 1 }} />
      {view !== 'triage' && <Bracket dense onClick={onOpenTriage}>OPEN TRIAGE →</Bracket>}
    </div>
  );
}

function AttentionItem({ tone, id, label, actions }) {
  const c = tone === 'ok'    ? SH.ok
          : tone === 'warn'  ? SH.warn
          : tone === 'block' ? SH.block
          : tone === 'info'  ? SH.info
          :                    SH.ink2;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      fontFamily: shMono, fontSize: 10, letterSpacing: 0.3,
      padding: '3px 7px',
      background: 'rgba(255,255,255,0.7)',
      border: `1px solid ${c}55`,
    }}>
      <Dot tone={tone} size={5} pulse={tone === 'block'} />
      <span style={{ color: SH.ink2 }}>{id}</span>
      <span style={{ color: c }}>· {label}</span>
      {actions.map((a, i) => (
        <Bracket key={i} dense tone={a.tone} active={a.primary} onClick={a.onClick}>{a.label}</Bracket>
      ))}
    </span>
  );
}

window.SessionHubPrototype = SessionHubPrototype;
