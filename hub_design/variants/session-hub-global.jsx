// Session Hub — global view with size-aware cards.
// Three card sizes per session, manually toggled:
//   · small  — single dense row
//   · medium — full card with progress + tools (DEFAULT)
//   · large  — inline detail (tabs, chat, tasks) — replaces separate detail view
//
// Triage is integrated: filter pills at top let you narrow by attention state.

function SessionHubGlobal({ onBrief, onRestart, onModel, onRollover, defaultSizes }) {
  // Each card has a manual size override. Default is 'medium', or what the
  // hub passed in (e.g. open one as 'large' when navigating from elsewhere).
  const [sizes, setSizes] = React.useState(() => {
    const init = {};
    [SESSION_A, SESSION_B, SESSION_C, SESSION_D, SESSION_E, SESSION_F, SESSION_G].forEach(s => {
      init[s.id] = (defaultSizes && defaultSizes[s.id]) || 'medium';
    });
    return init;
  });
  const setSize = (id, sz) => setSizes(s => ({ ...s, [id]: sz }));

  const [filter, setFilter] = React.useState('all'); // all | approval | quiet | ctx | blocked | active | done
  const filterFn = (s) => {
    if (filter === 'all')      return true;
    if (filter === 'approval') return s.state === 'approval';
    if (filter === 'quiet')    return s.state === 'quiet';
    if (filter === 'ctx')      return s.state === 'contexth';
    if (filter === 'blocked')  return s.state === 'blocked';
    if (filter === 'active')   return s.state === 'active';
    if (filter === 'done')     return s.state === 'done';
    return true;
  };

  const projects = [
    { name: 'Project Phalanx',  slug: 'project-phalanx', tasksOpen: 53, accent: true,
      sessions: [SESSION_A, SESSION_B, SESSION_C].filter(filterFn) },
    { name: 'llm-tracker',      slug: 'llm-tracker',     tasksOpen: 12, accent: false,
      sessions: [SESSION_D, SESSION_E].filter(filterFn) },
    { name: 'Hoplon',           slug: 'hoplon',          tasksOpen: 8,  accent: false,
      sessions: [SESSION_F, SESSION_G].filter(filterFn) },
  ];

  return (
    <div style={{
      fontFamily: shSans,
      background: SH.bg,
      color: SH.ink,
      width: 1440,
      display: 'flex', flexDirection: 'column',
      border: `1px solid ${SH.rule}`,
    }}>
      <HubTopBar onBrief={() => onBrief && onBrief(null)} />
      <HubKpiStrip />
      <HubFilterBar filter={filter} setFilter={setFilter} sizes={sizes} setSizes={setSizes} />

      <div style={{ background: SH.bg, padding: '0 0 18px' }}>
        {projects.map(p => p.sessions.length === 0 ? null : (
          <HubGroup key={p.slug}
            name={p.name} slug={p.slug} tasksOpen={p.tasksOpen} accent={p.accent}
            sessions={p.sessions}
            sizes={sizes} setSize={setSize}
            onBrief={onBrief} onRestart={onRestart} onModel={onModel} onRollover={onRollover} />
        ))}
      </div>

      <HubFooter />
    </div>
  );
}

// ── Top bar ─────────────────────────────────────────────────
function HubTopBar({ onBrief }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center',
      padding: '12px 22px',
      borderBottom: `1px solid ${SH.rule}`,
      background: SH.paper, gap: 22,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3, letterSpacing: 1.2 }}>LLM·TRACKER</span>
        <span style={{ fontSize: 18, fontWeight: 600, letterSpacing: -0.3 }}>Session Hub</span>
        <span style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3, padding: '2px 6px', border: `1px solid ${SH.rule}` }}>WORKSPACE</span>
      </div>

      <div style={{ flex: 1 }} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Bracket onClick={onBrief}>+ NEW SESSION</Bracket>
        <Bracket>+ ATTACH</Bracket>
        <Bracket>BROADCAST</Bracket>
      </div>
      <div style={{ width: 1, height: 20, background: SH.rule }} />
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 10px', border: `1px solid ${SH.rule}`,
        background: SH.bg, minWidth: 260,
      }}>
        <span style={{ fontFamily: shMono, fontSize: 11, color: SH.ink3 }}>⌘K</span>
        <span style={{ fontSize: 12, color: SH.ink2 }}>filter · search · run command</span>
      </div>
    </div>
  );
}

// ── KPI strip ───────────────────────────────────────────────
function HubKpiStrip() {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1.2fr 1fr 1fr 1.4fr',
      borderBottom: `1px solid ${SH.rule}`,
      background: SH.paper,
    }}>
      <KpiCell label="Active sessions" main="7" sub="3 projects · 4 worktrees" />
      <KpiCell
        label="Attention"
        main={<span style={{ color: SH.block }}>4</span>}
        sub={<span><span style={{ color: SH.block }}>1 approval</span> · <span style={{ color: SH.warn }}>1 quiet</span> · <span style={{ color: SH.info }}>1 ctx high</span> · <span style={{ color: SH.block }}>1 blocked</span></span>}
        borderL
      />
      <KpiCell
        label="Skill gates"
        main="14/18"
        sub="4 pending verify · 0 failed"
        borderL
      />
      <RecommendedNext borderL />
    </div>
  );
}

function KpiCell({ label, main, sub, borderL }) {
  return (
    <div style={{
      padding: '14px 20px',
      borderLeft: borderL ? `1px solid ${SH.rule}` : 'none',
    }}>
      <LaneHead style={{ marginBottom: 8 }}>{label}</LaneHead>
      <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: -0.5, lineHeight: 1, color: SH.ink, marginBottom: 6 }}>{main}</div>
      <div style={{ fontFamily: shMono, fontSize: 11, color: SH.ink3 }}>{sub}</div>
    </div>
  );
}

function RecommendedNext({ borderL }) {
  return (
    <div style={{
      padding: '14px 20px',
      borderLeft: borderL ? `1px solid ${SH.rule}` : 'none',
      background: SH.accentSoft,
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <LaneHead style={{ color: SH.accent }}>* Recommended next session</LaneHead>
      <div style={{ fontSize: 14, fontWeight: 600, color: SH.ink, lineHeight: 1.25 }}>
        Verify Semantix advisory intake UI
      </div>
      <div style={{ fontFamily: shMono, fontSize: 11, color: SH.ink2 }}>
        project-phalanx · rm-semantix-advisory-intake-ui-proof · profile:reviewer
      </div>
      <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
        <Bracket active>BRIEF →</Bracket>
        <Bracket>READ</Bracket>
        <Bracket>WHY</Bracket>
      </div>
    </div>
  );
}

// ── Filter bar (integrates triage) ──────────────────────────
function HubFilterBar({ filter, setFilter, sizes, setSizes }) {
  const setAll = (sz) => {
    const next = {};
    Object.keys(sizes).forEach(k => next[k] = sz);
    setSizes(next);
  };
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '10px 22px',
      borderBottom: `1px solid ${SH.rule}`,
      background: SH.paper,
    }}>
      <LaneHead style={{ marginRight: 8 }}>filter</LaneHead>
      <Bracket active={filter==='all'}      onClick={() => setFilter('all')}>ALL · 7</Bracket>
      <Bracket active={filter==='approval'} onClick={() => setFilter('approval')} tone="block">APPROVAL · 1</Bracket>
      <Bracket active={filter==='quiet'}    onClick={() => setFilter('quiet')}    tone="warn">QUIET · 1</Bracket>
      <Bracket active={filter==='ctx'}      onClick={() => setFilter('ctx')}      tone="info">CTX HIGH · 1</Bracket>
      <Bracket active={filter==='blocked'}  onClick={() => setFilter('blocked')}  tone="block">BLOCKED · 1</Bracket>
      <Bracket active={filter==='active'}   onClick={() => setFilter('active')}   tone="ok">ACTIVE · 3</Bracket>
      <Bracket active={filter==='done'}     onClick={() => setFilter('done')}     dim>DONE · 1</Bracket>
      <div style={{ flex: 1 }} />
      <LaneHead>group by</LaneHead>
      <Bracket dense active>PROJECT</Bracket>
      <Bracket dense dim>URGENCY</Bracket>
      <Bracket dense dim>AGENT</Bracket>
      <div style={{ width: 1, height: 18, background: SH.rule, margin: '0 4px' }} />
      <LaneHead>resize all</LaneHead>
      <Bracket dense onClick={() => setAll('small')}>SM</Bracket>
      <Bracket dense onClick={() => setAll('medium')}>MED</Bracket>
      <Bracket dense onClick={() => setAll('large')}>LG</Bracket>
    </div>
  );
}

// ── Group ───────────────────────────────────────────────────
function HubGroup({ name, slug, tasksOpen, sessions, accent, sizes, setSize, onBrief, onRestart, onModel, onRollover }) {
  return (
    <div style={{
      borderBottom: `1px solid ${SH.rule}`,
      background: SH.paper,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 14,
        padding: '12px 22px',
        background: SH.paperAlt,
        borderBottom: `1px solid ${SH.ruleSoft}`,
      }}>
        <span style={{ fontFamily: shMono, color: SH.ink3, fontSize: 11 }}>▾</span>
        <span style={{ fontSize: 14, fontWeight: 600, color: accent ? SH.accent : SH.ink }}>{name}</span>
        <span style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3 }}>~/dev/{slug}</span>
        <span style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3 }}>· {sessions.length} session{sessions.length !== 1 ? 's' : ''}</span>
        <span style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3 }}>· {tasksOpen} tasks open</span>
        <div style={{ flex: 1 }} />
        <Bracket dense onClick={() => onBrief && onBrief(null)}>+ SESSION</Bracket>
        <Bracket dense dim>OPEN BOARD</Bracket>
      </div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: 0,
        background: SH.paper,
      }}>
        {sessions.map(s => {
          const sz = sizes[s.id] || 'medium';
          const span = sz === 'large' ? 3 : 1;
          return (
            <div key={s.id} className="sh-card-wrap" style={{
              gridColumn: `span ${span}`,
              borderRight: span === 3 ? 'none' : `1px solid ${SH.rule}`,
              borderBottom: `1px solid ${SH.ruleSoft}`,
            }}>
              <div key={sz} className="sh-card-content">
                {sz === 'small'  && <SessionCardSmall  s={s} onResize={(x) => setSize(s.id, x)} onModel={onModel} />}
                {sz === 'medium' && <SessionCardMedium s={s} onResize={(x) => setSize(s.id, x)} onRollover={onRollover} onRestart={onRestart} onModel={onModel} />}
                {sz === 'large'  && <SessionCardLarge  s={s} onResize={(x) => setSize(s.id, x)} onRollover={onRollover} onRestart={onRestart} onModel={onModel} />}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Size toggle (top-right of every card) ──────────────────
function SizeToggle({ size, onResize }) {
  return (
    <div style={{ display: 'flex', gap: 2 }}>
      <Bracket dense active={size === 'small'}  onClick={() => onResize('small')}>SM</Bracket>
      <Bracket dense active={size === 'medium'} onClick={() => onResize('medium')}>MED</Bracket>
      <Bracket dense active={size === 'large'}  onClick={() => onResize('large')}>LG</Bracket>
    </div>
  );
}

// ── State badge — used at every size ───────────────────────
function StateBadge({ s }) {
  const stateMap = {
    active:    { tone: 'ok',    label: 'ACTIVE' },
    quiet:     { tone: 'warn',  label: 'QUIET' },
    approval:  { tone: 'block', label: 'APPROVAL' },
    blocked:   { tone: 'block', label: 'BLOCKED' },
    contexth:  { tone: 'info',  label: 'CTX HIGH' },
    done:      { tone: 'ok',    label: 'DONE' },
  };
  const st = stateMap[s.state];
  const bg = st.tone === 'ok'    ? SH.okSoft
           : st.tone === 'warn'  ? SH.warnSoft
           : st.tone === 'block' ? SH.blockSoft
           : st.tone === 'info'  ? SH.infoSoft
           :                       SH.bgSink;
  const c = st.tone === 'ok'    ? SH.ok
          : st.tone === 'warn'  ? SH.warn
          : st.tone === 'block' ? SH.block
          : st.tone === 'info'  ? SH.info
          :                       SH.ink3;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      fontFamily: shMono, fontSize: 9, letterSpacing: 0.5,
      color: c, background: bg, padding: '2px 6px',
    }}>
      <Dot tone={st.tone} pulse={s.state === 'active' || s.state === 'approval'} size={5} />
      {st.label}{s.stateMeta ? ' · ' + s.stateMeta : ''}
    </span>
  );
}

function stateColor(s) {
  return s.state === 'active'   ? SH.ok
       : s.state === 'quiet'    ? SH.warn
       : s.state === 'approval' ? SH.block
       : s.state === 'blocked'  ? SH.block
       : s.state === 'contexth' ? SH.info
       : s.state === 'done'     ? SH.ok
       :                          SH.ink3;
}

// ───────────────────────────────────────────────────────────
// SMALL — pared to status + task + warning + primary action
// ───────────────────────────────────────────────────────────
function SessionCardSmall({ s, onResize, onModel }) {
  const primaryTool = s.tools.find(t => t.active) || s.tools[0];
  return (
    <div style={{
      padding: '8px 14px',
      borderLeft: `3px solid ${stateColor(s)}`,
      display: 'flex', alignItems: 'center', gap: 10,
      minHeight: 56, background: SH.paper,
    }}>
      <Dot tone={s.state === 'active' ? 'ok' : s.state === 'approval' || s.state === 'blocked' ? 'block' : s.state === 'quiet' ? 'warn' : s.state === 'contexth' ? 'info' : s.state === 'done' ? 'ok' : 'ink3'} pulse={s.state === 'active' || s.state === 'approval'} />
      <span style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3, minWidth: 60 }}>{s.id}</span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: SH.ink, lineHeight: 1.2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {s.profile} <span style={{ color: SH.ink3, fontWeight: 400, fontFamily: shMono, fontSize: 10 }}>· {s.task.split('·')[0].trim()}</span>
        </div>
      </div>
      <StateBadge s={s} />
      {s.warnings && s.warnings[0] && (
        <span style={{ fontFamily: shMono, fontSize: 10, color: s.warnings[0].tone === 'block' ? SH.block : SH.warn }} title={s.warnings[0].text}>!</span>
      )}
      <Bracket dense active={primaryTool && primaryTool.active} tone={primaryTool && primaryTool.tone} onClick={() => onResize('large')}>{primaryTool ? primaryTool.label : 'OPEN'}</Bracket>
      <SizeToggle size="small" onResize={onResize} />
    </div>
  );
}

// ───────────────────────────────────────────────────────────
// MEDIUM — the workhorse card (default)
// ───────────────────────────────────────────────────────────
function SessionCardMedium({ s, onResize, onRollover, onRestart, onModel }) {
  const cBar = stateColor(s);
  return (
    <div style={{
      padding: '14px 16px',
      display: 'flex', flexDirection: 'column', gap: 10,
      borderLeft: `3px solid ${cBar}`,
      minHeight: 360,
      background: SH.paper,
    }}>
      {/* row 1: id, cap, state, size toggle */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3, letterSpacing: 0.4 }}>{s.id}</span>
        <CapTier tier={s.tier} />
        <StateBadge s={s} />
        <SourceLabel src={s.stateSrc} />
        <span style={{ flex: 1 }} />
        <SizeToggle size="medium" onResize={onResize} />
      </div>

      {/* row 2: profile + task */}
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, color: SH.ink, lineHeight: 1.25, marginBottom: 3 }}>{s.profile}</div>
        <div style={{ fontFamily: shMono, fontSize: 11, color: SH.ink2, lineHeight: 1.5 }}>{s.task}</div>
      </div>

      {/* row 3: live status */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
        padding: '6px 0',
        borderTop: `1px dashed ${SH.rule}`,
        borderBottom: `1px dashed ${SH.rule}`,
      }}>
        <span onClick={onModel} style={{ cursor: onModel ? 'pointer' : 'default' }}><ModelChip model={s.model} /></span>
        <SandboxChip mode={s.sandbox} />
        <ContextMeter used={s.ctxUsed} total={s.ctxMax} width={64} compact />
        <StdioChip mode={s.stdio || (s.tier === 'dumb' ? 'live' : s.tier === 'codex' ? 'off' : 'captured')} />
        <span style={{ flex: 1 }} />
        <ActivitySpark data={s.spark} tone={s.state === 'approval' || s.state === 'blocked' ? 'block' : s.state === 'quiet' ? 'warn' : 'ok'} width={72} height={16} />
      </div>

      {/* row 4: now doing */}
      <NowDoing kind={s.now.kind} text={s.now.text} dur={s.now.dur} idle={s.now.idle} />

      {/* row 5: skill plan */}
      <div>
        <LaneHead style={{ marginBottom: 6 }}>skill plan</LaneHead>
        <SkillTrack steps={s.skills} />
      </div>

      {/* row 6: warnings */}
      {s.warnings && s.warnings.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {s.warnings.map((w, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'flex-start', gap: 6,
              fontFamily: shMono, fontSize: 10, color: w.tone === 'block' ? SH.block : SH.warn,
              lineHeight: 1.4,
            }}>
              <span style={{ marginTop: 1 }}>!</span><span>{w.text}</span>
            </div>
          ))}
        </div>
      )}

      {/* tool shelf */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 'auto' }}>
        {s.tools.map((t, i) => {
          const onClick = t.label === 'OPEN'     ? () => onResize('large')
                        : t.label === 'ROLLOVER' ? onRollover
                        : t.label === 'RESTART'  ? onRestart
                        :                          undefined;
          return (
            <Bracket key={i} dense active={t.active} tone={t.tone} dim={t.dim} onClick={onClick}>{t.label}</Bracket>
          );
        })}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────
// LARGE — full inline detail (replaces separate detail view)
// Renders the SessionDetail content directly inside the hub.
// ───────────────────────────────────────────────────────────
function SessionCardLarge({ s, onResize, onRollover, onRestart, onModel }) {
  const cBar = stateColor(s);
  return (
    <div style={{
      borderLeft: `4px solid ${cBar}`,
      background: SH.paper,
    }}>
      {/* Header strip — same row as the size toggle, denser than detail's */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '12px 22px',
        background: SH.paperAlt,
        borderBottom: `1px solid ${SH.rule}`,
      }}>
        <span style={{ fontFamily: shMono, fontSize: 11, color: SH.ink, fontWeight: 600 }}>{s.id}</span>
        <CapTier tier={s.tier} />
        <StateBadge s={s} />
        <SourceLabel src={s.stateSrc} />
        <span style={{ fontSize: 13, fontWeight: 600, color: SH.ink }}>· {s.profile}</span>
        <span style={{ flex: 1 }} />
        <SizeToggle size="large" onResize={onResize} />
      </div>

      {/* Live bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 22px',
        borderBottom: `1px solid ${SH.rule}`,
        background: SH.paper,
      }}>
        <span onClick={onModel} style={{ cursor: onModel ? 'pointer' : 'default' }}><ModelChip model={s.model} /></span>
        <SandboxChip mode={s.sandbox} />
        <ContextMeter used={s.ctxUsed} total={s.ctxMax} width={120} />
        <StdioChip mode={s.stdio || (s.tier === 'dumb' ? 'live' : s.tier === 'codex' ? 'off' : 'captured')} />
        <span style={{ width: 1, height: 18, background: SH.rule, margin: '0 4px' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <NowDoing kind={s.now.kind} text={s.now.text} dur={s.now.dur} idle={s.now.idle} />
        </div>
        <Bracket dense tone="warn" onClick={onRestart}>RESTART…</Bracket>
        <Bracket dense onClick={onRollover}>ROLLOVER</Bracket>
        <Bracket dense dim>FORK</Bracket>
      </div>

      {/* Body: tasks rail + tabbed content */}
      <SessionLargeBody s={s} />
    </div>
  );
}

function SessionLargeBody({ s }) {
  // Chat is the default — it's where the session lives.
  const [tab, setTab] = React.useState('chat');
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', minHeight: 720 }}>
      {/* Left: tasks bound to this session + skill plan */}
      <div style={{
        borderRight: `1px solid ${SH.rule}`,
        background: SH.paperAlt,
        padding: '14px 18px',
        display: 'flex', flexDirection: 'column', gap: 16,
        overflow: 'auto',
      }}>
        <div>
          <LaneHead style={{ marginBottom: 8 }}>bound tasks · live tracker status</LaneHead>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {(s.boundTasks || DEFAULT_BOUND_TASKS).map(t => <BoundTaskRow key={t.id} t={t} />)}
          </div>
          <div style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3, marginTop: 8 }}>
            <span style={{ textDecoration: 'underline', cursor: 'pointer' }}>+ add task</span>
          </div>
        </div>

        <div>
          <LaneHead style={{ marginBottom: 8 }}>skill plan</LaneHead>
          <SkillTrack steps={s.skills} />
        </div>

        <div>
          <LaneHead style={{ marginBottom: 8 }}>completion gates</LaneHead>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontFamily: shMono, fontSize: 11 }}>
            <GateLine ok label="verify pack run" />
            <GateLine ok label="DoD checked" />
            <GateLine pending label="closeout sweep" />
            <GateLine ok label="allowed-paths clean" />
            <GateLine pending label="handoff written" />
          </div>
        </div>
      </div>

      {/* Right: tabbed body */}
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div style={{
          display: 'flex', borderBottom: `1px solid ${SH.rule}`,
          background: SH.paper,
        }}>
          {[
            { k: 'chat',     l: 'Chat',     badge: s.state === 'approval' ? '!' : '14', primary: true },
            { k: 'stdio',    l: 'Stdio · raw' },
            { k: 'tasks',    l: 'Tasks',    badge: (s.boundTasks || DEFAULT_BOUND_TASKS).length },
            { k: 'context',  l: 'Context' },
            { k: 'events',   l: 'Events',   badge: '47' },
            { k: 'evidence', l: 'Evidence' },
          ].map(t => (
            <div key={t.k} onClick={() => setTab(t.k)} style={{
              padding: '12px 16px', fontSize: 13,
              fontWeight: tab === t.k ? 600 : 400,
              color: tab === t.k ? SH.accent : SH.ink2,
              borderBottom: tab === t.k ? `2px solid ${SH.accent}` : '2px solid transparent',
              cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
              {t.l}
              {t.badge && <span style={{
                fontFamily: shMono, fontSize: 9,
                color: t.badge === '!' ? SH.block : (tab === t.k ? SH.accent : SH.ink3),
                background: t.badge === '!' ? SH.blockSoft : (tab === t.k ? SH.accentSoft : SH.bgSink),
                padding: '1px 5px',
              }}>{t.badge}</span>}
            </div>
          ))}
          <span style={{ flex: 1 }} />
          <div style={{ padding: '10px 14px', display: 'flex', gap: 4 }}>
            <Bracket dense dim>SPLIT</Bracket>
            <Bracket dense dim>FOLLOW</Bracket>
          </div>
        </div>

        <div style={{ flex: 1, background: SH.bg, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {tab === 'chat'     && <TabChat s={s} />}
          {tab === 'stdio'    && <TabStdio s={s} />}
          {tab === 'tasks'    && <TabTasks s={s} />}
          {tab === 'context'  && <TabContext s={s} />}
          {tab === 'events'   && <TabEvents s={s} />}
          {tab === 'evidence' && <TabEvidence s={s} />}
        </div>
      </div>
    </div>
  );
}

function GateLine({ ok, pending, label }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      color: ok ? SH.ok : pending ? SH.warn : SH.ink2,
    }}>
      <span style={{ width: 12, textAlign: 'center' }}>{ok ? '✓' : pending ? '○' : '·'}</span>
      <span>{label}</span>
    </div>
  );
}

// Bound task row — replaces the workspace map
function BoundTaskRow({ t }) {
  const statusMap = {
    not_started: { tone: 'ink3', label: 'NOT_STARTED' },
    in_progress: { tone: 'warn', label: 'IN_PROGRESS' },
    blocked:     { tone: 'block', label: 'BLOCKED' },
    done:        { tone: 'ok',   label: 'DONE' },
  };
  const st = statusMap[t.status];
  const c = st.tone === 'ok' ? SH.ok : st.tone === 'warn' ? SH.warn : st.tone === 'block' ? SH.block : SH.ink3;
  return (
    <div style={{
      background: SH.paper,
      border: `1px solid ${SH.rule}`,
      borderLeft: `3px solid ${c}`,
      padding: '8px 10px',
      display: 'flex', flexDirection: 'column', gap: 5,
    }}>
      <div style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3 }}>{t.id}</div>
      <div style={{ fontSize: 12, fontWeight: 600, lineHeight: 1.3, color: SH.ink }}>{t.title}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: shMono, fontSize: 10 }}>
        <span style={{ color: c, fontWeight: 600 }}>{st.label}</span>
        {t.justUpdated && (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 3,
            color: SH.accent, fontSize: 9, letterSpacing: 0.4,
          }}>
            <Dot tone="accent" size={4} pulse />
            session updated · {t.justUpdated}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ color: SH.ink3 }}>{t.dod} DoD</span>
      </div>
    </div>
  );
}

const DEFAULT_BOUND_TASKS = [
  { id: 'rm-plane-global-completion-gap-register', title: 'Track global plane-separation completion gaps', status: 'in_progress', dod: 5, justUpdated: '14s ago' },
  { id: 'rm-bounded-plane-separation-followon',    title: 'Closed-bounded-plane follow-on slices',         status: 'done',        dod: 3 },
  { id: 'rm-reviewer-trust-seam',                  title: 'Reviewer trust seam wiring',                    status: 'not_started', dod: 4 },
];

// ── Tabs ────────────────────────────────────────────────────
function TabTasks({ s }) {
  const ts = s.boundTasks || DEFAULT_BOUND_TASKS;
  return (
    <div style={{ padding: '14px 22px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <LaneHead>tasks this session works on</LaneHead>
        <span style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3 }}>
          the session may update tracker status as it progresses · all writes audit-logged
        </span>
        <span style={{ flex: 1 }} />
        <Bracket dense>+ ADD TASK</Bracket>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        {ts.map(t => <BoundTaskCardWide key={t.id} t={t} />)}
      </div>
    </div>
  );
}

function BoundTaskCardWide({ t }) {
  const statusMap = {
    not_started: { tone: 'ink3', label: 'NOT_STARTED' },
    in_progress: { tone: 'warn', label: 'IN_PROGRESS' },
    blocked:     { tone: 'block', label: 'BLOCKED' },
    done:        { tone: 'ok',   label: 'DONE' },
  };
  const st = statusMap[t.status];
  const c = st.tone === 'ok' ? SH.ok : st.tone === 'warn' ? SH.warn : st.tone === 'block' ? SH.block : SH.ink3;
  return (
    <div style={{
      background: SH.paper,
      border: `1px solid ${SH.rule}`,
      borderLeft: `3px solid ${c}`,
      padding: '12px 14px',
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3 }}>{t.id}</div>
      <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.3 }}>{t.title}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: shMono, fontSize: 10, color: c, fontWeight: 600 }}>{st.label}</span>
        {t.justUpdated && <MonoPill tone="accent" filled>* session updated {t.justUpdated}</MonoPill>}
        <MonoPill>{t.dod} DoD</MonoPill>
      </div>
      <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
        <Bracket dense>READ</Bracket>
        <Bracket dense>WHY</Bracket>
        <Bracket dense dim>UNBIND</Bracket>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────
// CHAT — the session itself. Rich turns + composer.
// ───────────────────────────────────────────────────────────
function TabChat({ s }) {
  const isApproval = s.state === 'approval';
  const turns = CHAT_TURNS[s.id] || CHAT_TURNS.default;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {/* Scroll boundary */}
      <div style={{
        flex: 1, overflow: 'auto',
        padding: '14px 20px 18px',
        display: 'flex', flexDirection: 'column', gap: 10,
        background: SH.bg,
      }}>
        <DayDivider label="session started · 14:02 · rev:947" />
        {turns.map((t, i) => <ChatBubble key={i} t={t} />)}
        {isApproval && <ApprovalBlock />}
        <PendingTurn />
      </div>

      {/* Composer */}
      <ChatComposer />
    </div>
  );
}

function DayDivider({ label }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      fontFamily: shMono, fontSize: 10, color: SH.ink3, letterSpacing: 0.6,
      padding: '4px 0',
    }}>
      <span style={{ flex: 1, height: 1, background: SH.ruleSoft }} />
      <span>{label}</span>
      <span style={{ flex: 1, height: 1, background: SH.ruleSoft }} />
    </div>
  );
}

function ChatBubble({ t }) {
  if (t.kind === 'user')      return <UserTurn  t={t} />;
  if (t.kind === 'thought')   return <ThoughtTurn t={t} />;
  if (t.kind === 'agent')     return <AgentTurn t={t} />;
  if (t.kind === 'tool')      return <ToolTurn  t={t} />;
  if (t.kind === 'fileEdit')  return <FileEditTurn t={t} />;
  if (t.kind === 'status')    return <StatusTurn t={t} />;
  if (t.kind === 'skill')     return <SkillTurn  t={t} />;
  if (t.kind === 'fileRead')  return <FileReadTurn t={t} />;
  return null;
}

function TurnRow({ label, color, time, children, dense }) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <div style={{
        flexShrink: 0, width: 60,
        fontFamily: shMono, fontSize: 9, letterSpacing: 1,
        color: color || SH.ink3, paddingTop: dense ? 1 : 4,
        textAlign: 'right',
      }}>
        {label}
        {time && <div style={{ color: SH.ink4, fontSize: 9, marginTop: 2, fontWeight: 400 }}>{time}</div>}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}

function UserTurn({ t }) {
  return (
    <TurnRow label="YOU" color={SH.ink2} time={t.time}>
      <div style={{
        background: SH.paperAlt, border: `1px solid ${SH.rule}`,
        padding: '10px 14px',
        fontSize: 13, lineHeight: 1.55, color: SH.ink,
      }}>
        {t.body}
      </div>
    </TurnRow>
  );
}

function AgentTurn({ t }) {
  return (
    <TurnRow label="AGENT" color={SH.accent} time={t.time}>
      <div style={{
        background: SH.paper, border: `1px solid ${SH.rule}`,
        padding: '10px 14px',
        fontSize: 13, lineHeight: 1.6, color: SH.ink,
      }}>
        {t.body}
      </div>
    </TurnRow>
  );
}

function ThoughtTurn({ t }) {
  return (
    <TurnRow label="THINK" color={SH.ink4} time={t.time} dense>
      <div style={{
        fontSize: 12, lineHeight: 1.55, color: SH.ink3,
        fontStyle: 'italic',
        padding: '4px 14px',
        borderLeft: `2px solid ${SH.ruleSoft}`,
      }}>
        {t.body}
      </div>
    </TurnRow>
  );
}

function ToolTurn({ t }) {
  const ok = t.ok !== false;
  return (
    <TurnRow label="TOOL" color={SH.info} time={t.time}>
      <div style={{
        background: SH.infoSoft, border: `1px solid ${SH.info}33`,
        padding: '8px 12px',
        fontFamily: shMono, fontSize: 12, color: SH.ink,
        display: 'flex', flexDirection: 'column', gap: 6,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ color: SH.info, fontWeight: 600 }}>{t.name}</span>
          {t.args && <span style={{ color: SH.ink3 }}>
            ({Object.entries(t.args).map(([k, v], i) => (
              <span key={k}>{i > 0 ? ', ' : ''}{k}: <span style={{ color: SH.ink2 }}>{String(v)}</span></span>
            ))})
          </span>}
          <span style={{ flex: 1 }} />
          <span style={{ color: ok ? SH.ok : SH.block, fontSize: 10 }}>
            {ok ? '✓' : '×'} {t.dur || '—'}
          </span>
        </div>
        {t.result && (
          <div style={{
            background: SH.paper, padding: '6px 10px',
            border: `1px solid ${SH.info}22`,
            fontSize: 11, color: SH.ink2, lineHeight: 1.55,
          }}>
            {t.result}
          </div>
        )}
      </div>
    </TurnRow>
  );
}

function FileEditTurn({ t }) {
  return (
    <TurnRow label="EDIT" color={SH.accent} time={t.time}>
      <div style={{
        background: SH.paper, border: `1px solid ${SH.accent}33`,
        borderLeft: `3px solid ${SH.accent}`,
        padding: '8px 12px',
        fontFamily: shMono, fontSize: 12, color: SH.ink,
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <span style={{ flex: 1, color: SH.ink }}>{t.path}</span>
        <span style={{ color: SH.ok }}>+{t.add}</span>
        <span style={{ color: SH.block }}>−{t.rem}</span>
        <Bracket dense>VIEW DIFF</Bracket>
      </div>
    </TurnRow>
  );
}

function FileReadTurn({ t }) {
  return (
    <TurnRow label="READ" color={SH.ink3} time={t.time} dense>
      <div style={{
        background: 'transparent',
        padding: '4px 0',
        fontFamily: shMono, fontSize: 11, color: SH.ink3,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span style={{ color: SH.ink4 }}>›</span>
        <span style={{ color: SH.ink2 }}>{t.path}</span>
        <span style={{ color: SH.ink4 }}>({t.lines} lines)</span>
      </div>
    </TurnRow>
  );
}

function StatusTurn({ t }) {
  return (
    <TurnRow label="STATUS" color={SH.ok} time={t.time}>
      <div style={{
        background: SH.okSoft, border: `1px dashed ${SH.ok}55`,
        padding: '6px 12px',
        fontFamily: shMono, fontSize: 11, color: SH.ink, lineHeight: 1.5,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span style={{ color: SH.ok }}>→</span>
        <span>task <span style={{ color: SH.ink, fontWeight: 600 }}>{t.task}</span></span>
        <span style={{ color: SH.ink3 }}>·</span>
        <span style={{ color: SH.ok, fontWeight: 600 }}>{t.from}</span>
        <span style={{ color: SH.ink3 }}>→</span>
        <span style={{ color: SH.ok, fontWeight: 600 }}>{t.to}</span>
        <span style={{ flex: 1 }} />
        <span style={{ color: SH.ink3, fontSize: 10 }}>written by session · audit logged</span>
      </div>
    </TurnRow>
  );
}

function SkillTurn({ t }) {
  return (
    <TurnRow label="SKILL" color={SH.accent} time={t.time} dense>
      <div style={{
        fontFamily: shMono, fontSize: 11, color: SH.ink2,
        padding: '4px 0', display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: t.state === 'done' ? SH.ok : SH.accent,
          boxShadow: t.state === 'done' ? 'none' : `0 0 0 2px ${SH.accent}22`,
          flexShrink: 0,
        }} />
        <span style={{ color: SH.accent }}>{t.name}</span>
        <span style={{ color: SH.ink3 }}>{t.state === 'done' ? '· completed' : '· started'}</span>
      </div>
    </TurnRow>
  );
}

function PendingTurn() {
  return (
    <TurnRow label="AGENT" color={SH.accent} time="now">
      <div style={{
        background: SH.paper, border: `1px dashed ${SH.accent}55`,
        padding: '10px 14px',
        fontSize: 13, color: SH.ink3, fontStyle: 'italic',
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span style={{
          display: 'inline-flex', gap: 3,
        }}>
          <Pulse delay={0} />
          <Pulse delay={0.15} />
          <Pulse delay={0.3} />
        </span>
        responding…
      </div>
    </TurnRow>
  );
}

function Pulse({ delay }) {
  return (
    <span style={{
      width: 4, height: 4, borderRadius: '50%',
      background: SH.accent,
      animation: `pulse 1.4s ${delay}s ease-in-out infinite`,
    }} />
  );
}

// ── Composer ────────────────────────────────────────────────
function ChatComposer() {
  const [mode, setMode] = React.useState('chat'); // chat | slash | interrupt
  const [text, setText] = React.useState('');
  const placeholders = {
    chat:      'Message the session…  ·  ⌘↵ to send  ·  / for commands  ·  @ to reference a file',
    slash:     '/verify   /handoff   /restart   /skill <name>   /status <task> <status>   /attach-ctx <file>',
    interrupt: 'Interrupt: this stops the current turn and queues your message at the top of the stack.',
  };
  return (
    <div style={{
      borderTop: `1px solid ${SH.rule}`,
      background: SH.paper,
    }}>
      {/* Mode pills */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '8px 16px 0',
      }}>
        <Bracket dense active={mode === 'chat'}      onClick={() => setMode('chat')}>CHAT</Bracket>
        <Bracket dense active={mode === 'slash'}     onClick={() => setMode('slash')}>/ COMMAND</Bracket>
        <Bracket dense active={mode === 'interrupt'} onClick={() => setMode('interrupt')} tone="warn">INTERRUPT</Bracket>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3 }}>
          context will grow to ~67k / 200k · est cost $0.04
        </span>
      </div>

      <div style={{
        padding: '8px 16px 12px',
      }}>
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 10,
          padding: '10px 12px',
          border: `1px solid ${mode === 'interrupt' ? SH.warn : SH.rule}`,
          borderLeft: `3px solid ${mode === 'interrupt' ? SH.warn : SH.accent}`,
          background: SH.bg,
        }}>
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder={placeholders[mode]}
            rows={3}
            style={{
              flex: 1, resize: 'vertical', minHeight: 56,
              border: 'none', background: 'transparent',
              fontFamily: mode === 'slash' ? shMono : shSans,
              fontSize: mode === 'slash' ? 12 : 13,
              color: SH.ink, outline: 'none', lineHeight: 1.55,
            }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'stretch' }}>
            <Bracket dense dim>ATTACH</Bracket>
            <Bracket dense dim>@ FILE</Bracket>
            <Bracket dense active>SEND ⌘↵</Bracket>
          </div>
        </div>
        <div style={{
          marginTop: 6,
          display: 'flex', alignItems: 'center', gap: 8,
          fontFamily: shMono, fontSize: 10, color: SH.ink3,
        }}>
          <span>shortcut:</span>
          <span style={{ color: SH.ink2 }}>⌘k</span><span>command palette</span>
          <span style={{ color: SH.ink2 }}>⌘↑</span><span>previous message</span>
          <span style={{ color: SH.ink2 }}>esc</span><span>focus chat</span>
          <span style={{ flex: 1 }} />
          <span>session reads + writes are audit-logged</span>
        </div>
      </div>
    </div>
  );
}

// ── Chat content per session ──────────────────────────────
const CHAT_TURNS = {
  // ses-K2WX — reviewer at approval, real-looking conversation
  'ses-K2WX': [
    { kind: 'user', time: '14:02', body: <span>Verify <code style={{ fontFamily: shMono, background: SH.bgSink, padding: '0 4px' }}>rm-plane-global-completion-gap-register</code> using the changed-since pack. Block on any reviewer-closed slices that re-opened. If clean, mark <code style={{ fontFamily: shMono, background: SH.bgSink, padding: '0 4px' }}>IN_PROGRESS</code>.</span> },
    { kind: 'thought', time: '14:02', body: 'I need to load the changed-since pack between the start rev and HEAD, then walk the closed slices to confirm none have re-opened. Then check DoD against the diff.' },
    { kind: 'skill', time: '14:02', name: 'review.changed_since', state: 'started' },
    { kind: 'tool', time: '14:02', name: 'tracker_session_skill_run',
      args: { skill: 'review.changed_since', task: 'rm-plane-global-completion-gap-register' },
      result: 'pack ready · 14 commits · 47 files · rev:947 → rev:982 · 9 hunks summarized',
      dur: '247ms' },
    { kind: 'fileRead', time: '14:03', path: 'docs/registers/global-completion-2026-05-19.md', lines: 312 },
    { kind: 'fileRead', time: '14:03', path: 'docs/sessions/handoff_2026-05-19.md', lines: 147 },
    { kind: 'agent', time: '14:04', body: (
      <div>
        <div>Loaded changed-since pack. Three reviewer-closed slices in range:</div>
        <ul style={{ marginTop: 6, marginBottom: 6, paddingLeft: 22 }}>
          <li><code style={{ fontFamily: shMono, color: SH.ink2 }}>bounded-plane-separation-followon</code> · closed @ rev:962 · no reopens</li>
          <li><code style={{ fontFamily: shMono, color: SH.ink2 }}>row-5-runtime-config-seam</code> · closed @ rev:971 · no reopens</li>
          <li><code style={{ fontFamily: shMono, color: SH.ink2 }}>decision-gated-followon</code> · closed @ rev:962 · no reopens</li>
        </ul>
        <div>Bounded plane-separation is intact at HEAD. Safe to mark this task <code style={{ fontFamily: shMono, color: SH.ink2 }}>IN_PROGRESS</code>.</div>
      </div>
    ) },
    { kind: 'tool', time: '14:04', name: 'tracker_task_set_status',
      args: { task: 'rm-plane-global-completion-gap-register', status: 'in_progress' },
      result: '✓ status written · audit entry #4821',
      dur: '93ms' },
    { kind: 'status', time: '14:04', task: 'rm-plane-global-completion-gap-register', from: 'NOT_STARTED', to: 'IN_PROGRESS' },
    { kind: 'agent', time: '14:23', body: (
      <div>
        Walked the diff. Tests pass on the new register paths. To finalize before VERIFY,
        I need to prune the expired snapshot directory so closeout doesn't trip on stale
        artifacts.
      </div>
    ) },
    { kind: 'tool', time: '14:23', name: 'execute_command',
      args: { cmd: 'rm -rf .runtime/snapshots/expired/*' },
      result: '! approval required · path outside repos.allowed_paths',
      ok: false, dur: '—' },
  ],

  default: [
    { kind: 'user',  time: '14:02', body: 'Pick up this task.' },
    { kind: 'agent', time: '14:02', body: 'Loaded brief and dependencies. Starting scope skill.' },
    { kind: 'skill', time: '14:02', name: 'lt.scope', state: 'done' },
    { kind: 'agent', time: '14:03', body: 'Scope complete. Proceeding to plan.' },
  ],
};

function ApprovalBlock() {
  return (
    <TurnRow label="APPROVAL" color={SH.block} time="now">
      <div style={{ background: SH.blockSoft, border: `1px solid ${SH.block}44`, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontFamily: shMono, fontSize: 11, color: SH.block, letterSpacing: 0.5, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>OUT·OF·SANDBOX · codex.app-server.exec_approval_request</span>
          <SourceLabel src="structured" />
        </div>
        <div style={{ fontFamily: shMono, fontSize: 13, background: SH.paper, padding: '8px 10px', border: `1px solid ${SH.block}33` }}>
          $ rm -rf .runtime/snapshots/expired/*
        </div>
        <div style={{ fontFamily: shMono, fontSize: 10, color: SH.ink2, lineHeight: 1.7 }}>
          <div>cwd: <span style={{ color: SH.ink }}>~/dev/Project-Phalanx</span></div>
          <div>touches: <span style={{ color: SH.ink }}>.runtime/snapshots/expired/</span> (4 files · 1.2MB)</div>
          <div>sandbox: <span style={{ color: SH.info }}>workspace-write</span> · violation: <span style={{ color: SH.block }}>outside repos.allowed_paths</span></div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <Bracket active tone="block">APPROVE ONCE</Bracket>
          <Bracket tone="block">DENY</Bracket>
          <Bracket dim>APPROVE FOR SESSION</Bracket>
          <Bracket tone="warn">ESCALATE SANDBOX → auto-edit</Bracket>
          <Bracket dim>EDIT COMMAND</Bracket>
          <span style={{ flex: 1 }} />
          <span style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3 }}>auto-deny in 4m 22s</span>
        </div>
      </div>
    </TurnRow>
  );
}

function TabStdio({ s }) {
  const lines = [
    { c: SH.ink3, t: '[14:23:11] codex.app-server  task started' },
    { c: SH.ink,  t: '[14:23:12] mcp_call tracker_session_register' },
    { c: SH.info, t: '[14:23:12] mcp_call tracker_skill_run skill=lt.scope' },
    { c: SH.ink,  t: '[14:23:14] read CHANGELOG.md (87 lines)' },
    { c: SH.ink,  t: '[14:23:15] read docs/plans/PLAN_handle_truth.md (1.2k lines)' },
    { c: SH.info, t: '[14:23:48] mcp_call tracker_task_set_status task=rm-plane-global-completion-gap-register status=in_progress' },
    { c: SH.accent, t: '[14:24:01] edit adapters/required-handle.ts (+132/-12)' },
    { c: SH.warn, t: '[14:24:08] tool_call execute_command  $ rm -rf .runtime/snapshots/expired/*' },
    { c: SH.block, t: '[14:24:08] !! sandbox violation: outside repos.allowed_paths' },
    { c: SH.block, t: '[14:24:08] >> approval requested · auto-deny in 5m' },
  ];
  return (
    <div style={{
      padding: '12px 22px',
      background: SH.ink, color: SH.bg,
      fontFamily: shMono, fontSize: 11, lineHeight: 1.7,
      minHeight: 380, height: '100%',
    }}>
      {lines.map((l, i) => (
        <div key={i} style={{ color: l.c }}>{l.t}</div>
      ))}
      <div style={{ display: 'inline-block', width: 8, height: 14, background: SH.bg, marginTop: 4 }} />
    </div>
  );
}

function TabContext({ s }) {
  return (
    <div style={{ padding: '16px 22px' }}>
      <LaneHead style={{ marginBottom: 12 }}>context window · {s.ctxUsed}k / {s.ctxMax}k</LaneHead>
      <div style={{ display: 'flex', height: 28, background: SH.bgSink, border: `1px solid ${SH.rule}`, position: 'relative' }}>
        <div style={{ width: '14%', background: SH.ok, opacity: 0.7 }} title="system prompt" />
        <div style={{ width: '8%',  background: SH.info, opacity: 0.7 }} title="task brief" />
        <div style={{ width: '22%', background: SH.warn, opacity: 0.7 }} title="changed-since pack" />
        <div style={{ width: '38%', background: SH.accent, opacity: 0.6 }} title="tool calls + outputs" />
        <div style={{ width: '7%',  background: SH.ink, opacity: 0.6 }} title="chat" />
        <div style={{ width: '11%', background: SH.ruleSoft }} title="free" />
        <div style={{ position: 'absolute', left: '85%', top: -4, bottom: -4, width: 1, background: SH.ink3 }} />
      </div>
      <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, fontFamily: shMono, fontSize: 11 }}>
        <CtxLegend c={SH.ok} l="system prompt" v="9k" />
        <CtxLegend c={SH.info} l="task brief" v="5k" />
        <CtxLegend c={SH.warn} l="changed-since pack" v="14k" />
        <CtxLegend c={SH.accent} l="tool calls + outputs" v="24k" />
        <CtxLegend c={SH.ink} l="chat" v="4k" />
        <CtxLegend c={SH.ruleSoft} l="free" v="7k" border />
      </div>
    </div>
  );
}

function CtxLegend({ c, l, v, border }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ width: 12, height: 12, background: c, border: border ? `1px solid ${SH.rule}` : 'none', flexShrink: 0 }} />
      <span style={{ color: SH.ink2 }}>{l}</span>
      <span style={{ color: SH.ink3 }}>{v}</span>
    </div>
  );
}

function TabEvents({ s }) {
  const evs = [
    { t: '14:24:08', kind: 'approval',  text: 'exec_approval_request · rm in .runtime/' },
    { t: '14:24:01', kind: 'edit',      text: 'adapters/required-handle.ts +132/-12' },
    { t: '14:23:48', kind: 'status',    text: 'task rm-plane-global-completion-gap-register · IN_PROGRESS' },
    { t: '14:23:12', kind: 'skill',     text: 'lt.scope started' },
    { t: '14:23:11', kind: 'start',     text: 'session registered · rev:947' },
  ];
  return (
    <div style={{ padding: '14px 22px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      {evs.map((e, i) => (
        <div key={i} style={{
          display: 'flex', gap: 12, padding: '6px 10px',
          background: SH.paper, border: `1px solid ${SH.ruleSoft}`,
          fontFamily: shMono, fontSize: 11,
        }}>
          <span style={{ color: SH.ink3, minWidth: 64 }}>{e.t}</span>
          <MonoPill tone={e.kind === 'approval' ? 'block' : e.kind === 'edit' ? 'accent' : e.kind === 'status' ? 'info' : 'ink2'} filled>{e.kind.toUpperCase()}</MonoPill>
          <span style={{ color: SH.ink }}>{e.text}</span>
        </div>
      ))}
    </div>
  );
}

function TabEvidence({ s }) {
  return (
    <div style={{ padding: '16px 22px', fontFamily: shMono, fontSize: 11, color: SH.ink2, lineHeight: 1.7 }}>
      <LaneHead style={{ marginBottom: 8 }}>artifacts pulled into context</LaneHead>
      <div>tracker · brief @ rev:982 (1 doc) · deps satisfied (2) · DoD (3 items)</div>
      <div>git · diff (3 files staged, 2 unstaged) · log (14 commits since start_rev)</div>
      <div>watcher · 51 files seen · 4 outside allowed_paths (advisory)</div>
      <div>conflicts · scanned 19s ago · none</div>
    </div>
  );
}

// ── Footer ──────────────────────────────────────────────────
function HubFooter() {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14,
      padding: '8px 22px',
      borderTop: `1px solid ${SH.rule}`,
      background: SH.paper,
      fontFamily: shMono, fontSize: 10, color: SH.ink3, letterSpacing: 0.4,
    }}>
      <span>RUNTIME · .runtime/sessions.jsonl@9742</span>
      <span>·</span>
      <span>watchers OK</span>
      <span>·</span>
      <span>conflict scan 19s ago</span>
      <div style={{ flex: 1 }} />
      <span>session-hub v0.3 · drag cards to reorder · drop a task onto a card to attach</span>
      <span style={{ color: SH.ok }}>● LIVE</span>
    </div>
  );
}

// ── Synthetic sessions ─────────────────────────────────────
const SESSION_A = {
  id: 'ses-7Q4F', tier: 'codex', profile: 'code-implementer', model: 'sonnet-4.5',
  sandbox: 'workspace', ctxUsed: 62, ctxMax: 200,
  task: 'rm-semantix-alignment-intake · pre-Staff alignment packet',
  state: 'active', stateMeta: '2m', stateSrc: 'structured',
  spark: [3,4,2,5,4,6,3,4,5,7,6,4,5,6,8,5,4,6,7,9,7,6,8,6],
  skills: [
    { k: 'scope', label: 'SCOPE', s: 'done' },
    { k: 'plan',  label: 'PLAN',  s: 'done' },
    { k: 'exec',  label: 'EXEC',  s: 'active' },
    { k: 'verify',label: 'VERIFY',s: 'pending' },
    { k: 'close', label: 'CLOSE', s: 'pending' },
  ],
  now: { kind: 'edit', text: 'docs/plans/PLAN_semantix_alignment_preflight.md · +47/−12', dur: '4s' },
  warnings: [],
  tools: [
    { label: 'OPEN', active: true },
    { label: 'CHAT' }, { label: 'STDIO' }, { label: 'CTX' },
    { label: 'RESTART', tone: 'warn' }, { label: 'STOP', tone: 'block' },
  ],
};
const SESSION_B = {
  id: 'ses-K2WX', tier: 'hybrid', profile: 'reviewer', model: 'opus-4.5',
  sandbox: 'workspace', ctxUsed: 84, ctxMax: 200,
  task: 'rm-plane-global-completion-gap-register · verify completion claim',
  state: 'approval', stateMeta: 'shell out-of-sandbox', stateSrc: 'structured',
  spark: [2,3,4,2,3,1,2,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  skills: [
    { k: 'scope', label: 'SCOPE', s: 'done' },
    { k: 'cs',    label: 'CHANGED·SINCE', s: 'done' },
    { k: 'verify',label: 'VERIFY',s: 'active' },
    { k: 'close', label: 'CLOSE', s: 'pending' },
  ],
  now: { kind: 'approval', text: '$ rm -rf .runtime/snapshots/expired/* · outside workspace-write', dur: '38s' },
  warnings: [{ tone: 'block', text: 'out-of-sandbox: bash rm in .runtime/ · not in repos.allowed_paths' }],
  tools: [
    { label: 'APPROVE', tone: 'block', active: true },
    { label: 'DENY', tone: 'block' },
    { label: 'ESCALATE SANDBOX', tone: 'warn' },
    { label: 'CHAT' }, { label: 'RESTART', dim: true },
  ],
};
const SESSION_C = {
  id: 'ses-9HCM', tier: 'mcp', profile: 'planner', model: 'sonnet-4.5',
  sandbox: 'readonly', ctxUsed: 178, ctxMax: 200,
  task: 'rm-runtime-required-handle-truth · plan handle enforcement',
  state: 'contexth', stateMeta: '89%', stateSrc: 'reported',
  spark: [4,5,6,5,7,6,8,6,5,7,8,9,8,7,9,8,9,9,8,9,9,8,9,9],
  skills: [
    { k: 'scope', label: 'SCOPE', s: 'done' },
    { k: 'plan',  label: 'PLAN',  s: 'active' },
    { k: 'handoff', label: 'HANDOFF', s: 'pending' },
  ],
  now: { kind: 'think', text: 'reasoning about handle invariants · ctx pressure rising', dur: '11s' },
  warnings: [{ tone: 'warn', text: 'context 89% — successor pack ready (deterministic, evidence-based)' }],
  tools: [
    { label: 'ROLLOVER', active: true, tone: 'warn' },
    { label: 'OPEN' }, { label: 'CHAT' }, { label: 'HANDOFF' }, { label: 'RESTART', dim: true },
  ],
};
const SESSION_D = {
  id: 'ses-1B0R', tier: 'mcp', profile: 'prd-writer', model: 'opus-4.5',
  sandbox: 'readonly', ctxUsed: 42, ctxMax: 200,
  task: 'prd-session-hub-v0.2 · finalize milestone plan',
  state: 'done', stateMeta: 'closeout pending', stateSrc: 'structured',
  spark: [3,4,5,4,6,5,4,3,4,5,4,3,2,3,4,3,2,3,2,1,0,0,0,0],
  skills: [
    { k: 'scope', label: 'SCOPE', s: 'done' },
    { k: 'plan',  label: 'PLAN',  s: 'done' },
    { k: 'exec',  label: 'EXEC',  s: 'done' },
    { k: 'verify',label: 'VERIFY',s: 'done' },
    { k: 'close', label: 'CLOSE', s: 'active' },
  ],
  now: { kind: 'mcp', text: 'tracker_skill_run · skill=lt.closeout_sweep · started', dur: '2s' },
  warnings: [],
  tools: [
    { label: 'CLOSEOUT', active: true, tone: 'ok' },
    { label: 'OPEN' }, { label: 'HANDOFF' }, { label: 'ARCHIVE', dim: true },
  ],
};
const SESSION_E = {
  id: 'ses-3FT8', tier: 'dumb', profile: 'code-runner', model: 'codex-cli',
  sandbox: 'autoedit', ctxUsed: 96, ctxMax: 200,
  task: 'wire-app-server-adapter · prove session injection works',
  state: 'quiet', stateMeta: '12m', stateSrc: 'derived',
  spark: [5,6,4,5,3,4,2,3,1,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  skills: [
    { k: 'scope', label: 'SCOPE', s: 'done' },
    { k: 'exec',  label: 'EXEC',  s: 'active' },
    { k: 'verify',label: 'VERIFY',s: 'pending' },
  ],
  now: { kind: 'shell', text: 'npm test -- adapters/codex-app-server.spec.ts', dur: '12m', idle: true },
  warnings: [{ tone: 'warn', text: 'dumb terminal — quiet may mean approval, error, or success. check terminal' }],
  tools: [
    { label: 'PING', active: true, tone: 'warn' },
    { label: 'STDIO' }, { label: 'COPY CTX' },
    { label: 'RESTART', tone: 'warn' }, { label: 'STOP', dim: true },
  ],
};
const SESSION_F = {
  id: 'ses-V2QJ', tier: 'hybrid', profile: 'code-implementer', model: 'sonnet-4.5',
  sandbox: 'workspace', ctxUsed: 38, ctxMax: 200,
  task: 't-024 · contracts adapter — emit invariant proof',
  state: 'active', stateMeta: '14s', stateSrc: 'structured',
  spark: [6,7,8,7,9,8,7,9,8,7,8,9,8,9,9,8,9,8,9,9,8,9,9,9],
  skills: [
    { k: 'scope', label: 'SCOPE', s: 'done' },
    { k: 'plan',  label: 'PLAN',  s: 'done' },
    { k: 'exec',  label: 'EXEC',  s: 'active' },
    { k: 'verify',label: 'VERIFY',s: 'pending' },
  ],
  now: { kind: 'edit', text: 'engine/operations/createSnapshot.ts · +132 · 4 files staged', dur: '14s' },
  warnings: [{ tone: 'warn', text: 'shares worktree with ses-PR2D — overlapping writes in engine/operations/' }],
  tools: [
    { label: 'OPEN', active: true }, { label: 'CHAT' }, { label: 'STDIO' },
    { label: 'CONFLICTS', tone: 'warn' },
    { label: 'RESTART', dim: true }, { label: 'STOP', dim: true },
  ],
};
const SESSION_G = {
  id: 'ses-PR2D', tier: 'mcp', profile: 'reviewer', model: 'opus-4.5',
  sandbox: 'readonly', ctxUsed: 24, ctxMax: 200,
  task: 't-021 · multi-region snapshot replication — verify HA',
  state: 'blocked', stateMeta: 'waiting on t-024', stateSrc: 'reported',
  spark: [0,0,1,2,1,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  skills: [
    { k: 'scope', label: 'SCOPE', s: 'done' },
    { k: 'cs',    label: 'CHANGED·SINCE', s: 'done' },
    { k: 'verify',label: 'VERIFY',s: 'skip' },
  ],
  now: { kind: 'idle', text: 'waiting for t-024 snapshot artifact (in flight on ses-V2QJ)', idle: true, dur: '8m' },
  warnings: [{ tone: 'block', text: 'blocked on dep t-024 — currently in progress on ses-V2QJ (same worktree)' }],
  tools: [
    { label: 'OPEN' },
    { label: 'ASK ses-V2QJ', active: true, tone: 'info' },
    { label: 'CHAT' }, { label: 'RESTART', dim: true }, { label: 'STOP', dim: true },
  ],
};

window.SessionHubGlobal = SessionHubGlobal;
