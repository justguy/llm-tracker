// Variant A — Calmed Terminal
// Keeps bracket-button DNA and monospace data, but:
//  - collapses 14 header actions into 3 clusters + overflow
//  - introduces real typographic hierarchy (size/weight, not just color)
//  - tightens the amber/green to a single warm-ink accent + green status
//  - task cards scan in 3 clear tiers: id+title, meta line, tags
//  - inline expand drawer replaces the modal overlay

const A_COLORS = {
  bg: '#faf7f1',
  paper: '#ffffff',
  ink: '#23201b',
  ink2: '#5a5348',
  ink3: '#8a8374',
  rule: '#e8e2d4',
  ruleSoft: '#f0ebde',
  accent: '#b84a1a',          // warm ink (single accent)
  accentSoft: '#f6e3d6',
  ok: '#3a7d3a',
  okSoft: '#e2efdc',
  warn: '#a8741a',
  block: '#a83838',
};

const aMono = `"JetBrains Mono", ui-monospace, Menlo, monospace`;

const aBracket = (label, { active, soft, tone } = {}) => {
  const color = tone === 'ok' ? A_COLORS.ok
              : tone === 'block' ? A_COLORS.block
              : tone === 'warn' ? A_COLORS.warn
              : active ? A_COLORS.accent : A_COLORS.ink2;
  return (
    <span style={{
      fontFamily: aMono,
      fontSize: 11,
      letterSpacing: 0.4,
      color,
      whiteSpace: 'nowrap',
      padding: '4px 6px',
      border: active ? `1px solid ${A_COLORS.accent}` : `1px solid ${soft ? 'transparent' : A_COLORS.rule}`,
      background: active ? A_COLORS.accentSoft : 'transparent',
    }}>[{label}]</span>
  );
};

function VariantA() {
  const cell = { borderLeft: `1px solid ${A_COLORS.rule}`, padding: '14px 16px', minHeight: 220, position: 'relative' };
  const laneHead = { fontFamily: aMono, fontSize: 10, letterSpacing: 1, color: A_COLORS.ink3, textTransform: 'uppercase' };

  return (
    <div style={{
      fontFamily: `Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif`,
      background: A_COLORS.bg,
      color: A_COLORS.ink,
      width: 1440, height: 900,
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>

      {/* ── Top bar ─────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center',
        padding: '14px 24px',
        borderBottom: `1px solid ${A_COLORS.rule}`,
        background: A_COLORS.paper,
        gap: 24,
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <div style={{ fontFamily: aMono, fontSize: 10, color: A_COLORS.ink3, letterSpacing: 1 }}>LLM·TRACKER</div>
          <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: -0.3 }}>hoplon</div>
          <span style={{
            fontFamily: aMono, fontSize: 10, color: A_COLORS.ink3,
            padding: '2px 6px', border: `1px solid ${A_COLORS.rule}`,
          }}>REV 151</span>
        </div>

        <div style={{ flex: 1 }} />

        {/* Grouped clusters, not a wall of brackets */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, color: A_COLORS.ink3, marginRight: 4 }}>agent</span>
          {aBracket('NEXT', { active: true })}
          {aBracket('BLOCKERS')}
          {aBracket('CHANGED')}
          {aBracket('DECISIONS')}
        </div>
        <div style={{ width: 1, height: 20, background: A_COLORS.rule }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, color: A_COLORS.ink3, marginRight: 4 }}>history</span>
          {aBracket('UNDO')}
          {aBracket('REDO')}
        </div>
        <div style={{ width: 1, height: 20, background: A_COLORS.rule }} />
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '6px 10px', border: `1px solid ${A_COLORS.rule}`,
          background: A_COLORS.bg, minWidth: 260,
        }}>
          <span style={{ fontFamily: aMono, fontSize: 11, color: A_COLORS.ink3 }}>⌘K</span>
          <span style={{ fontSize: 12, color: A_COLORS.ink2 }}>filter · search · run command</span>
        </div>
        {aBracket('⋯')}
      </div>

      {/* ── Project summary strip ───────────────────────────── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '280px 1fr 180px',
        borderBottom: `1px solid ${A_COLORS.rule}`,
        background: A_COLORS.paper,
      }}>
        <div style={{ padding: '18px 24px', borderRight: `1px solid ${A_COLORS.rule}` }}>
          <div style={{ ...laneHead, marginBottom: 6 }}>PROJECT</div>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>HOPLON</div>
          <div style={{ fontFamily: aMono, fontSize: 11, color: A_COLORS.ink3, lineHeight: 1.6 }}>
            9 swimlanes · 56 tasks<br/>
            ~/llm-tracker · updated 6:55:42
          </div>
        </div>

        <div style={{ padding: '18px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ ...laneHead }}>STATUS · 49 of 56 complete</div>
            <div style={{ fontFamily: aMono, fontSize: 11, color: A_COLORS.ink3 }}>94%</div>
          </div>
          {/* Segmented progress */}
          <div style={{ display: 'flex', height: 8, gap: 2 }}>
            <div style={{ flex: 49, background: A_COLORS.ok }} />
            <div style={{ flex: 0.01, background: A_COLORS.warn }} />
            <div style={{ flex: 1, background: A_COLORS.ruleSoft }} />
            <div style={{ flex: 6, background: A_COLORS.block, opacity: 0.35 }} />
          </div>
          <div style={{ display: 'flex', gap: 14, fontSize: 11, color: A_COLORS.ink2, fontFamily: aMono }}>
            <StatPill label="complete" value={49} dot={A_COLORS.ok} />
            <StatPill label="in progress" value={0} dot={A_COLORS.warn} />
            <StatPill label="not started" value={1} dot={A_COLORS.ink3} />
            <StatPill label="deferred" value={0} dot={A_COLORS.ink3} />
            <StatPill label="blocked" value={0} dot={A_COLORS.block} />
            <span style={{ marginLeft: 'auto', color: A_COLORS.ink3 }}>· open 56</span>
          </div>
        </div>

        <div style={{ padding: '18px 20px', borderLeft: `1px solid ${A_COLORS.rule}`, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ ...laneHead }}>RECOMMENDED</div>
          <div style={{ fontFamily: aMono, fontSize: 13, fontWeight: 600, color: A_COLORS.accent }}>T‑021</div>
          <div style={{ fontSize: 11, color: A_COLORS.ink2, lineHeight: 1.4 }}>
            HA / multi‑region snapshot replication
          </div>
          <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
            {aBracket('PICK', { active: true })}
            {aBracket('READ')}
          </div>
        </div>
      </div>

      {/* ── Scratchpad ─────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'flex-start', gap: 16,
        padding: '12px 24px',
        background: A_COLORS.paper,
        borderBottom: `1px solid ${A_COLORS.rule}`,
      }}>
        <div style={{ ...laneHead, paddingTop: 2 }}>SCRATCHPAD</div>
        <div style={{ flex: 1, fontSize: 13, lineHeight: 1.5, color: A_COLORS.ink2 }}>
          2026‑04‑18 active: t‑024, t‑034, and t‑035 are complete on the current branch/worktree.
          GRPC follow‑on beyond PG1 plus broader Layer 2, transport, and host rollout remain separate lanes.
        </div>
        <div style={{ fontFamily: aMono, fontSize: 10, color: A_COLORS.ink3 }}>edited 2h ago</div>
      </div>

      {/* ── Board ──────────────────────────────────────────── */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>

        {/* Column headers */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '240px 1fr 1fr 1fr 1fr',
          background: A_COLORS.paper,
          borderBottom: `1px solid ${A_COLORS.rule}`,
        }}>
          <div style={{ padding: '12px 20px', ...laneHead }}>SWIMLANE</div>
          {['P0 · Now', 'P1 · Next', 'P2 · Soon', 'P3 · Later'].map((h, i) => (
            <div key={i} style={{
              padding: '12px 16px',
              borderLeft: `1px solid ${A_COLORS.rule}`,
              ...laneHead,
              color: i === 0 ? A_COLORS.accent : A_COLORS.ink3,
              fontWeight: i === 0 ? 600 : 400,
            }}>{h.toUpperCase()}</div>
          ))}
        </div>

        {/* Expanded lane — History Phase 1 */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '240px 1fr 1fr 1fr 1fr',
          borderBottom: `1px solid ${A_COLORS.rule}`,
          background: A_COLORS.paper,
        }}>
          <LaneLabel title="History — Phase 1" tasks={1} active={0} open />
          <div style={cell}>
            <TaskCardA
              id="T‑012"
              title="Phase 1 — bounded local subsystem"
              summary="18 slices across 8 waves: contracts, 7 mandatory + 1 optional adapters, 4 engine operations (createSnapshot, auditDiff, revertUncontracted, packContext), health, reconcile, gc."
              status="complete"
              assignee="claude‑opus‑4‑6"
              tags={['phase1', 'milestone']}
            />
          </div>
          <EmptyCell />
          <EmptyCell />
          <EmptyCell />
        </div>

        {/* Collapsed lanes */}
        {[
          { title: 'History — Phase 1.5', tasks: 1, active: 0, done: 1 },
          { title: 'History — Phase 2', tasks: 5, active: 0, done: 5 },
          { title: 'P0 — Hoplon‑on‑Hoplon', tasks: 7, active: 0, done: 7 },
          { title: 'Host Integration', tasks: 5, active: 0, done: 5, live: true },
        ].map((l, i) => (
          <div key={i} style={{
            display: 'grid',
            gridTemplateColumns: '240px 1fr',
            padding: '14px 20px',
            alignItems: 'center',
            borderBottom: `1px solid ${A_COLORS.rule}`,
            background: A_COLORS.paper,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontFamily: aMono, color: A_COLORS.ink3, fontSize: 11 }}>▸</span>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{l.title}</span>
              {l.live && <span style={{ fontFamily: aMono, fontSize: 9, color: A_COLORS.ok, letterSpacing: 1 }}>● LIVE</span>}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontFamily: aMono, fontSize: 11, color: A_COLORS.ink3 }}>
              <span>{l.tasks} tasks</span>
              <span>· {l.active} active</span>
              <span>· {l.done} done</span>
              <div style={{ flex: 1, marginLeft: 10, height: 4, background: A_COLORS.ruleSoft, position: 'relative' }}>
                <div style={{ width: '100%', height: '100%', background: A_COLORS.ok }} />
              </div>
              <span style={{ color: A_COLORS.ink2, minWidth: 36, textAlign: 'right' }}>100%</span>
            </div>
          </div>
        ))}

      </div>
    </div>
  );
}

function StatPill({ label, value, dot }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: dot, display: 'inline-block' }} />
      {label} {value}
    </span>
  );
}

function LaneLabel({ title, tasks, active, open }) {
  return (
    <div style={{
      padding: '14px 20px',
      borderRight: `1px solid ${A_COLORS.rule}`,
      background: A_COLORS.bg,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ fontFamily: aMono, color: A_COLORS.accent, fontSize: 11 }}>▾</span>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{title}</span>
      </div>
      <div style={{ fontFamily: aMono, fontSize: 10, color: A_COLORS.ink3, letterSpacing: 0.5 }}>
        {tasks} TASKS · {active} ACTIVE
      </div>
      <div style={{ display: 'flex', gap: 4, marginTop: 10 }}>
        {aBracket('↑', { soft: true })}
        {aBracket('↓', { soft: true })}
      </div>
    </div>
  );
}

function EmptyCell() {
  return (
    <div style={{
      borderLeft: `1px solid ${A_COLORS.rule}`,
      minHeight: 220,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: A_COLORS.ink3, fontSize: 11, fontFamily: aMono, letterSpacing: 1,
    }}>— no tasks —</div>
  );
}

function TaskCardA({ id, title, summary, status, assignee, tags }) {
  return (
    <div style={{
      background: A_COLORS.paper,
      border: `1px solid ${A_COLORS.rule}`,
      borderLeft: `3px solid ${A_COLORS.ok}`,
      padding: '12px 14px',
      display: 'flex', flexDirection: 'column', gap: 10,
      cursor: 'pointer',
    }}>
      {/* Tier 1: id + title */}
      <div>
        <div style={{ fontFamily: aMono, fontSize: 10, color: A_COLORS.ink3, letterSpacing: 0.5, marginBottom: 2 }}>
          {id}
        </div>
        <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.3 }}>{title}</div>
      </div>

      {/* Tier 2: summary */}
      <div style={{ fontSize: 12, color: A_COLORS.ink2, lineHeight: 1.5 }}>
        {summary}
      </div>

      {/* Tier 3: meta line */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{
          fontFamily: aMono, fontSize: 10, letterSpacing: 0.5,
          color: A_COLORS.ok, background: A_COLORS.okSoft,
          padding: '3px 6px',
        }}>● {status.toUpperCase()}</span>
        <span style={{
          fontFamily: aMono, fontSize: 10, color: A_COLORS.ink2,
          padding: '3px 6px', border: `1px solid ${A_COLORS.rule}`,
        }}>{assignee}</span>
        {tags.map(t => (
          <span key={t} style={{
            fontFamily: aMono, fontSize: 10, color: A_COLORS.ink3,
          }}>#{t}</span>
        ))}
      </div>

      {/* Actions row — reveals on hover in real app */}
      <div style={{ display: 'flex', gap: 4, borderTop: `1px dashed ${A_COLORS.rule}`, paddingTop: 10 }}>
        {aBracket('READ', { active: true })}
        {aBracket('WHY')}
        {aBracket('EXEC')}
        {aBracket('VERIFY')}
      </div>
    </div>
  );
}

window.VariantA = VariantA;
