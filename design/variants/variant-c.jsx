// Variant C — Focus Stream (bold rethink)
// Rethinks the core interaction: agents are picking ONE task at a time.
// Left: compact lane/priority navigator. Center: "now playing" focus card
// with the agent context inline (no modal). Right: timeline of agent activity.
// Bracket buttons preserved as actionable verbs.

const C_COLORS = {
  bg: '#0f1013',
  panel: '#16181d',
  panel2: '#1c1f25',
  rule: '#262a33',
  ruleSoft: '#1f232b',
  ink: '#e9ebef',
  ink2: '#a3a8b3',
  ink3: '#6b707c',
  accent: '#f0b23a',     // subdued amber, not bright
  accentSoft: 'rgba(240,178,58,0.12)',
  ok: '#5cbd6a',
  okSoft: 'rgba(92,189,106,0.15)',
  block: '#d46b5e',
  warn: '#e3a052',
};
const cMono = `"JetBrains Mono", ui-monospace, Menlo, monospace`;
const cSans = `Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif`;

const CBracket = ({ children, tone = 'default', size = 'sm' }) => {
  const color =
    tone === 'accent' ? C_COLORS.accent :
    tone === 'ok' ? C_COLORS.ok :
    tone === 'block' ? C_COLORS.block :
    C_COLORS.ink2;
  return (
    <span style={{
      fontFamily: cMono,
      fontSize: size === 'md' ? 12 : 11,
      letterSpacing: 0.4,
      color,
      padding: size === 'md' ? '6px 10px' : '4px 7px',
      border: `1px solid ${tone === 'accent' ? C_COLORS.accent : C_COLORS.rule}`,
      background: tone === 'accent' ? C_COLORS.accentSoft : 'transparent',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }}>[{children}]</span>
  );
};

function VariantC() {
  return (
    <div style={{
      fontFamily: cSans,
      background: C_COLORS.bg,
      color: C_COLORS.ink,
      width: 1440, height: 900,
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* ── Top bar ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 20,
        padding: '14px 24px',
        borderBottom: `1px solid ${C_COLORS.rule}`,
        background: C_COLORS.panel,
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <span style={{ fontFamily: cMono, fontSize: 10, color: C_COLORS.ink3, letterSpacing: 1.5 }}>LLM·TRACKER</span>
          <span style={{ fontSize: 15, fontWeight: 600 }}>hoplon</span>
          <span style={{ fontFamily: cMono, fontSize: 10, color: C_COLORS.ink3 }}>rev 151 · 94%</span>
        </div>

        <div style={{ flex: 1 }} />

        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '8px 14px',
          background: C_COLORS.panel2,
          border: `1px solid ${C_COLORS.rule}`,
          minWidth: 420,
        }}>
          <span style={{ fontFamily: cMono, fontSize: 11, color: C_COLORS.accent }}>⌘K</span>
          <span style={{ color: C_COLORS.ink3, fontSize: 12 }}>jump to task, run agent command, fuzzy search…</span>
        </div>

        <div style={{ display: 'flex', gap: 4 }}>
          <CBracket>UNDO</CBracket>
          <CBracket>REDO</CBracket>
          <CBracket>?</CBracket>
        </div>
      </div>

      {/* ── Body: 3-column focus layout ── */}
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '260px 1fr 320px', minHeight: 0 }}>

        {/* LEFT — lanes + priority nav */}
        <aside style={{
          background: C_COLORS.panel,
          borderRight: `1px solid ${C_COLORS.rule}`,
          overflowY: 'auto',
          padding: '16px 0',
        }}>
          {/* Priority pills */}
          <div style={{ padding: '0 16px 12px' }}>
            <div style={{ fontFamily: cMono, fontSize: 10, color: C_COLORS.ink3, letterSpacing: 1.2, marginBottom: 10 }}>PRIORITY</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              {[['P0', 1, true], ['P1', 0], ['P2', 0], ['P3', 6]].map(([p, n, active]) => (
                <div key={p} style={{
                  padding: '8px 10px',
                  background: active ? C_COLORS.accentSoft : C_COLORS.panel2,
                  border: `1px solid ${active ? C_COLORS.accent : C_COLORS.rule}`,
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}>
                  <span style={{ fontFamily: cMono, fontSize: 11, color: active ? C_COLORS.accent : C_COLORS.ink2 }}>{p}</span>
                  <span style={{ fontFamily: cMono, fontSize: 11, color: active ? C_COLORS.accent : C_COLORS.ink3 }}>{n}</span>
                </div>
              ))}
            </div>
          </div>

          <div style={{ height: 1, background: C_COLORS.rule, margin: '8px 0 12px' }} />

          <div style={{ padding: '0 16px 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontFamily: cMono, fontSize: 10, color: C_COLORS.ink3, letterSpacing: 1.2 }}>SWIMLANES · 9</div>
            <span style={{ fontFamily: cMono, fontSize: 10, color: C_COLORS.accent, cursor: 'pointer' }}>[+]</span>
          </div>

          {[
            { t: 'History — Phase 1', done: 1, total: 1, active: true, focusedTask: true },
            { t: 'History — Phase 1.5', done: 1, total: 1 },
            { t: 'History — Phase 2', done: 5, total: 5 },
            { t: 'P0 — Hoplon‑on‑Hoplon', done: 7, total: 7 },
            { t: 'Host Integration', done: 5, total: 5, live: true },
            { t: 'Transport Layer', done: 9, total: 12 },
            { t: 'Layer 2 Rollout', done: 6, total: 8 },
            { t: 'GRPC Follow‑on', done: 10, total: 11 },
            { t: 'Ops / Audit', done: 6, total: 6 },
          ].map((l, i) => (
            <div key={i} style={{
              padding: '10px 16px',
              background: l.focusedTask ? C_COLORS.panel2 : 'transparent',
              borderLeft: `2px solid ${l.focusedTask ? C_COLORS.accent : 'transparent'}`,
              cursor: 'pointer',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 12, color: l.focusedTask ? C_COLORS.ink : C_COLORS.ink2, fontWeight: l.focusedTask ? 600 : 500 }}>{l.t}</span>
                {l.live && <span style={{ width: 5, height: 5, borderRadius: '50%', background: C_COLORS.ok }} />}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: cMono, fontSize: 10, color: C_COLORS.ink3 }}>
                <span>{l.done}/{l.total}</span>
                <div style={{ flex: 1, height: 2, background: C_COLORS.ruleSoft, overflow: 'hidden' }}>
                  <div style={{ width: `${(l.done/l.total)*100}%`, height: '100%', background: l.done === l.total ? C_COLORS.ok : C_COLORS.warn }} />
                </div>
              </div>
            </div>
          ))}
        </aside>

        {/* CENTER — focused task */}
        <main style={{ overflow: 'auto', padding: '28px 40px' }}>
          {/* Breadcrumb + actions */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, fontSize: 12, color: C_COLORS.ink3 }}>
            <span style={{ fontFamily: cMono }}>history — phase 1</span>
            <span>›</span>
            <span style={{ fontFamily: cMono }}>p0 · now</span>
            <span>›</span>
            <span style={{ fontFamily: cMono, color: C_COLORS.ink2 }}>t‑012</span>
            <div style={{ flex: 1 }} />
            <CBracket>← prev</CBracket>
            <CBracket>next →</CBracket>
          </div>

          {/* Header */}
          <div style={{ marginBottom: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <span style={{ fontFamily: cMono, fontSize: 11, color: C_COLORS.ink3 }}>T‑012</span>
              <span style={{
                fontFamily: cMono, fontSize: 10, letterSpacing: 0.5,
                color: C_COLORS.ok, background: C_COLORS.okSoft,
                padding: '3px 8px',
              }}>● COMPLETE</span>
              <span style={{
                fontFamily: cMono, fontSize: 10, color: C_COLORS.ink2,
                padding: '3px 8px', border: `1px solid ${C_COLORS.rule}`,
              }}>P0 · phase1</span>
              <span style={{
                fontFamily: cMono, fontSize: 10, color: C_COLORS.ink2,
                padding: '3px 8px', border: `1px solid ${C_COLORS.rule}`,
              }}>ready: yes</span>
            </div>
            <h1 style={{
              fontSize: 28, fontWeight: 600, letterSpacing: -0.5, margin: 0,
              lineHeight: 1.2,
            }}>Phase 1 — bounded local subsystem</h1>
            <div style={{ marginTop: 10, fontFamily: cMono, fontSize: 11, color: C_COLORS.ink3 }}>
              assignee: <span style={{ color: C_COLORS.accent }}>claude‑opus‑4‑6</span> · last touch rev 1 · 4/13/2026
            </div>
          </div>

          {/* Verb row (primary actions) */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 26 }}>
            <CBracket tone="accent" size="md">READ</CBracket>
            <CBracket size="md">WHY</CBracket>
            <CBracket size="md">EXEC</CBracket>
            <CBracket size="md">VERIFY</CBracket>
            <div style={{ flex: 1 }} />
            <CBracket>PIN</CBracket>
            <CBracket>+C</CBracket>
          </div>

          {/* Two-col inline sections */}
          <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 28 }}>
            <div>
              <SectionC label="GOAL">
                18 slices across 8 waves: contracts, 7 mandatory + 1 optional adapters, 4 engine operations
                (createSnapshot, auditDiff, revertUncontracted, packContext), health, reconcile, gc.
                Proof suite 25/25 covering M1–M15.
              </SectionC>

              <SectionC label="SNIPPETS · 0 SHOWN">
                <span style={{ color: C_COLORS.ink3, fontStyle: 'italic' }}>no snippets</span>
              </SectionC>

              <SectionC label="RECENT HISTORY">
                <div style={{ fontFamily: cMono, fontSize: 11, color: C_COLORS.ink2, lineHeight: 1.7 }}>
                  <div><span style={{ color: C_COLORS.accent }}>rev 1</span> · 4/13/2026 · 9:51pm</div>
                  <div style={{ color: C_COLORS.ink3, paddingLeft: 14 }}>+ meta.name → "Hoplon"</div>
                  <div style={{ color: C_COLORS.ink3, paddingLeft: 14 }}>+ meta.slug → "hoplon"</div>
                  <div style={{ color: C_COLORS.ink3, paddingLeft: 14 }}>+ swimlanes[0..8]</div>
                </div>
              </SectionC>
            </div>

            <div>
              <SectionC label="DEPENDENCIES">
                <span style={{ color: C_COLORS.ink3 }}>none</span>
              </SectionC>
              <SectionC label="RELATED">
                <span style={{ color: C_COLORS.ink3 }}>none</span>
              </SectionC>
              <SectionC label="REFERENCES">
                <span style={{ color: C_COLORS.ink3 }}>no references</span>
              </SectionC>

              <SectionC label="WHY IT EXISTS">
                <div style={{ fontSize: 13, color: C_COLORS.ink2, lineHeight: 1.6 }}>
                  Bounds the local subsystem before adding cross‑region
                  complexity. Unblocks Phase 1.5 wave.
                </div>
              </SectionC>
            </div>
          </div>
        </main>

        {/* RIGHT — live activity */}
        <aside style={{
          background: C_COLORS.panel,
          borderLeft: `1px solid ${C_COLORS.rule}`,
          display: 'flex', flexDirection: 'column', minHeight: 0,
        }}>
          <div style={{
            padding: '14px 16px',
            borderBottom: `1px solid ${C_COLORS.rule}`,
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <div>
              <div style={{ fontFamily: cMono, fontSize: 10, color: C_COLORS.ink3, letterSpacing: 1.2 }}>AGENT STREAM</div>
              <div style={{ fontSize: 13, fontWeight: 600, marginTop: 2 }}>live · 3 agents</div>
            </div>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: C_COLORS.ok, boxShadow: `0 0 0 3px ${C_COLORS.okSoft}` }} />
          </div>

          {/* Recommended next — callout */}
          <div style={{
            margin: 14,
            padding: 14,
            border: `1px solid ${C_COLORS.accent}55`,
            background: C_COLORS.accentSoft,
          }}>
            <div style={{ fontFamily: cMono, fontSize: 10, color: C_COLORS.accent, letterSpacing: 1.2, marginBottom: 6 }}>
              ★ NEXT RECOMMENDED
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4, lineHeight: 1.3 }}>
              HA / multi‑region snapshot replication
            </div>
            <div style={{ fontFamily: cMono, fontSize: 10, color: C_COLORS.ink3, marginBottom: 10 }}>
              T‑021 · p3 · ready · approval needed
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <CBracket tone="accent">PICK</CBracket>
              <CBracket>READ</CBracket>
            </div>
          </div>

          {/* Timeline */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px 16px' }}>
            <div style={{ fontFamily: cMono, fontSize: 10, color: C_COLORS.ink3, letterSpacing: 1.2, marginBottom: 10 }}>RECENT ACTIVITY</div>
            {[
              { agent: 'claude‑opus‑4‑6', action: 'completed', task: 'T‑012 Phase 1 bounded', time: '6:55', tone: 'ok' },
              { agent: 'claude‑opus‑4‑6', action: 'patched', task: 'scratchpad', time: '6:42' },
              { agent: 'codex‑cli', action: 'picked', task: 'T‑035 host rollout', time: '6:18', tone: 'accent' },
              { agent: 'claude‑opus‑4‑6', action: 'verified', task: 'T‑034 Layer 2 wire', time: '5:53', tone: 'ok' },
              { agent: 'agent‑mcp', action: 'queried', task: 'fuzzy-search "snapshot"', time: '5:41' },
              { agent: 'claude‑opus‑4‑6', action: 'executed', task: 'T‑024 reconcile gc', time: '5:22' },
              { agent: 'human', action: 'edited', task: 'decision d‑016', time: '4:58', tone: 'warn' },
            ].map((a, i) => {
              const color = a.tone === 'ok' ? C_COLORS.ok : a.tone === 'accent' ? C_COLORS.accent : a.tone === 'warn' ? C_COLORS.warn : C_COLORS.ink2;
              return (
                <div key={i} style={{
                  display: 'flex', gap: 10,
                  padding: '10px 0',
                  borderBottom: `1px solid ${C_COLORS.ruleSoft}`,
                }}>
                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: color, marginTop: 6, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, color: C_COLORS.ink, lineHeight: 1.4 }}>
                      <span style={{ fontFamily: cMono, color: C_COLORS.ink2 }}>{a.agent}</span>
                      {' '}<span style={{ color }}>{a.action}</span>
                    </div>
                    <div style={{ fontFamily: cMono, fontSize: 11, color: C_COLORS.ink3, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {a.task}
                    </div>
                  </div>
                  <div style={{ fontFamily: cMono, fontSize: 10, color: C_COLORS.ink3, whiteSpace: 'nowrap' }}>{a.time}</div>
                </div>
              );
            })}
          </div>
        </aside>
      </div>
    </div>
  );
}

function SectionC({ label, children }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{
        fontFamily: cMono, fontSize: 10, color: C_COLORS.accent,
        letterSpacing: 1.2, marginBottom: 8,
      }}>{label}</div>
      <div style={{ fontSize: 13, color: C_COLORS.ink, lineHeight: 1.6 }}>{children}</div>
    </div>
  );
}

window.VariantC = VariantC;
