// Session Hub — modals
//  · ModelSwitchModal — clicking the model chip mid-session
//  · RestartModal     — restart matrix (preserve/clear ctx × same/new model × sandbox)
//  · StartSessionWizard — task → profile → model + sandbox + skill plan → launch

// ───────────────────────────────────────────────────────────
// ModelSwitchModal
// ───────────────────────────────────────────────────────────
function ModelSwitchModal({ onClose, onConfirm }) {
  const [selected, setSelected] = React.useState('opus-4.5');
  const [keepCtx, setKeepCtx] = React.useState(true);

  const models = [
    { id: 'sonnet-4.5', label: 'sonnet-4.5', vendor: 'anthropic', cost: '$3 / $15 per Mtok', ctx: '200k', current: true, profileOk: true },
    { id: 'opus-4.5',   label: 'opus-4.5',   vendor: 'anthropic', cost: '$15 / $75 per Mtok', ctx: '200k', recommended: true, profileOk: true },
    { id: 'haiku-4.5',  label: 'haiku-4.5',  vendor: 'anthropic', cost: '$0.80 / $4 per Mtok', ctx: '200k', profileOk: false, profileWarn: 'profile reviewer requires ≥ sonnet tier' },
    { id: 'gpt-5.1',    label: 'gpt-5.1',    vendor: 'openai',    cost: '$5 / $20 per Mtok',  ctx: '256k', profileOk: true, agentWarn: 'codex app-server: OK · skill packs untested with this provider' },
    { id: 'gpt-5.1-mini', label: 'gpt-5.1-mini', vendor: 'openai', cost: '$0.50 / $2 per Mtok', ctx: '256k', profileOk: false, profileWarn: 'profile reviewer requires ≥ sonnet tier' },
  ];

  return (
    <ModalShell onClose={onClose} title="Switch model · ses-K2WX" sub="reviewer · codex app-server · 64k / 200k context">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ fontSize: 12, color: SH.ink2, lineHeight: 1.55 }}>
          Mid-session model switch keeps the thread alive. The agent receives a
          system note confirming the swap. Skill plan continues; the next skill
          invocation runs under the new model.
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {models.map(m => (
            <ModelRow key={m.id} m={m} selected={selected === m.id} onPick={() => setSelected(m.id)} />
          ))}
        </div>

        <div style={{
          padding: '10px 12px',
          background: SH.bgSink, border: `1px solid ${SH.rule}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <input type="checkbox" checked={keepCtx} onChange={e => setKeepCtx(e.target.checked)} style={{ accentColor: SH.accent }} />
            <span style={{ fontSize: 13, color: SH.ink }}>Preserve context window (64k tokens) on swap</span>
          </div>
          <div style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3, paddingLeft: 22, lineHeight: 1.6 }}>
            {keepCtx
              ? 'agent keeps message history. tokens may re-tokenize under new model.'
              : 'fresh context. agent receives task brief + changed-since pack only.'}
          </div>
        </div>

        {selected === 'gpt-5.1' && (
          <div style={{
            padding: '10px 12px',
            background: SH.warnSoft, border: `1px solid ${SH.warn}33`,
            fontFamily: shMono, fontSize: 11, color: SH.warn, lineHeight: 1.5,
          }}>
            ! cross-vendor swap. The codex app-server adapter wraps OpenAI fine,
            but skill packs `lt.verify` and `review.changed_since` haven't been
            run end-to-end with this provider. Use with caution.
          </div>
        )}
      </div>

      <ModalFooter
        left={<span style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3 }}>swap is reversible · audit logged to runtime events</span>}
        right={<>
          <Bracket dim>CANCEL</Bracket>
          <Bracket active onClick={onConfirm}>SWAP → {selected}</Bracket>
        </>}
      />
    </ModalShell>
  );
}

function ModelRow({ m, selected, onPick }) {
  const disabled = !m.profileOk;
  return (
    <div onClick={disabled ? null : onPick} style={{
      display: 'grid',
      gridTemplateColumns: '20px 140px 80px 1fr 90px',
      alignItems: 'center', gap: 10,
      padding: '10px 12px',
      background: selected ? SH.accentSoft : SH.paper,
      border: selected ? `1px solid ${SH.accent}` : `1px solid ${SH.rule}`,
      opacity: disabled ? 0.55 : 1,
      cursor: disabled ? 'not-allowed' : 'pointer',
    }}>
      <span style={{
        width: 14, height: 14, borderRadius: '50%',
        border: `1.5px solid ${selected ? SH.accent : SH.ink4}`,
        background: selected ? SH.accent : 'transparent',
        position: 'relative',
      }}>
        {selected && <span style={{
          position: 'absolute', inset: 3, background: SH.paper, borderRadius: '50%',
        }} />}
      </span>
      <div>
        <div style={{ fontFamily: shMono, fontSize: 12, fontWeight: 600, color: SH.ink }}>
          {m.label} {m.current && <span style={{ color: SH.ink3, fontWeight: 400 }}>· current</span>}
        </div>
        <div style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3 }}>{m.vendor}</div>
      </div>
      <span style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3 }}>{m.ctx}</span>
      <span style={{ fontFamily: shMono, fontSize: 10, color: m.profileOk ? SH.ink2 : SH.warn, lineHeight: 1.4 }}>
        {m.profileWarn || m.agentWarn || m.cost}
      </span>
      <span style={{ display: 'flex', justifyContent: 'flex-end' }}>
        {m.recommended && <MonoPill tone="accent" filled>RECOMMENDED</MonoPill>}
        {!m.recommended && !m.current && m.profileOk && <MonoPill dim>compatible</MonoPill>}
      </span>
    </div>
  );
}

// ───────────────────────────────────────────────────────────
// RestartModal — restart matrix
// ───────────────────────────────────────────────────────────
function RestartModal({ onClose, onConfirm }) {
  const [preset, setPreset] = React.useState('soft');
  const presets = [
    { id: 'soft',    label: 'Soft restart',                sub: 'reload config · keep ctx · keep thread', warn: null,
      effects: ['reload skill packs', 'reload sandbox config', 'agent continues thread', 'next skill run picks up new config'] },
    { id: 'hard',    label: 'Hard restart (selected)',     sub: 'new process · keep task binding · fresh ctx', warn: null,
      effects: ['kill PID 48217', 'spawn fresh codex app-server', 'task binding preserved', 'context window reset · changed-since pack rebuilt at rev:984'] },
    { id: 'model',   label: 'Restart on new model',        sub: 'opt-in: pick a model after this', warn: null,
      effects: ['kill PID 48217', 'spawn with chosen model', 'task binding preserved', 'context: fresh + changed-since pack'] },
    { id: 'sandbox', label: 'Restart with stricter sandbox', sub: 'demote workspace-write → read-only', warn: 'agent will need approvals for previously-allowed writes',
      effects: ['kill PID 48217', 'spawn with sandbox=read-only', 'task + ctx preserved', 'pending approvals re-evaluated under new sandbox'] },
    { id: 'rollover',label: 'Roll over → successor',       sub: 'this session → archived · evidence pack to new session', warn: null,
      effects: ['this session: state → rolled_over', 'successor built from durable evidence', 'see Run Session screen for evidence selection'] },
    { id: 'quiet',   label: 'Restart all QUIET sessions',  sub: 'scope: any dumb-term session with no stdio change > 10m', warn: 'affects 1 session: ses-3FT8',
      effects: ['scopes to derived QUIET state only', 'each session restarts independently', 'sessions in ACTIVE / APPROVAL state are not touched'] },
  ];
  const current = presets.find(p => p.id === preset);

  return (
    <ModalShell onClose={onClose} title="Restart · ses-K2WX" sub="reviewer · codex app-server · pid 48217">
      <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 18 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {presets.map(p => (
            <div key={p.id} onClick={() => setPreset(p.id)} style={{
              padding: '10px 12px',
              border: preset === p.id ? `1px solid ${SH.accent}` : `1px solid ${SH.rule}`,
              background: preset === p.id ? SH.accentSoft : SH.paper,
              cursor: 'pointer',
            }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: preset === p.id ? SH.accent : SH.ink, marginBottom: 2 }}>
                {p.label}
              </div>
              <div style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3, letterSpacing: 0.3 }}>
                {p.sub}
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <LaneHead>effects · {current.label.toLowerCase()}</LaneHead>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {current.effects.map((e, i) => (
              <div key={i} style={{
                display: 'flex', gap: 8, alignItems: 'flex-start',
                fontSize: 12, color: SH.ink, lineHeight: 1.5,
              }}>
                <span style={{ color: SH.ok, fontFamily: shMono, marginTop: 1 }}>→</span>
                <span>{e}</span>
              </div>
            ))}
          </div>

          {current.warn && (
            <div style={{
              padding: '10px 12px',
              background: SH.warnSoft, border: `1px solid ${SH.warn}33`,
              fontFamily: shMono, fontSize: 11, color: SH.warn, lineHeight: 1.5,
            }}>
              ! {current.warn}
            </div>
          )}

          <div style={{
            padding: '10px 12px',
            background: SH.bgSink, border: `1px dashed ${SH.rule}`,
            fontFamily: shMono, fontSize: 11, color: SH.ink2, lineHeight: 1.6,
          }}>
            <div style={{ color: SH.ink3, fontSize: 10, letterSpacing: 0.6, marginBottom: 4 }}>EQUIVALENT CLI</div>
            {preset === 'soft'     && <>$ llm-tracker session reload ses-K2WX</>}
            {preset === 'hard'     && <>$ llm-tracker session restart ses-K2WX --fresh-ctx</>}
            {preset === 'model'    && <>$ llm-tracker session restart ses-K2WX --model=&lt;pick&gt;</>}
            {preset === 'sandbox'  && <>$ llm-tracker session restart ses-K2WX --sandbox=read-only</>}
            {preset === 'rollover' && <>$ llm-tracker session rollover ses-K2WX</>}
          </div>
        </div>
      </div>

      <ModalFooter
        left={<span style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3 }}>all variants logged · reversible until the new process emits its first skill run</span>}
        right={<>
          <Bracket dim>CANCEL</Bracket>
          <Bracket active tone={preset === 'sandbox' ? 'warn' : null} onClick={onConfirm}>
            {preset === 'rollover' ? 'OPEN ROLLOVER →' : `RESTART (${preset})`}
          </Bracket>
        </>}
      />
    </ModalShell>
  );
}

// ───────────────────────────────────────────────────────────
// StartSessionWizard — task → profile → model + sandbox → launch
// ───────────────────────────────────────────────────────────
function StartSessionWizard({ onClose, onLaunch, presetTask }) {
  const [step, setStep] = React.useState(presetTask ? 2 : 1);
  const [task, setTask] = React.useState(presetTask || 'rm-runtime-helper-file-materialization');
  const [profile, setProfile] = React.useState('code-implementer');
  const [model, setModel] = React.useState('sonnet-4.5');
  const [sandbox, setSandbox] = React.useState('workspace');
  const [agent, setAgent] = React.useState('codex-app');

  const titleSub = presetTask
    ? `task · ${presetTask} · pre-filled from board → profile · runtime · skill plan · launch`
    : 'task → profile → model + sandbox → skill plan → launch';

  return (
    <ModalShell onClose={onClose} title="Start session" sub={titleSub} wide>
      <Stepper step={step} steps={['Task', 'Profile', 'Runtime', 'Skill plan', 'Confirm']} />

      {presetTask && (
        <div style={{
          marginTop: 12,
          padding: '8px 12px',
          background: SH.accentSoft, border: `1px solid ${SH.accent}33`, borderLeft: `2px solid ${SH.accent}`,
          fontFamily: shMono, fontSize: 11, color: SH.ink, lineHeight: 1.5,
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <span style={{ color: SH.accent, letterSpacing: 0.5 }}>TASK LOCKED</span>
          <span>{presetTask}</span>
          <span style={{ flex: 1 }} />
          <span style={{ color: SH.ink3 }}>brought in from board · click step 1 to change</span>
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        {step === 1 && <StepTask task={task} setTask={setTask} />}
        {step === 2 && <StepProfile profile={profile} setProfile={setProfile} task={task} />}
        {step === 3 && <StepRuntime agent={agent} setAgent={setAgent} model={model} setModel={setModel} sandbox={sandbox} setSandbox={setSandbox} />}
        {step === 4 && <StepSkill profile={profile} />}
        {step === 5 && <StepConfirm task={task} profile={profile} model={model} sandbox={sandbox} agent={agent} />}
      </div>

      <ModalFooter
        left={<span style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3 }}>
          {step < 5 ? `${step} / 5 · esc cancels · ⏎ next` : 'will write to .runtime/sessions.jsonl · binding becomes durable'}
        </span>}
        right={<>
          {step > 1 && <Bracket dim onClick={() => setStep(step - 1)}>← BACK</Bracket>}
          <Bracket dim>SAVE DRAFT</Bracket>
          {step < 5 && <Bracket active onClick={() => setStep(step + 1)}>NEXT →</Bracket>}
          {step === 5 && <Bracket active onClick={onLaunch}>LAUNCH SESSION</Bracket>}
        </>}
      />
    </ModalShell>
  );
}

function Stepper({ step, steps }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
      {steps.map((s, i) => {
        const n = i + 1;
        const done = n < step;
        const active = n === step;
        return (
          <React.Fragment key={s}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <span style={{
                width: 22, height: 22, borderRadius: '50%',
                border: `1.5px solid ${done ? SH.ok : active ? SH.accent : SH.ink4}`,
                background: done ? SH.ok : active ? SH.accent : 'transparent',
                color: done || active ? SH.paper : SH.ink3,
                fontFamily: shMono, fontSize: 11, fontWeight: 600,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>{done ? '✓' : n}</span>
              <span style={{
                fontFamily: shMono, fontSize: 11, letterSpacing: 0.4,
                color: active ? SH.accent : done ? SH.ink : SH.ink3,
                fontWeight: active ? 600 : 400,
              }}>{s}</span>
            </div>
            {i < steps.length - 1 && (
              <span style={{ flex: 1, height: 1, background: done ? SH.ok : SH.rule, margin: '0 12px' }} />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function StepTask({ task, setTask }) {
  const candidates = [
    { id: 'rm-runtime-helper-file-materialization', title: 'Runtime helper-file materialization', lane: 'GOVERNANCE', score: 0.92, why: 'no active session · deps satisfied · P0 lane' },
    { id: 'rm-spec-studio-flow-proof',              title: 'Spec studio flow proof',              lane: 'SPEC',       score: 0.88, why: '1 ready dep just closed @ rev:982' },
    { id: 'rm-mcp-tool-call-contracts',             title: 'MCP tool-call contracts',             lane: 'PLATFORM',   score: 0.81, why: 'blocker for milestone-3 (3 children)' },
    { id: 't-024',                                  title: 'Contracts adapter — invariant proof', lane: 'HOPLON',     score: 0.74, why: 'currently bound to ses-V2QJ · conflict if parallel' },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <LaneHead>recommended tasks for next session</LaneHead>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {candidates.map(c => (
          <div key={c.id} onClick={() => setTask(c.id)} style={{
            display: 'grid', gridTemplateColumns: '14px 1fr 80px 60px',
            gap: 10, alignItems: 'center',
            padding: '10px 12px',
            border: task === c.id ? `1px solid ${SH.accent}` : `1px solid ${SH.rule}`,
            background: task === c.id ? SH.accentSoft : SH.paper,
            cursor: 'pointer',
          }}>
            <span style={{
              width: 12, height: 12,
              border: `1.5px solid ${task === c.id ? SH.accent : SH.ink4}`,
              background: task === c.id ? SH.accent : 'transparent',
            }} />
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{c.title}</div>
              <div style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3 }}>{c.id} · {c.why}</div>
            </div>
            <MonoPill>{c.lane}</MonoPill>
            <span style={{ fontFamily: shMono, fontSize: 11, color: SH.ink2, textAlign: 'right' }}>
              fit {Math.round(c.score * 100)}%
            </span>
          </div>
        ))}
      </div>
      <div style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3 }}>
        — or — <span style={{ textDecoration: 'underline' }}>browse all 67 unstarted tasks</span> · <span style={{ textDecoration: 'underline' }}>paste task id</span> · <span style={{ textDecoration: 'underline' }}>create new task</span>
      </div>
    </div>
  );
}

function StepProfile({ profile, setProfile, task }) {
  const profiles = [
    { id: 'code-implementer', label: 'code-implementer', desc: 'write + test + commit. Verify gate strict.', skills: ['lt.scope', 'lt.plan', 'lt.verify', 'lt.closeout_sweep'], match: 0.94, recommended: true },
    { id: 'planner',          label: 'planner',          desc: 'read + reason + hand off a plan. No writes.', skills: ['lt.scope', 'lt.plan', 'lt.handoff'], match: 0.62 },
    { id: 'reviewer',         label: 'reviewer',         desc: 'verify someone else\'s claim using changed-since.', skills: ['lt.scope', 'review.changed_since', 'lt.verify'], match: 0.40 },
    { id: 'code-runner',      label: 'code-runner',      desc: 'execute a known plan. Lowest skill gates.', skills: ['lt.scope', 'lt.verify'], match: 0.78 },
    { id: 'prd-writer',       label: 'prd-writer',       desc: 'shape PRD + milestones. Heavy read.', skills: ['lt.scope', 'lt.plan'], match: 0.20 },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <LaneHead>profile for `{task}`</LaneHead>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {profiles.map(p => (
          <div key={p.id} onClick={() => setProfile(p.id)} style={{
            padding: '10px 12px',
            border: profile === p.id ? `1px solid ${SH.accent}` : `1px solid ${SH.rule}`,
            background: profile === p.id ? SH.accentSoft : SH.paper,
            cursor: 'pointer',
            display: 'flex', flexDirection: 'column', gap: 6,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: profile === p.id ? SH.accent : SH.ink }}>
                {p.label}
              </span>
              {p.recommended && <MonoPill tone="accent" filled>RECOMMENDED</MonoPill>}
              <span style={{ flex: 1 }} />
              <span style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3 }}>fit {Math.round(p.match*100)}%</span>
            </div>
            <div style={{ fontSize: 12, color: SH.ink2, lineHeight: 1.4 }}>{p.desc}</div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {p.skills.map(s => <MonoPill key={s} dim>{s}</MonoPill>)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StepRuntime({ agent, setAgent, model, setModel, sandbox, setSandbox }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
      <div>
        <LaneHead style={{ marginBottom: 8 }}>agent runtime</LaneHead>
        {[
          { id: 'codex-app', l: 'codex / app-server', sub: 'structured: approvals · events · ctx · CODEX·APPSRV', tier: 'codex' },
          { id: 'codex-cli', l: 'codex / cli',        sub: 'wrapped: pseudo-tty parse · HYBRID', tier: 'hybrid' },
          { id: 'claude',    l: 'claude / cli',       sub: 'wrapped: pseudo-tty + MCP · HYBRID', tier: 'hybrid' },
          { id: 'plain',     l: 'generic wrapper',    sub: 'raw stdio only · DUMB·TERM', tier: 'dumb' },
        ].map(a => (
          <PickRow key={a.id} active={agent === a.id} onClick={() => setAgent(a.id)} label={a.l} sub={a.sub} right={<CapTier tier={a.tier} />} />
        ))}
      </div>
      <div>
        <LaneHead style={{ marginBottom: 8 }}>model</LaneHead>
        {[
          { id: 'sonnet-4.5', l: 'sonnet-4.5', sub: 'anthropic · 200k · balanced', recommended: true },
          { id: 'opus-4.5',   l: 'opus-4.5',   sub: 'anthropic · 200k · strong' },
          { id: 'haiku-4.5',  l: 'haiku-4.5',  sub: 'anthropic · 200k · cheap fast' },
          { id: 'gpt-5.1',    l: 'gpt-5.1',    sub: 'openai · 256k' },
        ].map(m => (
          <PickRow key={m.id} active={model === m.id} onClick={() => setModel(m.id)} label={m.l} sub={m.sub} right={m.recommended ? <MonoPill tone="accent" filled>REC</MonoPill> : null} />
        ))}
      </div>
      <div>
        <LaneHead style={{ marginBottom: 8 }}>sandbox</LaneHead>
        {[
          { id: 'readonly',  l: 'read-only',       sub: 'asks for any write', tone: 'ok' },
          { id: 'workspace', l: 'workspace-write', sub: 'asks outside repos.allowed_paths', tone: 'info', recommended: true },
          { id: 'autoedit',  l: 'auto-edit',       sub: 'asks only for shell/net', tone: 'warn' },
          { id: 'full',      l: 'full-auto',       sub: 'never asks · danger', tone: 'block' },
        ].map(s => (
          <PickRow key={s.id} active={sandbox === s.id} onClick={() => setSandbox(s.id)} label={s.l} sub={s.sub} right={s.recommended ? <MonoPill tone="accent" filled>REC</MonoPill> : null} />
        ))}
      </div>
    </div>
  );
}

function PickRow({ active, onClick, label, sub, right }) {
  return (
    <div onClick={onClick} style={{
      padding: '8px 10px',
      border: active ? `1px solid ${SH.accent}` : `1px solid ${SH.rule}`,
      background: active ? SH.accentSoft : SH.paper,
      marginBottom: 4, cursor: 'pointer',
      display: 'flex', alignItems: 'center', gap: 8,
    }}>
      <span style={{
        width: 12, height: 12, borderRadius: '50%',
        border: `1.5px solid ${active ? SH.accent : SH.ink4}`,
        background: active ? SH.accent : 'transparent',
        flexShrink: 0,
      }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: shMono, fontSize: 12, fontWeight: 600, color: active ? SH.accent : SH.ink }}>{label}</div>
        <div style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3, lineHeight: 1.4 }}>{sub}</div>
      </div>
      {right}
    </div>
  );
}

function StepSkill({ profile }) {
  const plan = {
    'code-implementer': [
      { k: 'lt.scope',          hook: 'before-start',    auto: true,  must: true },
      { k: 'lt.plan',           hook: 'before-start',    auto: true,  must: false },
      { k: 'lt.status_heartbeat', hook: 'checkpoint',    auto: true,  must: false },
      { k: 'lt.verify',         hook: 'before-complete', auto: true,  must: true },
      { k: 'lt.closeout_sweep', hook: 'after-complete',  auto: true,  must: true },
      { k: 'lt.handoff',        hook: 'on-stop',         auto: false, must: false },
    ],
    'planner': [
      { k: 'lt.scope',   hook: 'before-start',    auto: true, must: true },
      { k: 'lt.plan',    hook: 'before-start',    auto: true, must: true },
      { k: 'lt.handoff', hook: 'on-stop',         auto: true, must: true },
    ],
    'reviewer': [
      { k: 'lt.scope',              hook: 'before-start',    auto: true, must: true },
      { k: 'review.changed_since',  hook: 'before-start',    auto: true, must: true },
      { k: 'lt.verify',             hook: 'before-complete', auto: true, must: true },
    ],
  }[profile] || [
    { k: 'lt.scope',  hook: 'before-start',    auto: true, must: true },
    { k: 'lt.verify', hook: 'before-complete', auto: true, must: true },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <LaneHead>skill plan · derived from profile `{profile}`</LaneHead>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {plan.map((s, i) => (
          <div key={s.k} style={{
            display: 'grid', gridTemplateColumns: '40px 1fr 160px 120px 80px',
            gap: 8, alignItems: 'center',
            padding: '10px 12px',
            background: SH.paper, border: `1px solid ${SH.rule}`,
          }}>
            <span style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3 }}>#{i + 1}</span>
            <span style={{ fontFamily: shMono, fontSize: 12, color: SH.ink, fontWeight: 500 }}>{s.k}</span>
            <span style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3 }}>hook · {s.hook}</span>
            <span>
              {s.must
                ? <MonoPill tone="block" filled>MUST RUN</MonoPill>
                : <MonoPill dim>optional</MonoPill>}
            </span>
            <span style={{ fontFamily: shMono, fontSize: 10, color: s.auto ? SH.ok : SH.ink3, textAlign: 'right' }}>
              {s.auto ? '✓ auto' : '○ manual'}
            </span>
          </div>
        ))}
      </div>
      <div style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3 }}>
        edit individual skills · add custom hook · save as new profile
      </div>
    </div>
  );
}

function StepConfirm({ task, profile, model, sandbox, agent }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
      <div>
        <LaneHead style={{ marginBottom: 8 }}>about to launch</LaneHead>
        <div style={{ background: SH.bgSink, padding: '14px 16px', border: `1px solid ${SH.rule}`, fontFamily: shMono, fontSize: 12, lineHeight: 1.7, color: SH.ink }}>
          <Sum k="task"    v={task} />
          <Sum k="profile" v={profile} />
          <Sum k="agent"   v={agent} />
          <Sum k="model"   v={model} />
          <Sum k="sandbox" v={sandbox} tone={sandbox === 'full' ? 'block' : sandbox === 'autoedit' ? 'warn' : null} />
          <Sum k="cwd"     v="~/dev/Project-Phalanx" />
          <Sum k="branch"  v="phalanx/handle-truth" />
          <Sum k="start"   v="rev:984 (HEAD)" />
        </div>
      </div>
      <div>
        <LaneHead style={{ marginBottom: 8 }}>equivalent cli</LaneHead>
        <div style={{ background: SH.ink, color: SH.bg, padding: '14px 16px', fontFamily: shMono, fontSize: 12, lineHeight: 1.7 }}>
          $ llm-tracker session start \<br/>
          &nbsp;&nbsp;--task={task} \<br/>
          &nbsp;&nbsp;--profile={profile} \<br/>
          &nbsp;&nbsp;--agent={agent} \<br/>
          &nbsp;&nbsp;--model={model} \<br/>
          &nbsp;&nbsp;--sandbox={sandbox}
        </div>
        <div style={{
          marginTop: 12,
          padding: '10px 12px', background: SH.okSoft, border: `1px solid ${SH.ok}33`,
          fontFamily: shMono, fontSize: 11, color: SH.ok, lineHeight: 1.5,
        }}>
          ✓ no worktree conflicts · ✓ deps satisfied · ✓ allowed_paths cover scope
        </div>
      </div>
    </div>
  );
}

function Sum({ k, v, tone }) {
  const c = tone === 'block' ? SH.block : tone === 'warn' ? SH.warn : SH.ink;
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <span style={{ color: SH.ink3, minWidth: 70 }}>{k}</span>
      <span style={{ color: c }}>{v}</span>
    </div>
  );
}

// ───────────────────────────────────────────────────────────
// Modal shell
// ───────────────────────────────────────────────────────────
function ModalShell({ title, sub, children, onClose, wide }) {
  return (
    <div style={{
      position: 'absolute', inset: 0,
      background: 'rgba(20,18,14,0.36)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 40, zIndex: 50,
    }}>
      <div style={{
        background: SH.paper,
        border: `1px solid ${SH.ink}22`,
        boxShadow: '0 24px 60px -12px rgba(20,18,14,0.3)',
        width: wide ? 1080 : 780,
        maxHeight: '90%',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '14px 22px',
          borderBottom: `1px solid ${SH.rule}`,
          background: SH.paperAlt,
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: SH.ink }}>{title}</div>
            {sub && <div style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3, marginTop: 2, letterSpacing: 0.3 }}>{sub}</div>}
          </div>
          <Bracket dense dim onClick={onClose}>× CLOSE</Bracket>
        </div>
        <div style={{
          padding: '20px 22px',
          overflow: 'auto', flex: 1,
        }}>
          {children}
        </div>
      </div>
    </div>
  );
}

function ModalFooter({ left, right }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center',
      borderTop: `1px solid ${SH.rule}`,
      marginTop: 20, paddingTop: 14,
      gap: 10,
    }}>
      <div style={{ flex: 1 }}>{left}</div>
      <div style={{ display: 'flex', gap: 6 }}>{right}</div>
    </div>
  );
}

window.ModelSwitchModal = ModelSwitchModal;
window.RestartModal = RestartModal;
window.StartSessionWizard = StartSessionWizard;
window.ModalShell = ModalShell;
window.ModalFooter = ModalFooter;

// ───────────────────────────────────────────────────────────
// AttachTaskModal — drag a task onto a session → opens this
// Quick preflight + confirm. No magic auto-binding.
// ───────────────────────────────────────────────────────────
function AttachTaskModal({ taskId, sessionId, onClose, onConfirm }) {
  // Synthetic preflight result — tailored to the drop pair.
  const checks = [
    { label: 'task not already bound',         status: 'ok',   detail: 'no existing binding for this pair' },
    { label: 'session accepts new task',       status: 'ok',   detail: 'session in ACTIVE state · adapter supports direct injection' },
    { label: 'task scope inside allowed_paths',status: 'ok',   detail: 'all task files within session sandbox' },
    { label: 'profile compatible',             status: 'ok',   detail: 'reviewer can handle planning sub-task' },
    { label: 'no worktree conflict',           status: 'warn', detail: 'session ses-V2QJ writes to overlapping path' },
    { label: 'context room available',         status: 'ok',   detail: '64k / 200k · room for +12k brief' },
  ];
  const hasFail = checks.some(c => c.status === 'fail');
  const hasWarn = checks.some(c => c.status === 'warn');

  return (
    <ModalShell onClose={onClose} title="Attach task to session" sub={`drop · pre-bind preflight · no implicit mutation`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Header pair */}
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 28px 1fr',
          gap: 12, alignItems: 'center',
        }}>
          <div style={{
            padding: '12px 14px',
            border: `1px solid ${SH.rule}`,
            background: SH.bgSink,
          }}>
            <LaneHead style={{ marginBottom: 4 }}>task</LaneHead>
            <div style={{ fontFamily: shMono, fontSize: 11, color: SH.ink, fontWeight: 600 }}>{taskId}</div>
            <div style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3, marginTop: 4 }}>
              currently · STATUS:NOT_STARTED · GOVERNANCE lane
            </div>
          </div>
          <span style={{ textAlign: 'center', color: SH.accent, fontFamily: shMono, fontSize: 18 }}>→</span>
          <div style={{
            padding: '12px 14px',
            border: `1px solid ${SH.rule}`,
            borderLeft: `3px solid ${SH.accent}`,
            background: SH.accentSoft,
          }}>
            <LaneHead style={{ marginBottom: 4, color: SH.accent }}>session</LaneHead>
            <div style={{ fontFamily: shMono, fontSize: 11, color: SH.ink, fontWeight: 600 }}>{sessionId}</div>
            <div style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3, marginTop: 4 }}>
              reviewer · codex app-server · ACTIVE 2m
            </div>
          </div>
        </div>

        {/* Preflight chips */}
        <div>
          <LaneHead style={{ marginBottom: 8 }}>preflight</LaneHead>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6 }}>
            {checks.map((ch, i) => {
              const c = ch.status === 'fail' ? SH.block : ch.status === 'warn' ? SH.warn : SH.ok;
              const glyph = ch.status === 'fail' ? '✕' : ch.status === 'warn' ? '!' : '✓';
              return (
                <div key={i} style={{
                  padding: '8px 10px',
                  background: SH.paper, border: `1px solid ${c}33`, borderLeft: `2px solid ${c}`,
                  display: 'flex', alignItems: 'center', gap: 8,
                  fontSize: 12, color: SH.ink2,
                }}>
                  <span style={{ color: c, fontWeight: 700, width: 10 }}>{glyph}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: SH.ink, fontSize: 12, fontWeight: 500 }}>{ch.label}</div>
                    <div style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3, lineHeight: 1.4 }}>{ch.detail}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {hasWarn && (
          <div style={{
            padding: '10px 12px',
            background: SH.warnSoft, border: `1px solid ${SH.warn}33`,
            fontFamily: shMono, fontSize: 11, color: SH.warn, lineHeight: 1.55,
          }}>
            ! attaching this task means two sessions will share a worktree. Review CONFLICTS panel in the session detail to decide.
          </div>
        )}

        {/* What happens */}
        <div style={{
          padding: '10px 12px',
          background: SH.bgSink, border: `1px solid ${SH.rule}`,
          fontFamily: shMono, fontSize: 11, color: SH.ink2, lineHeight: 1.7,
        }}>
          <div style={{ color: SH.ink3, fontSize: 10, letterSpacing: 0.6, marginBottom: 4 }}>ON CONFIRM</div>
          <div>→ task added to session's bound_tasks</div>
          <div>→ session receives an attach event ({'<task brief>'} stitched as fresh evidence)</div>
          <div>→ session may report status on the task via tracker_session_* tools</div>
          <div>→ binding audit-logged · reversible via UNBIND</div>
        </div>
      </div>

      <ModalFooter
        left={<span style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3 }}>
          equivalent: $ llm-tracker session attach-task {sessionId} --task={taskId}
        </span>}
        right={<>
          <Bracket dim onClick={onClose}>CANCEL</Bracket>
          <Bracket active tone={hasFail ? 'warn' : null} onClick={onConfirm}>
            {hasFail ? 'OVERRIDE & ATTACH' : 'CONFIRM ATTACH →'}
          </Bracket>
        </>}
      />
    </ModalShell>
  );
}

// Toast — appears on successful attach
function AttachToast({ message, onDismiss }) {
  React.useEffect(() => {
    const t = setTimeout(onDismiss, 3000);
    return () => clearTimeout(t);
  }, [onDismiss]);
  return (
    <div style={{
      position: 'absolute', bottom: 24, left: '50%', transform: 'translateX(-50%)',
      padding: '10px 18px',
      background: SH.ink, color: SH.bg,
      fontFamily: shMono, fontSize: 12, letterSpacing: 0.4,
      display: 'flex', alignItems: 'center', gap: 10,
      animation: 'cardGrow 220ms cubic-bezier(0.32, 0.72, 0, 1)',
      zIndex: 100,
    }}>
      <span style={{ color: SH.ok, fontWeight: 700 }}>✓</span>
      {message}
      <Bracket dense dim onClick={onDismiss} style={{ color: 'rgba(255,255,255,0.6)', borderColor: 'rgba(255,255,255,0.18)' }}>OK</Bracket>
    </div>
  );
}

window.AttachTaskModal = AttachTaskModal;
window.AttachToast = AttachToast;
