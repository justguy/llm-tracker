// Variant B — Modern Minimal
// Softer sans UI chrome (Inter), JetBrains Mono reserved for IDs, tags, code-like data.
// One green-only accent for progress. Generous whitespace.
// Modal-free: tasks expand inline. Header actions collapse into 3 menus + command.

const B_COLORS = {
  bg: '#f8f7f4',
  paper: '#ffffff',
  ink: '#17181a',
  ink2: '#57595c',
  ink3: '#8f9195',
  ruleSoft: '#ececec',
  rule: '#dfdfdd',
  accent: '#2b8a4a',       // single green accent
  accentSoft: '#e8f3ea',
  pill: '#f2f1ec',
  danger: '#b14a3c',
  warn: '#c28a2a',
};

const bMono = `"JetBrains Mono", ui-monospace, Menlo, monospace`;
const bSans = `Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif`;

const BBracket = ({ children, active }) => (
  <span style={{
    fontFamily: bMono, fontSize: 11,
    color: active ? B_COLORS.accent : B_COLORS.ink2,
    letterSpacing: 0.3,
    padding: '3px 6px',
    borderRadius: 3,
    background: active ? B_COLORS.accentSoft : 'transparent',
    cursor: 'pointer',
  }}>[{children}]</span>
);

function VariantB() {
  return (
    <div style={{
      fontFamily: bSans,
      background: B_COLORS.bg,
      color: B_COLORS.ink,
      width: 1440, height: 900,
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>

      {/* ── Top bar: airy, single row ────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 20,
        padding: '16px 32px',
        background: B_COLORS.paper,
        borderBottom: `1px solid ${B_COLORS.rule}`,
      }}>
        {/* Project picker */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 22, height: 22, borderRadius: 5,
            background: B_COLORS.accent,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontSize: 11, fontWeight: 700, fontFamily: bMono,
          }}>h</div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, letterSpacing: -0.2 }}>
              hoplon <span style={{ color: B_COLORS.ink3, fontWeight: 400, marginLeft: 4 }}>▾</span>
            </div>
          </div>
        </div>

        <div style={{ width: 1, height: 18, background: B_COLORS.rule }} />

        {/* Menus, not a wall of buttons */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, fontSize: 13, color: B_COLORS.ink2 }}>
          <span style={{ cursor: 'pointer' }}>View <span style={{ color: B_COLORS.ink3, fontSize: 10 }}>▾</span></span>
          <span style={{ cursor: 'pointer' }}>Project <span style={{ color: B_COLORS.ink3, fontSize: 10 }}>▾</span></span>
          <span style={{ cursor: 'pointer' }}>Agent <span style={{ color: B_COLORS.ink3, fontSize: 10 }}>▾</span></span>
        </div>

        <div style={{ flex: 1 }} />

        {/* Command / filter */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '8px 12px',
          border: `1px solid ${B_COLORS.rule}`,
          borderRadius: 8,
          background: B_COLORS.bg,
          minWidth: 320,
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={B_COLORS.ink3} strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3-3"/></svg>
          <span style={{ fontSize: 12, color: B_COLORS.ink3 }}>Search or run a command…</span>
          <span style={{ marginLeft: 'auto', fontFamily: bMono, fontSize: 10, color: B_COLORS.ink3, padding: '2px 6px', border: `1px solid ${B_COLORS.rule}`, borderRadius: 4 }}>⌘K</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <BBracket>UNDO</BBracket>
          <BBracket>REDO</BBracket>
          <BBracket>⋯</BBracket>
        </div>
      </div>

      {/* ── Hero / summary row ─────────────────────────── */}
      <div style={{
        padding: '28px 32px 24px',
        background: B_COLORS.paper,
        borderBottom: `1px solid ${B_COLORS.rule}`,
        display: 'grid',
        gridTemplateColumns: '1.4fr 1fr 1fr',
        gap: 32,
      }}>
        {/* Left: project & progress */}
        <div>
          <div style={{ fontFamily: bMono, fontSize: 10, color: B_COLORS.ink3, letterSpacing: 1, marginBottom: 8 }}>
            PROJECT · REV 151
          </div>
          <div style={{ fontSize: 32, fontWeight: 600, letterSpacing: -0.8, marginBottom: 4 }}>
            Hoplon
          </div>
          <div style={{ fontSize: 13, color: B_COLORS.ink2, marginBottom: 20, fontFamily: bMono }}>
            ~/llm-tracker
          </div>

          {/* Big progress */}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
            <div style={{ fontSize: 44, fontWeight: 600, letterSpacing: -1.5 }}>94<span style={{ fontSize: 22, color: B_COLORS.ink3 }}>%</span></div>
            <div style={{ fontSize: 13, color: B_COLORS.ink2 }}>49 of 56 tasks complete</div>
          </div>
          <div style={{ display: 'flex', height: 6, borderRadius: 3, overflow: 'hidden', background: B_COLORS.ruleSoft }}>
            <div style={{ width: '87.5%', background: B_COLORS.accent }} />
            <div style={{ width: '1.8%', background: B_COLORS.warn }} />
          </div>
        </div>

        {/* Middle: status grid */}
        <div>
          <div style={{ fontFamily: bMono, fontSize: 10, color: B_COLORS.ink3, letterSpacing: 1, marginBottom: 12 }}>STATUS</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {[
              ['Complete', 49, B_COLORS.accent, true],
              ['In progress', 0, B_COLORS.warn],
              ['Not started', 1, B_COLORS.ink3],
              ['Deferred', 0, B_COLORS.ink3],
              ['Blocked', 0, B_COLORS.danger],
              ['Open', 56, B_COLORS.ink2, true],
            ].map(([label, val, color, strong]) => (
              <div key={label} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '8px 12px',
                background: strong ? B_COLORS.pill : 'transparent',
                borderRadius: 6,
              }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: B_COLORS.ink2 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />
                  {label}
                </span>
                <span style={{ fontFamily: bMono, fontSize: 13, fontWeight: 600, color: val > 0 ? B_COLORS.ink : B_COLORS.ink3 }}>{val}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Right: next up */}
        <div style={{
          background: B_COLORS.accentSoft,
          border: `1px solid ${B_COLORS.accent}33`,
          borderRadius: 10,
          padding: 20,
          display: 'flex', flexDirection: 'column', gap: 10,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontFamily: bMono, fontSize: 10, color: B_COLORS.accent, letterSpacing: 1, fontWeight: 600 }}>
              RECOMMENDED NEXT
            </div>
            <span style={{ fontFamily: bMono, fontSize: 10, color: B_COLORS.accent }}>T‑021</span>
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.3, color: B_COLORS.ink }}>
            HA / multi‑region snapshot replication
          </div>
          <div style={{ fontSize: 12, color: B_COLORS.ink2, lineHeight: 1.5 }}>
            Highest‑ranked ready task, P3 priority, dependencies satisfied, requires product/architecture approval.
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 'auto' }}>
            <button style={{
              fontFamily: bMono, fontSize: 12, padding: '8px 14px',
              background: B_COLORS.accent, color: '#fff',
              border: 'none', borderRadius: 6, cursor: 'pointer',
              letterSpacing: 0.3,
            }}>[PICK]</button>
            <button style={{
              fontFamily: bMono, fontSize: 12, padding: '8px 14px',
              background: 'transparent', color: B_COLORS.ink,
              border: `1px solid ${B_COLORS.rule}`, borderRadius: 6, cursor: 'pointer',
            }}>[READ]</button>
          </div>
        </div>
      </div>

      {/* ── Scratchpad — slim ─────────────────────────── */}
      <div style={{
        padding: '12px 32px',
        background: B_COLORS.paper,
        borderBottom: `1px solid ${B_COLORS.rule}`,
        display: 'flex', alignItems: 'center', gap: 16, fontSize: 12,
      }}>
        <span style={{ fontFamily: bMono, fontSize: 10, color: B_COLORS.ink3, letterSpacing: 1 }}>NOTE</span>
        <span style={{ flex: 1, color: B_COLORS.ink2 }}>
          t‑024, t‑034, t‑035 complete on current worktree. gRPC follow‑on beyond PG1 and broader Layer 2 rollout remain separate lanes.
        </span>
        <BBracket>EDIT</BBracket>
      </div>

      {/* ── Board area ─────────────────────────────────── */}
      <div style={{
        flex: 1,
        background: B_COLORS.bg,
        padding: '20px 32px',
        display: 'flex',
        gap: 16,
        overflow: 'hidden',
      }}>

        {/* Left rail: lanes list (collapsible-first) */}
        <div style={{
          width: 220, flexShrink: 0,
          display: 'flex', flexDirection: 'column', gap: 2,
        }}>
          <div style={{ fontFamily: bMono, fontSize: 10, color: B_COLORS.ink3, letterSpacing: 1, marginBottom: 8 }}>
            SWIMLANES · 9
          </div>
          {[
            { t: 'History — Phase 1', c: 1, d: 0, active: true },
            { t: 'History — Phase 1.5', c: 1, d: 1 },
            { t: 'History — Phase 2', c: 5, d: 5 },
            { t: 'P0 — Hoplon‑on‑Hoplon', c: 7, d: 7 },
            { t: 'Host Integration', c: 5, d: 5, live: true },
            { t: 'Transport Layer', c: 12, d: 9 },
            { t: 'Layer 2 Rollout', c: 8, d: 6 },
            { t: 'GRPC Follow‑on', c: 11, d: 10 },
            { t: 'Ops / Audit', c: 6, d: 6 },
          ].map((l, i) => (
            <div key={i} style={{
              padding: '10px 12px',
              background: l.active ? B_COLORS.paper : 'transparent',
              border: l.active ? `1px solid ${B_COLORS.rule}` : `1px solid transparent`,
              borderRadius: 6,
              cursor: 'pointer',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 12, fontWeight: l.active ? 600 : 500, color: B_COLORS.ink }}>{l.t}</span>
                {l.live && <span style={{ width: 6, height: 6, borderRadius: '50%', background: B_COLORS.accent }} />}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: bMono, fontSize: 10, color: B_COLORS.ink3 }}>
                <span>{l.d}/{l.c}</span>
                <div style={{ flex: 1, height: 2, background: B_COLORS.ruleSoft, borderRadius: 1, overflow: 'hidden' }}>
                  <div style={{ width: `${(l.d/l.c)*100}%`, height: '100%', background: l.d === l.c ? B_COLORS.accent : B_COLORS.warn }} />
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Main board — active lane in 4 priority columns */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 14 }}>
            <div style={{ fontSize: 18, fontWeight: 600, letterSpacing: -0.3 }}>History — Phase 1</div>
            <div style={{ fontFamily: bMono, fontSize: 11, color: B_COLORS.ink3 }}>1 task · 0 active</div>
          </div>

          <div style={{
            flex: 1,
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr 1fr',
            gap: 4,
          }}>
            {['P0 · Now', 'P1 · Next', 'P2 · Soon', 'P3 · Later'].map((h, idx) => (
              <div key={h} style={{
                background: B_COLORS.paper,
                border: `1px solid ${B_COLORS.rule}`,
                borderRadius: 10,
                padding: 12,
                display: 'flex', flexDirection: 'column', gap: 10,
                minHeight: 0, overflow: 'hidden',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontFamily: bMono, fontSize: 10, letterSpacing: 1, color: idx === 0 ? B_COLORS.ink : B_COLORS.ink3, fontWeight: idx === 0 ? 600 : 500 }}>
                    {h.toUpperCase()}
                  </div>
                  <div style={{ fontFamily: bMono, fontSize: 10, color: B_COLORS.ink3 }}>{idx === 0 ? 1 : 0}</div>
                </div>

                {idx === 0 ? (
                  <TaskCardB
                    id="T‑012"
                    title="Phase 1 — bounded local subsystem"
                    summary="18 slices across 8 waves: contracts, 7 mandatory + 1 optional adapters, 4 engine operations, health, reconcile, gc. Proof suite 25/25 covering M1–M15."
                    status="complete"
                    assignee="claude‑opus‑4‑6"
                    tags={['phase1', 'milestone']}
                  />
                ) : (
                  <div style={{
                    flex: 1,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 11, color: B_COLORS.ink3, fontFamily: bMono,
                    border: `1px dashed ${B_COLORS.rule}`, borderRadius: 6,
                    minHeight: 120,
                  }}>empty</div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function TaskCardB({ id, title, summary, status, assignee, tags }) {
  return (
    <div style={{
      border: `1px solid ${B_COLORS.rule}`,
      borderRadius: 8,
      padding: 14,
      display: 'flex', flexDirection: 'column', gap: 10,
      cursor: 'pointer',
      transition: 'border-color 120ms',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <span style={{ fontFamily: bMono, fontSize: 10, color: B_COLORS.ink3 }}>{id}</span>
        <span style={{
          fontSize: 10, fontFamily: bMono, letterSpacing: 0.5,
          color: B_COLORS.accent, background: B_COLORS.accentSoft,
          padding: '2px 6px', borderRadius: 3,
        }}>● {status}</span>
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.3, letterSpacing: -0.2 }}>{title}</div>
      <div style={{ fontSize: 12, color: B_COLORS.ink2, lineHeight: 1.5 }}>{summary}</div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          fontSize: 11, color: B_COLORS.ink2,
        }}>
          <span style={{ width: 16, height: 16, borderRadius: '50%', background: B_COLORS.pill, fontSize: 9, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontFamily: bMono, color: B_COLORS.ink2 }}>C</span>
          <span style={{ fontFamily: bMono }}>{assignee}</span>
        </span>
        {tags.map(t => (
          <span key={t} style={{
            fontFamily: bMono, fontSize: 10, color: B_COLORS.ink2,
            background: B_COLORS.pill, padding: '2px 6px', borderRadius: 3,
          }}>{t}</span>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 4, paddingTop: 8, borderTop: `1px solid ${B_COLORS.ruleSoft}` }}>
        <BBracket active>READ</BBracket>
        <BBracket>WHY</BBracket>
        <BBracket>EXEC</BBracket>
        <BBracket>VERIFY</BBracket>
      </div>
    </div>
  );
}

window.VariantB = VariantB;
