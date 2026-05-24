// Session Brief — the launch flow.
// One screen, used for BOTH:
//   · mode='new'      — create a fresh session for one or more tasks
//   · mode='rollover' — build a successor session for an existing one hitting context
// Two columns: pick (tasks, evidence, runtime)  |  preview (editable prompt)

function SessionBrief({ mode = 'new', presetTaskIds = [], predecessor, lockedFromBoard, onLaunch, onCancel }) {
  const isRollover = mode === 'rollover';
  const isLocked = lockedFromBoard && presetTaskIds.length > 0;

  // ── task set (multi-select) ─────────────────────────────
  const [tasks, setTasks] = React.useState(() => {
    if (presetTaskIds.length) return presetTaskIds;
    if (isRollover) return ['rm-runtime-required-handle-truth'];
    return ['rm-runtime-helper-file-materialization'];
  });
  const toggleTask = (id) => setTasks(t => t.includes(id) ? t.filter(x => x !== id) : [...t, id]);

  // ── evidence toggles ────────────────────────────────────
  const [evidence, setEvidence] = React.useState({
    brief: true, deps: true, dod: true,
    snapshots: true, changedSince: isRollover, gitDiff: true, gitLog: isRollover,
    watcher: true, conflicts: true, skillLog: isRollover,
    predecessorClaim: false,
  });
  const setEv = (k, v) => setEvidence(e => ({ ...e, [k]: v }));

  // ── runtime ─────────────────────────────────────────────
  const [profile, setProfile] = React.useState('code-implementer');
  const [agent,   setAgent]   = React.useState('codex-app');
  const [model,   setModel]   = React.useState('sonnet-4.5');
  const [sandbox, setSandbox] = React.useState('workspace');

  return (
    <div style={{
      fontFamily: shSans,
      background: SH.bg,
      width: 1440,
      border: `1px solid ${SH.rule}`,
    }}>
      <BriefTopBar isRollover={isRollover} predecessor={predecessor} isLocked={isLocked} onCancel={onCancel} />
      <PreflightBanner checks={isLocked ? PREFLIGHT_DEFAULT : PREFLIGHT_DEFAULT} />

      <div style={{ display: 'grid', gridTemplateColumns: '480px 1fr', background: SH.paper }}>
        <BriefPickPane
          tasks={tasks} toggleTask={toggleTask}
          evidence={evidence} setEv={setEv}
          profile={profile} setProfile={setProfile}
          agent={agent} setAgent={setAgent}
          model={model} setModel={setModel}
          sandbox={sandbox} setSandbox={setSandbox}
          isRollover={isRollover}
          isLocked={isLocked}
        />
        <BriefPreviewPane
          tasks={tasks} evidence={evidence}
          profile={profile} model={model} sandbox={sandbox} agent={agent}
          isRollover={isRollover} predecessor={predecessor}
        />
      </div>

      <BriefActions
        isRollover={isRollover}
        tasks={tasks}
        onCancel={onCancel} onLaunch={onLaunch}
        sandbox={sandbox}
      />
    </div>
  );
}

// ── Top bar ─────────────────────────────────────────────────
function BriefTopBar({ isRollover, predecessor, isLocked, onCancel }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14,
      padding: '12px 22px',
      borderBottom: `1px solid ${SH.rule}`,
      background: SH.paper,
    }}>
      <Bracket dense onClick={onCancel}>← BACK</Bracket>
      <span style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3, letterSpacing: 1 }}>SESSION HUB</span>
      <span style={{ fontSize: 16, fontWeight: 600 }}>
        {isRollover ? 'Run Session · successor' : 'Run Session'}
      </span>
      {isRollover && predecessor && (
        <span style={{
          fontFamily: shMono, fontSize: 10, color: SH.ink3,
          padding: '2px 6px', border: `1px solid ${SH.rule}`,
        }}>
          {predecessor} → ses-NEW
        </span>
      )}
      {isLocked && (
        <span style={{
          fontFamily: shMono, fontSize: 10, color: SH.accent, letterSpacing: 0.5,
          padding: '2px 6px', background: SH.accentSoft, border: `1px solid ${SH.accent}33`,
        }}>
          · launched from board · task locked
        </span>
      )}
      <span style={{ flex: 1 }} />
      <span style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3 }}>
        {isRollover
          ? 'successor context is built from durable evidence, not predecessor self-summary'
          : 'launch brief: task + dependencies + DoD + changed-since pack stitched into the launch prompt'}
      </span>
    </div>
  );
}

// ── Left "pick" pane ────────────────────────────────────────
function BriefPickPane({ tasks, toggleTask, evidence, setEv, profile, setProfile, agent, setAgent, model, setModel, sandbox, setSandbox, isRollover, isLocked }) {
  return (
    <div style={{
      padding: '16px 22px',
      borderRight: `1px solid ${SH.rule}`,
      background: SH.paperAlt,
      display: 'flex', flexDirection: 'column', gap: 18,
    }}>
      {/* TASKS */}
      <Section
        title={isLocked ? 'task · locked' : 'tasks'}
        sub={isLocked
          ? `pre-filled from board click — click [change task] to unlock`
          : `${tasks.length} selected · the session may report status via session/job events as it works`}>
        <TaskPickList tasks={tasks} toggleTask={toggleTask} isLocked={isLocked} />
        {!isLocked && <div style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3, marginTop: 6 }}>
          <span style={{ textDecoration: 'underline', cursor: 'pointer' }}>+ add task</span> · <span style={{ textDecoration: 'underline', cursor: 'pointer' }}>+ add lane</span>
        </div>}
        {isLocked && <div style={{ marginTop: 6 }}>
          <Bracket dense dim>change task</Bracket>
        </div>}
      </Section>

      {/* EVIDENCE */}
      <Section
        title="evidence in brief"
        sub="toggle what gets stitched into the launch prompt">
        <EvBox k="brief"         label="task brief + why + execute + verify"  on={evidence.brief}        onChange={v => setEv('brief', v)} />
        <EvBox k="deps"          label="dependencies + DoD"                   on={evidence.deps}         onChange={v => setEv('deps', v)} />
        <EvBox k="snapshots"     label="snapshots + history (since last)"     on={evidence.snapshots}    onChange={v => setEv('snapshots', v)} />
        <EvBox k="changedSince"  label="changed-since pack (git diff)"        on={evidence.changedSince} onChange={v => setEv('changedSince', v)} />
        <EvBox k="watcher"       label="file watcher trail (advisory)"        on={evidence.watcher}      onChange={v => setEv('watcher', v)} />
        <EvBox k="conflicts"     label="conflict scan (other sessions)"       on={evidence.conflicts}    onChange={v => setEv('conflicts', v)} />
        {isRollover && (
          <>
            <EvBox k="skillLog"        label="predecessor's skill-run log"            on={evidence.skillLog} onChange={v => setEv('skillLog', v)} />
            <EvBox k="predecessorClaim" label="predecessor self-report (CLAIM only)"   on={evidence.predecessorClaim} onChange={v => setEv('predecessorClaim', v)} warn />
          </>
        )}
      </Section>

      {/* RUNTIME */}
      <Section title="runtime">
        <PickRow label="profile"  value={profile} onChange={setProfile} options={[
          { v: 'code-implementer', l: 'code-implementer' },
          { v: 'planner',          l: 'planner' },
          { v: 'reviewer',         l: 'reviewer' },
          { v: 'code-runner',      l: 'code-runner' },
        ]} />
        <PickRow label="agent"    value={agent} onChange={setAgent} options={[
          { v: 'codex-app', l: 'codex · app-server' },
          { v: 'codex-cli', l: 'codex · cli' },
          { v: 'claude',    l: 'claude · cli' },
          { v: 'plain',     l: 'generic wrapper (dumb-term)' },
        ]} />
        <PickRow label="model"    value={model} onChange={setModel} options={[
          { v: 'sonnet-4.5', l: 'sonnet-4.5 · 200k' },
          { v: 'opus-4.5',   l: 'opus-4.5 · 200k' },
          { v: 'haiku-4.5',  l: 'haiku-4.5 · 200k' },
          { v: 'gpt-5.1',    l: 'gpt-5.1 · 256k' },
        ]} />
        <PickRow label="sandbox"  value={sandbox} onChange={setSandbox} options={[
          { v: 'readonly',  l: 'read-only' },
          { v: 'workspace', l: 'workspace-write' },
          { v: 'autoedit',  l: 'auto-edit' },
          { v: 'full',      l: 'full-auto · danger' },
        ]} />
        <CapabilityMatrix agent={agent} />
      </Section>
    </div>
  );
}

function Section({ title, sub, children }) {
  return (
    <div>
      <LaneHead style={{ marginBottom: 6 }}>{title}</LaneHead>
      {sub && <div style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3, marginBottom: 8, lineHeight: 1.5 }}>{sub}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{children}</div>
    </div>
  );
}

function TaskPickList({ tasks, toggleTask, isLocked }) {
  const candidates = [
    { id: 'rm-runtime-helper-file-materialization', title: 'Runtime helper-file / checklist materialization', lane: 'GOVERNANCE', dod: 4, status: 'not_started', recommended: true },
    { id: 'rm-runtime-required-handle-truth',       title: 'Required-handle truth in runtime substrate',    lane: 'GOVERNANCE', dod: 3, status: 'in_progress' },
    { id: 'rm-spec-studio-flow-proof',              title: 'Spec studio flow proof',                          lane: 'SPEC',       dod: 5, status: 'not_started' },
    { id: 'rm-mcp-tool-call-contracts',             title: 'MCP tool-call contracts (children: 3)',           lane: 'PLATFORM',   dod: 6, status: 'not_started', child: true },
  ];
  return (
    <>
      {candidates.map(c => {
        const on = tasks.includes(c.id);
        return (
          <div key={c.id} onClick={() => !isLocked && toggleTask(c.id)} style={{
            display: 'flex', alignItems: 'flex-start', gap: 10,
            padding: '8px 10px',
            background: on ? SH.paper : (isLocked ? 'transparent' : 'transparent'),
            border: on ? `1px solid ${SH.accent}55` : `1px dashed ${SH.rule}`,
            borderLeft: on ? `3px solid ${SH.accent}` : `3px solid transparent`,
            cursor: isLocked ? 'default' : 'pointer',
            opacity: isLocked && !on ? 0.4 : 1,
          }}>
            <span style={{
              width: 13, height: 13,
              border: `1.5px solid ${on ? SH.accent : SH.ink4}`,
              background: on ? SH.accent : 'transparent',
              position: 'relative', flexShrink: 0, marginTop: 2,
              fontSize: 10, color: '#fff', fontWeight: 700,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>{on ? '✓' : ''}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600, lineHeight: 1.35, color: SH.ink }}>{c.title}</div>
              <div style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3, marginTop: 2, display: 'flex', gap: 6, alignItems: 'center' }}>
                <span>{c.id}</span>
                <span>·</span>
                <span style={{ color: c.status === 'in_progress' ? SH.warn : c.status === 'done' ? SH.ok : SH.ink3 }}>
                  {c.status === 'not_started' ? 'STATUS:NOT_STARTED'
                  : c.status === 'in_progress' ? 'STATUS:IN_PROGRESS'
                  : c.status === 'done' ? 'STATUS:DONE' : c.status.toUpperCase()}
                </span>
                <span>·</span>
                <span>{c.dod} DoD</span>
                {c.recommended && <MonoPill tone="accent" filled>* fit</MonoPill>}
              </div>
            </div>
            <MonoPill>{c.lane}</MonoPill>
          </div>
        );
      })}
    </>
  );
}

function EvBox({ label, on, onChange, warn }) {
  return (
    <div onClick={() => onChange(!on)} style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '5px 8px',
      background: on ? SH.paper : 'transparent',
      border: on ? `1px solid ${SH.ruleSoft}` : `1px dashed ${SH.rule}`,
      cursor: 'pointer',
    }}>
      <span style={{
        width: 12, height: 12,
        border: `1.5px solid ${on ? SH.ok : SH.ink4}`,
        background: on ? SH.ok : 'transparent',
        position: 'relative', flexShrink: 0,
        fontSize: 10, color: '#fff', fontWeight: 700,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>{on ? '✓' : ''}</span>
      <span style={{
        fontSize: 12, color: warn ? SH.warn : SH.ink, lineHeight: 1.4, flex: 1,
      }}>
        {warn && '! '}{label}
      </span>
    </div>
  );
}

function PickRow({ label, value, onChange, options }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '5px 0',
    }}>
      <span style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3, minWidth: 60, letterSpacing: 0.5 }}>{label}</span>
      <select value={value} onChange={e => onChange(e.target.value)} style={{
        flex: 1, fontFamily: shMono, fontSize: 11, padding: '4px 6px',
        border: `1px solid ${SH.rule}`, background: SH.paper, color: SH.ink,
      }}>
        {options.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
      </select>
    </div>
  );
}

// ── Right preview pane ──────────────────────────────────────
function BriefPreviewPane({ tasks, evidence, profile, model, sandbox, agent, isRollover, predecessor }) {
  const [tab, setTab] = React.useState('prompt');
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {/* tabs */}
      <div style={{
        display: 'flex', borderBottom: `1px solid ${SH.rule}`,
        background: SH.paper,
      }}>
        {[
          { k: 'prompt',  l: 'Prompt preview', badge: '~ 2.1k tok' },
          { k: 'evidence', l: 'Evidence', badge: Object.values(evidence).filter(Boolean).length + ' on' },
          { k: 'cli',     l: 'CLI equivalent' },
        ].map(t => (
          <div key={t.k} onClick={() => setTab(t.k)} style={{
            padding: '12px 18px', fontSize: 13,
            fontWeight: tab === t.k ? 600 : 400,
            color: tab === t.k ? SH.accent : SH.ink2,
            borderBottom: tab === t.k ? `2px solid ${SH.accent}` : '2px solid transparent',
            cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            {t.l}
            {t.badge && <span style={{ fontFamily: shMono, fontSize: 9, color: SH.ink3, background: SH.bgSink, padding: '1px 5px' }}>{t.badge}</span>}
          </div>
        ))}
        <span style={{ flex: 1 }} />
        <div style={{ padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Bracket dense>REGENERATE</Bracket>
          <Bracket dense dim>COPY</Bracket>
        </div>
      </div>

      {tab === 'prompt'   && <PromptText tasks={tasks} evidence={evidence} profile={profile} isRollover={isRollover} predecessor={predecessor} />}
      {tab === 'evidence' && <EvidenceTab evidence={evidence} isRollover={isRollover} />}
      {tab === 'cli'      && <CliTab tasks={tasks} profile={profile} agent={agent} model={model} sandbox={sandbox} />}
    </div>
  );
}

function PromptText({ tasks, evidence, profile, isRollover, predecessor }) {
  const primary = tasks[0] || '(none)';
  return (
    <div style={{
      flex: 1,
      padding: '16px 22px',
      background: SH.bg,
      fontFamily: shMono, fontSize: 12, color: SH.ink, lineHeight: 1.7,
      whiteSpace: 'pre-wrap',
      minHeight: 480,
    }}>
      <div style={{ color: SH.ink3, fontSize: 10, letterSpacing: 0.4, marginBottom: 8 }}>
        # llm-tracker · launch brief · editable
      </div>
      <span style={{ color: SH.accent }}>You are a {profile} session.</span>{'\n\n'}

      {isRollover && <>
        <span style={{ color: SH.ink3 }}>Predecessor</span> <span style={{ color: SH.ink }}>{predecessor || 'ses-9HCM'}</span> <span style={{ color: SH.ink3 }}>rolled over at 89% context.</span>{'\n'}
        <span style={{ color: SH.ink3 }}>Do NOT trust its self-summary. The evidence below is authoritative.</span>{'\n\n'}
      </>}

      <span style={{ color: SH.accent }}>## Task{tasks.length > 1 ? 's' : ''}</span>{'\n'}
      {tasks.map((t, i) => (
        <span key={t}>
          {i + 1}. {t}{'\n'}
        </span>
      ))}
      {'\n'}

      {evidence.brief && <>
        <span style={{ color: SH.accent }}>## Brief @ rev:984</span>{'\n'}
        Make {primary.split('-').slice(1, 4).join(' ')} load-bearing by having upstream typed truth{'\n'}
        cover the case explicitly. See referenced docs for prior decisions.{'\n\n'}
      </>}

      {evidence.deps && <>
        <span style={{ color: SH.accent }}>## Dependencies (satisfied)</span>{'\n'}
        - rm-runtime-substrate-baseline (closed @ rev:914){'\n'}
        - rm-decision-gated-followon  (closed @ rev:962){'\n\n'}
      </>}

      {evidence.dod && <>
        <span style={{ color: SH.accent }}>## Definition of done</span>{'\n'}
        - adapters/required-handle.ts emits invariant trace{'\n'}
        - lt.verify returns clean{'\n'}
        - runtime-substrate doc updated{'\n\n'}
      </>}

      {evidence.changedSince && <>
        <span style={{ color: SH.accent }}>## Changed since (rev:947 → rev:984)</span>{'\n'}
        14 commits · 47 files · scaffolding for required-handle landed in adapters/,{'\n'}
        plus 3 tests under tests/integration/runtime/.{'\n\n'}
      </>}

      {evidence.conflicts && <>
        <span style={{ color: SH.accent }}>## Worktree state</span>{'\n'}
        ✓ no conflicting sessions on this branch{'\n\n'}
      </>}

      <span style={{ color: SH.accent }}>## Reporting · session/job/skill events first</span>{'\n'}
      Use these MCP tools as you work — they feed the runtime view, skill plan,{'\n'}
      and completion gates:{'\n'}
      - <span style={{ color: SH.info }}>tracker_session_heartbeat</span> — periodic, with ctx_pct + msgs_seen{'\n'}
      - <span style={{ color: SH.info }}>tracker_job_checkpoint</span> — at meaningful pause points{'\n'}
      - <span style={{ color: SH.info }}>tracker_session_blocked</span> / <span style={{ color: SH.info }}>tracker_session_unblocked</span>{'\n'}
      - <span style={{ color: SH.info }}>tracker_skill_run_started</span> / <span style={{ color: SH.info }}>tracker_skill_run_complete</span>{'\n'}
      - <span style={{ color: SH.info }}>tracker_session_handoff</span> — on stop{'\n\n'}

      <span style={{ color: SH.warn }}>## Patch durable tracker state sparingly</span>{'\n'}
      Direct <span style={{ color: SH.info }}>tracker_task_set_status</span> is allowed but should ONLY be used when{'\n'}
      durable project truth actually changes. The hub will warn if you mark{'\n'}
      a task complete while skill/verify gates lack evidence.{'\n\n'}

      {evidence.predecessorClaim && <>
        <span style={{ background: SH.warnSoft, color: SH.warn, padding: '1px 4px' }}>
          ! predecessor advisory handoff: CLAIM only · see /handoff/{predecessor || 'ses-9HCM'}
        </span>
      </>}
    </div>
  );
}

function EvidenceTab({ evidence, isRollover }) {
  const groups = [
    { title: 'tracker · durable truth', items: [
      { k: 'brief',        l: 'task brief + why + execute + verify',  detail: 'rm-* @ rev:982' },
      { k: 'deps',         l: 'dependencies + DoD',                   detail: '2 deps satisfied · 3 DoD items' },
      { k: 'snapshots',    l: 'snapshots + history',                  detail: 'rev:914 → rev:982 · 14 entries' },
      { k: 'changedSince', l: 'changed-since pack',                   detail: '47 files · 1,284 lines' },
    ] },
    { title: 'git · code state', items: [
      { k: 'gitDiff', l: 'git status + diff', detail: '3 staged · 2 unstaged' },
      { k: 'gitLog',  l: 'git log since start rev', detail: '14 commits · branch: phalanx/handle-truth' },
    ] },
    { title: 'watcher · ambient evidence', items: [
      { k: 'watcher',   l: 'file watcher trail', detail: '51 files seen' },
      { k: 'conflicts', l: 'conflict scan',      detail: 'none vs other sessions' },
    ] },
    ...(isRollover ? [{ title: 'predecessor · advisory only', items: [
      { k: 'skillLog',         l: "predecessor's skill-run log", detail: '8 runs · lt.plan in progress' },
      { k: 'predecessorClaim', l: 'predecessor self-report',     detail: 'CLAIM · clearly labeled', warn: true },
    ] }] : []),
  ];
  return (
    <div style={{ padding: '16px 22px', background: SH.paper, flex: 1 }}>
      {groups.map(g => (
        <div key={g.title} style={{ marginBottom: 14 }}>
          <LaneHead style={{ marginBottom: 6 }}>{g.title}</LaneHead>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {g.items.map(it => (
              <div key={it.k} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '6px 10px',
                background: evidence[it.k] ? SH.paper : SH.bgSink,
                border: `1px solid ${evidence[it.k] ? SH.ruleSoft : SH.rule}`,
                opacity: evidence[it.k] ? 1 : 0.55,
              }}>
                <span style={{ fontFamily: shMono, fontSize: 10, color: evidence[it.k] ? SH.ok : SH.ink3, fontWeight: 600, minWidth: 18 }}>
                  {evidence[it.k] ? '✓' : '○'}
                </span>
                <span style={{ flex: 1, fontSize: 12, color: SH.ink }}>{it.l}</span>
                <span style={{ fontFamily: shMono, fontSize: 10, color: it.warn ? SH.warn : SH.ink3 }}>
                  {it.warn && '! '}{it.detail}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function CliTab({ tasks, profile, agent, model, sandbox }) {
  return (
    <div style={{
      flex: 1,
      padding: '24px 22px',
      background: SH.paper,
      display: 'flex', flexDirection: 'column', gap: 16,
    }}>
      <div>
        <LaneHead style={{ marginBottom: 8 }}>equivalent cli</LaneHead>
        <div style={{
          background: SH.ink, color: SH.bg,
          padding: '14px 16px',
          fontFamily: shMono, fontSize: 12, lineHeight: 1.7,
        }}>
          $ llm-tracker session start \<br/>
          &nbsp;&nbsp;{tasks.map(t => '--task=' + t).join(' \\\n  ')} \<br/>
          &nbsp;&nbsp;--profile={profile} \<br/>
          &nbsp;&nbsp;--agent={agent} \<br/>
          &nbsp;&nbsp;--model={model} \<br/>
          &nbsp;&nbsp;--sandbox={sandbox}
        </div>
      </div>
      <div style={{
        padding: '10px 12px', background: SH.okSoft, border: `1px solid ${SH.ok}33`,
        fontFamily: shMono, fontSize: 11, color: SH.ok, lineHeight: 1.5,
      }}>
        ✓ no worktree conflicts · ✓ deps satisfied · ✓ allowed_paths cover scope
      </div>
    </div>
  );
}

// ── Actions footer ──────────────────────────────────────────
function BriefActions({ isRollover, tasks, onCancel, onLaunch, sandbox }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '12px 22px',
      borderTop: `1px solid ${SH.rule}`,
      background: SH.paper,
    }}>
      <span style={{ fontFamily: shMono, fontSize: 11, color: SH.ink3 }}>
        on launch: {tasks.length} task{tasks.length !== 1 ? 's' : ''} bound · skill plan starts at <span style={{ color: SH.accent }}>lt.scope</span> · session appears in hub
        {sandbox === 'full' && <span style={{ color: SH.block }}> · sandbox=full-auto, no approvals will be asked</span>}
      </span>
      <span style={{ flex: 1 }} />
      <Bracket dim onClick={onCancel}>CANCEL</Bracket>
      <Bracket dim>SAVE BRIEF</Bracket>
      <Bracket active onClick={onLaunch}>
        {isRollover ? 'LAUNCH SUCCESSOR →' : 'LAUNCH SESSION →'}
      </Bracket>
    </div>
  );
}

window.SessionBrief = SessionBrief;
