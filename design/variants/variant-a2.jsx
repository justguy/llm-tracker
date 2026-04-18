// Variant A2 — Calmed Terminal, refined
// Changes from A:
//  - Scratchpad shrinks to a one-line "note" row (expand to view full)
//  - Project status strip swaps in Variant B's big 94% headline + status grid
//  - Pulls in Variant B's green "Recommended Next" callout as the right panel

const A2_COLORS = {
  bg: '#faf7f1',
  paper: '#ffffff',
  ink: '#23201b',
  ink2: '#5a5348',
  ink3: '#8a8374',
  rule: '#e8e2d4',
  ruleSoft: '#f0ebde',
  pill: '#f4efe2',
  accent: '#b84a1a',
  accentSoft: '#f6e3d6',
  ok: '#2b8a4a',
  okSoft: '#e4f1e6',
  warn: '#a8741a',
  block: '#a83838',
};

const a2Mono = `"JetBrains Mono", ui-monospace, Menlo, monospace`;

const a2Bracket = (label, { active, soft, tone } = {}) => {
  const color = tone === 'ok' ? A2_COLORS.ok
              : tone === 'block' ? A2_COLORS.block
              : tone === 'warn' ? A2_COLORS.warn
              : active ? A2_COLORS.accent : A2_COLORS.ink2;
  return (
    <span style={{
      fontFamily: a2Mono,
      fontSize: 11,
      letterSpacing: 0.4,
      color,
      whiteSpace: 'nowrap',
      padding: '4px 6px',
      border: active ? `1px solid ${A2_COLORS.accent}` : `1px solid ${soft ? 'transparent' : A2_COLORS.rule}`,
      background: active ? A2_COLORS.accentSoft : 'transparent',
    }}>[{label}]</span>
  );
};

function VariantA2() {
  const cell = { borderLeft: `1px solid ${A2_COLORS.rule}`, padding: '14px 16px', minHeight: 220, position: 'relative' };
  const laneHead = { fontFamily: a2Mono, fontSize: 10, letterSpacing: 1, color: A2_COLORS.ink3, textTransform: 'uppercase' };

  return (
    <div style={{
      fontFamily: `Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif`,
      background: A2_COLORS.bg,
      color: A2_COLORS.ink,
      width: 1440, height: 900,
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>

      {/* ── Top bar ── */}
      <div style={{
        display: 'flex', alignItems: 'center',
        padding: '14px 24px',
        borderBottom: `1px solid ${A2_COLORS.rule}`,
        background: A2_COLORS.paper,
        gap: 24,
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <div style={{ fontFamily: a2Mono, fontSize: 10, color: A2_COLORS.ink3, letterSpacing: 1 }}>LLM·TRACKER</div>
          <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: -0.3 }}>hoplon</div>
          <span style={{
            fontFamily: a2Mono, fontSize: 10, color: A2_COLORS.ink3,
            padding: '2px 6px', border: `1px solid ${A2_COLORS.rule}`,
          }}>REV 151</span>
        </div>

        <div style={{ flex: 1 }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, color: A2_COLORS.ink3, marginRight: 4 }}>agent</span>
          {a2Bracket('NEXT', { active: true })}
          {a2Bracket('BLOCKERS')}
          {a2Bracket('CHANGED')}
          {a2Bracket('DECISIONS')}
        </div>
        <div style={{ width: 1, height: 20, background: A2_COLORS.rule }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, color: A2_COLORS.ink3, marginRight: 4 }}>history</span>
          {a2Bracket('UNDO')}
          {a2Bracket('REDO')}
        </div>
        <div style={{ width: 1, height: 20, background: A2_COLORS.rule }} />
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '6px 10px', border: `1px solid ${A2_COLORS.rule}`,
          background: A2_COLORS.bg, minWidth: 260,
        }}>
          <span style={{ fontFamily: a2Mono, fontSize: 11, color: A2_COLORS.ink3 }}>⌘K</span>
          <span style={{ fontSize: 12, color: A2_COLORS.ink2 }}>filter · search · run command</span>
        </div>
        {a2Bracket('⋯')}
      </div>

      {/* ── Hero strip: 94% headline + status grid + green NEXT callout ── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1.1fr 1.2fr 340px',
        gap: 0,
        borderBottom: `1px solid ${A2_COLORS.rule}`,
        background: A2_COLORS.paper,
      }}>
        {/* Left: project + big 94% */}
        <div style={{ padding: '14px 24px 16px', borderRight: `1px solid ${A2_COLORS.rule}` }}>
          <div style={{ ...laneHead, marginBottom: 6 }}>PROJECT</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 2 }}>
            <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: -0.4 }}>Hoplon</div>
            <div style={{ fontFamily: a2Mono, fontSize: 11, color: A2_COLORS.ink3 }}>~/llm-tracker</div>
          </div>
          <div style={{ fontFamily: a2Mono, fontSize: 11, color: A2_COLORS.ink3, marginBottom: 10 }}>
            9 swimlanes · 56 tasks · updated 6:55:42
          </div>

          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
            <div style={{ fontSize: 34, fontWeight: 600, letterSpacing: -1, color: A2_COLORS.ink, lineHeight: 1 }}>
              94<span style={{ fontSize: 18, color: A2_COLORS.ink3 }}>%</span>
            </div>
            <div style={{ fontSize: 13, color: A2_COLORS.ink2 }}>49 of 56 tasks complete</div>
          </div>
          <div style={{ display: 'flex', height: 5, background: A2_COLORS.ruleSoft, overflow: 'hidden' }}>
            <div style={{ width: '87.5%', background: A2_COLORS.ok }} />
            <div style={{ width: '1.8%', background: A2_COLORS.warn }} />
          </div>
        </div>

        {/* Middle: status grid */}
        <div style={{ padding: '14px 24px 16px', borderRight: `1px solid ${A2_COLORS.rule}` }}>
          <div style={{ ...laneHead, marginBottom: 8 }}>STATUS</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {[
              ['Complete', 49, A2_COLORS.ok, true],
              ['In progress', 0, A2_COLORS.warn],
              ['Not started', 1, A2_COLORS.ink3],
              ['Deferred', 0, A2_COLORS.ink3],
              ['Blocked', 0, A2_COLORS.block],
              ['Open', 56, A2_COLORS.ink2, true],
            ].map(([label, val, color, strong]) => (
              <div key={label} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '5px 10px',
                background: strong ? A2_COLORS.pill : 'transparent',
                border: strong ? 'none' : `1px solid ${A2_COLORS.ruleSoft}`,
              }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: A2_COLORS.ink2 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />
                  {label}
                </span>
                <span style={{ fontFamily: a2Mono, fontSize: 13, fontWeight: 600, color: val > 0 ? A2_COLORS.ink : A2_COLORS.ink3 }}>{val}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Right: green NEXT callout (from variant B) */}
        <div style={{ padding: 12 }}>
          <div style={{
            background: A2_COLORS.okSoft,
            border: `1px solid ${A2_COLORS.ok}44`,
            padding: '12px 14px',
            display: 'flex', flexDirection: 'column', gap: 8,
            height: '100%',
            boxSizing: 'border-box',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontFamily: a2Mono, fontSize: 10, color: A2_COLORS.ok, letterSpacing: 1.2, fontWeight: 600 }}>
                ★ RECOMMENDED NEXT
              </div>
              <span style={{ fontFamily: a2Mono, fontSize: 10, color: A2_COLORS.ok }}>T‑021</span>
            </div>
            <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.3, color: A2_COLORS.ink }}>
              HA / multi‑region snapshot replication
            </div>
            <div style={{ fontSize: 12, color: A2_COLORS.ink2, lineHeight: 1.5 }}>
              Highest‑ranked ready task · P3 · dependencies satisfied · requires product/architecture approval.
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 'auto' }}>
              <button style={{
                fontFamily: a2Mono, fontSize: 12, padding: '7px 12px',
                background: A2_COLORS.ok, color: '#fff',
                border: 'none', cursor: 'pointer', letterSpacing: 0.4,
              }}>[PICK]</button>
              <button style={{
                fontFamily: a2Mono, fontSize: 12, padding: '7px 12px',
                background: 'transparent', color: A2_COLORS.ink,
                border: `1px solid ${A2_COLORS.ok}55`, cursor: 'pointer',
              }}>[READ]</button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Scratchpad: slim one-liner ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 14,
        padding: '8px 24px',
        background: A2_COLORS.paper,
        borderBottom: `1px solid ${A2_COLORS.rule}`,
        fontSize: 12,
      }}>
        <span style={{ ...laneHead, flexShrink: 0 }}>NOTE</span>
        <span style={{
          flex: 1, color: A2_COLORS.ink2,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          t‑024, t‑034, t‑035 complete on current worktree. gRPC follow‑on beyond PG1, Layer 2, transport, and host rollout remain separate lanes.
        </span>
        <span style={{ fontFamily: a2Mono, fontSize: 10, color: A2_COLORS.ink3 }}>2h ago</span>
        {a2Bracket('EXPAND', { soft: true })}
        {a2Bracket('EDIT', { soft: true })}
      </div>

      {/* ── Board ── */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>

        <div style={{
          display: 'grid',
          gridTemplateColumns: '240px 1fr 1fr 1fr 1fr',
          background: A2_COLORS.paper,
          borderBottom: `1px solid ${A2_COLORS.rule}`,
        }}>
          <div style={{ padding: '12px 20px', ...laneHead }}>SWIMLANE</div>
          {['P0 · Now', 'P1 · Next', 'P2 · Soon', 'P3 · Later'].map((h, i) => (
            <div key={i} style={{
              padding: '12px 16px',
              borderLeft: `1px solid ${A2_COLORS.rule}`,
              ...laneHead,
              color: i === 0 ? A2_COLORS.accent : A2_COLORS.ink3,
              fontWeight: i === 0 ? 600 : 400,
            }}>{h.toUpperCase()}</div>
          ))}
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: '240px 1fr 1fr 1fr 1fr',
          borderBottom: `1px solid ${A2_COLORS.rule}`,
          background: A2_COLORS.paper,
        }}>
          <LaneLabelA2 title="History — Phase 1" tasks={1} active={0} />
          <div style={cell}>
            <TaskCardA2
              id="T‑012"
              title="Phase 1 — bounded local subsystem"
              summary="18 slices across 8 waves: contracts, 7 mandatory + 1 optional adapters, 4 engine operations (createSnapshot, auditDiff, revertUncontracted, packContext), health, reconcile, gc."
              status="complete"
              assignee="claude‑opus‑4‑6"
              tags={['phase1', 'milestone']}
            />
          </div>
          <EmptyCellA2 />
          <EmptyCellA2 />
          <EmptyCellA2 />
        </div>

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
            borderBottom: `1px solid ${A2_COLORS.rule}`,
            background: A2_COLORS.paper,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontFamily: a2Mono, color: A2_COLORS.ink3, fontSize: 11 }}>▸</span>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{l.title}</span>
              {l.live && <span style={{ fontFamily: a2Mono, fontSize: 9, color: A2_COLORS.ok, letterSpacing: 1 }}>● LIVE</span>}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontFamily: a2Mono, fontSize: 11, color: A2_COLORS.ink3 }}>
              <span>{l.tasks} tasks</span>
              <span>· {l.active} active</span>
              <span>· {l.done} done</span>
              <div style={{ flex: 1, marginLeft: 10, height: 4, background: A2_COLORS.ruleSoft, position: 'relative' }}>
                <div style={{ width: '100%', height: '100%', background: A2_COLORS.ok }} />
              </div>
              <span style={{ color: A2_COLORS.ink2, minWidth: 36, textAlign: 'right' }}>100%</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LaneLabelA2({ title, tasks, active }) {
  return (
    <div style={{
      padding: '14px 20px',
      borderRight: `1px solid ${A2_COLORS.rule}`,
      background: A2_COLORS.bg,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ fontFamily: a2Mono, color: A2_COLORS.accent, fontSize: 11 }}>▾</span>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{title}</span>
      </div>
      <div style={{ fontFamily: a2Mono, fontSize: 10, color: A2_COLORS.ink3, letterSpacing: 0.5 }}>
        {tasks} TASKS · {active} ACTIVE
      </div>
      <div style={{ display: 'flex', gap: 4, marginTop: 10 }}>
        {a2Bracket('↑', { soft: true })}
        {a2Bracket('↓', { soft: true })}
      </div>
    </div>
  );
}

function EmptyCellA2() {
  return (
    <div style={{
      borderLeft: `1px solid ${A2_COLORS.rule}`,
      minHeight: 220,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: A2_COLORS.ink3, fontSize: 11, fontFamily: a2Mono, letterSpacing: 1,
    }}>— no tasks —</div>
  );
}

function TaskCardA2({ id, title, summary, status, assignee, tags }) {
  return (
    <div style={{
      background: A2_COLORS.paper,
      border: `1px solid ${A2_COLORS.rule}`,
      borderLeft: `3px solid ${A2_COLORS.ok}`,
      padding: '12px 14px',
      display: 'flex', flexDirection: 'column', gap: 10,
      cursor: 'pointer',
    }}>
      <div>
        <div style={{ fontFamily: a2Mono, fontSize: 10, color: A2_COLORS.ink3, letterSpacing: 0.5, marginBottom: 2 }}>
          {id}
        </div>
        <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.3 }}>{title}</div>
      </div>

      <div style={{ fontSize: 12, color: A2_COLORS.ink2, lineHeight: 1.5 }}>
        {summary}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{
          fontFamily: a2Mono, fontSize: 10, letterSpacing: 0.5,
          color: A2_COLORS.ok, background: A2_COLORS.okSoft,
          padding: '3px 6px',
        }}>● {status.toUpperCase()}</span>
        <span style={{
          fontFamily: a2Mono, fontSize: 10, color: A2_COLORS.ink2,
          padding: '3px 6px', border: `1px solid ${A2_COLORS.rule}`,
        }}>{assignee}</span>
        {tags.map(t => (
          <span key={t} style={{
            fontFamily: a2Mono, fontSize: 10, color: A2_COLORS.ink3,
          }}>#{t}</span>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 4, borderTop: `1px dashed ${A2_COLORS.rule}`, paddingTop: 10 }}>
        {a2Bracket('READ', { active: true })}
        {a2Bracket('WHY')}
        {a2Bracket('EXEC')}
        {a2Bracket('VERIFY')}
      </div>
    </div>
  );
}

window.VariantA2 = VariantA2;
