// Session Hub — modals
//  · ModelSwitchModal — clicking the model chip mid-session
//  · RestartModal     — restart matrix (preserve/clear ctx × same/new model × sandbox)

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
