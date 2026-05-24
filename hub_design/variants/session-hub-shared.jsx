// Shared tokens + primitives for Session Hub designs
// Strictly matches existing LLM-Tracker terminal aesthetic.

const SH = {
  bg:        '#faf7f1',
  bgSink:    '#f4efe4',
  paper:     '#ffffff',
  paperAlt:  '#fbf8f1',
  ink:       '#23201b',
  ink2:      '#5a5348',
  ink3:      '#8a8374',
  ink4:      '#b8b0a0',
  rule:      '#e8e2d4',
  ruleSoft:  '#f0ebde',
  accent:    '#b84a1a',          // single warm accent
  accentSoft:'#f6e3d6',
  ok:        '#3a7d3a',
  okSoft:    '#e2efdc',
  warn:      '#a8741a',           // quiet / waiting
  warnSoft:  '#f4e6cf',
  block:     '#a83838',           // blocked / approval-needed
  blockSoft: '#f1d8d6',
  info:      '#3a5a7d',           // info / context-high
  infoSoft:  '#d8e1ec',
  ghost:     '#a09782',
};

const shMono = `"JetBrains Mono", ui-monospace, Menlo, monospace`;
const shSans = `Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif`;

// ───────────────────────────────────────────────────────────
// [BRACKET] action — the "action DNA" of the tracker UI
// ───────────────────────────────────────────────────────────
function Bracket({ children, active, tone, soft, dense, dim, style, onClick }) {
  const color = tone === 'ok'    ? SH.ok
              : tone === 'block' ? SH.block
              : tone === 'warn'  ? SH.warn
              : tone === 'info'  ? SH.info
              : active           ? SH.accent
              : dim              ? SH.ink3
              :                    SH.ink2;
  return (
    <span onClick={onClick} style={{
      fontFamily: shMono,
      fontSize: dense ? 10 : 11,
      letterSpacing: 0.4,
      color,
      whiteSpace: 'nowrap',
      padding: dense ? '2px 5px' : '3px 6px',
      border: active
        ? `1px solid ${SH.accent}`
        : `1px solid ${soft ? 'transparent' : SH.rule}`,
      background: active ? SH.accentSoft : 'transparent',
      cursor: onClick ? 'pointer' : 'default',
      userSelect: 'none',
      ...style,
    }}>[{children}]</span>
  );
}

// ───────────────────────────────────────────────────────────
// Dot — colored status dot
// ───────────────────────────────────────────────────────────
function Dot({ tone = 'ink3', size = 6, pulse, style }) {
  const c = tone === 'ok'    ? SH.ok
          : tone === 'warn'  ? SH.warn
          : tone === 'block' ? SH.block
          : tone === 'info'  ? SH.info
          : tone === 'accent'? SH.accent
          :                    SH.ink3;
  return (
    <span style={{
      display: 'inline-block',
      width: size, height: size, borderRadius: '50%',
      background: c, flexShrink: 0,
      boxShadow: pulse ? `0 0 0 3px ${c}22` : undefined,
      ...style,
    }} />
  );
}

// ───────────────────────────────────────────────────────────
// Mono pill — a compact label like `STATUS:ACTIVE` or `CODEX/app-server`
// ───────────────────────────────────────────────────────────
function MonoPill({ children, tone, filled, dim, style }) {
  const color = tone === 'ok'    ? SH.ok
              : tone === 'warn'  ? SH.warn
              : tone === 'block' ? SH.block
              : tone === 'info'  ? SH.info
              : tone === 'accent'? SH.accent
              : dim              ? SH.ink3
              :                    SH.ink2;
  const bg = filled
    ? (tone === 'ok'    ? SH.okSoft
      : tone === 'warn'  ? SH.warnSoft
      : tone === 'block' ? SH.blockSoft
      : tone === 'info'  ? SH.infoSoft
      : tone === 'accent'? SH.accentSoft
      :                    SH.bgSink)
    : 'transparent';
  return (
    <span style={{
      fontFamily: shMono, fontSize: 10, letterSpacing: 0.5,
      color, background: bg,
      padding: '2px 6px',
      border: filled ? 'none' : `1px solid ${SH.rule}`,
      whiteSpace: 'nowrap',
      ...style,
    }}>{children}</span>
  );
}

// ───────────────────────────────────────────────────────────
// Source label — every reported state carries its evidence source
// ───────────────────────────────────────────────────────────
function SourceLabel({ src }) {
  const map = {
    structured: { c: SH.ok,     t: 'structured' },
    reported:   { c: SH.info,   t: 'reported'   },
    derived:    { c: SH.warn,   t: 'derived'    },
    manual:     { c: SH.ink3,   t: 'manual'     },
    unknown:    { c: SH.ink4,   t: 'unknown'    },
  };
  const m = map[src] || map.unknown;
  return (
    <span style={{
      fontFamily: shMono, fontSize: 9, letterSpacing: 0.6,
      color: m.c, textTransform: 'lowercase',
    }}>· {m.t}</span>
  );
}

// ───────────────────────────────────────────────────────────
// Section header
// ───────────────────────────────────────────────────────────
function LaneHead({ children, style }) {
  return (
    <div style={{
      fontFamily: shMono, fontSize: 10, letterSpacing: 1.2,
      color: SH.ink3, textTransform: 'uppercase',
      ...style,
    }}>{children}</div>
  );
}

// ───────────────────────────────────────────────────────────
// Capability tier badge (PRD §7)
// ───────────────────────────────────────────────────────────
function CapTier({ tier }) {
  const map = {
    dumb:   { label: 'DUMB·TERM',     color: SH.ink3,  bg: SH.bgSink },
    mcp:    { label: 'MCP·TRACKED',   color: SH.info,  bg: SH.infoSoft },
    codex:  { label: 'CODEX·APPSRV',  color: SH.accent,bg: SH.accentSoft },
    hybrid: { label: 'HYBRID',        color: SH.ok,    bg: SH.okSoft },
  };
  const m = map[tier] || map.dumb;
  return (
    <span style={{
      fontFamily: shMono, fontSize: 9, letterSpacing: 0.7,
      color: m.color, background: m.bg,
      padding: '2px 5px',
    }}>{m.label}</span>
  );
}

// ───────────────────────────────────────────────────────────
// Skill plan progress — dots representing job lifecycle hooks
//   each step has key, label, status (done|active|pending|fail|skip)
// ───────────────────────────────────────────────────────────
function SkillTrack({ steps, style }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, ...style }}>
      {steps.map((s, i) => {
        const isDone = s.s === 'done';
        const isActive = s.s === 'active';
        const isFail = s.s === 'fail';
        const isSkip = s.s === 'skip';
        const c = isFail ? SH.block
                : isDone ? SH.ok
                : isActive ? SH.accent
                : isSkip ? SH.ink4
                : SH.ink4;
        return (
          <React.Fragment key={s.k}>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              fontFamily: shMono, fontSize: 10, letterSpacing: 0.4,
              color: isActive ? SH.accent : isDone ? SH.ok : isFail ? SH.block : SH.ink3,
            }}>
              <span style={{
                width: 8, height: 8,
                background: isDone || isActive ? c : 'transparent',
                border: `1px solid ${c}`,
                borderRadius: isActive ? '50%' : 0,
                boxShadow: isActive ? `0 0 0 2px ${c}22` : 'none',
              }} />
              {s.label}
            </span>
            {i < steps.length - 1 && (
              <span style={{ width: 8, height: 1, background: SH.rule }} />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ───────────────────────────────────────────────────────────
// Activity sparkline — last-N-minutes output ticks
// ───────────────────────────────────────────────────────────
function ActivitySpark({ data, tone = 'ok', height = 18, width = 96 }) {
  const c = tone === 'ok'    ? SH.ok
          : tone === 'warn'  ? SH.warn
          : tone === 'block' ? SH.block
          :                    SH.ink3;
  const max = Math.max(1, ...data);
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-end', gap: 1,
      height, width,
    }}>
      {data.map((v, i) => (
        <div key={i} style={{
          flex: 1,
          height: `${Math.max(2, (v / max) * height)}px`,
          background: v === 0 ? SH.ruleSoft : c,
          opacity: v === 0 ? 1 : 0.4 + 0.6 * (v / max),
        }} />
      ))}
    </div>
  );
}

// ───────────────────────────────────────────────────────────
// ModelChip — switchable model picker chip
// ───────────────────────────────────────────────────────────
function ModelChip({ model, dim, style }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontFamily: shMono, fontSize: 10, letterSpacing: 0.4,
      color: dim ? SH.ink3 : SH.ink,
      background: SH.bgSink,
      border: `1px solid ${SH.rule}`,
      padding: '2px 5px 2px 6px',
      cursor: 'pointer',
      ...style,
    }}>
      <span style={{ color: SH.ink3, fontSize: 9, letterSpacing: 0.6 }}>MODEL</span>
      <span>{model}</span>
      <span style={{ color: SH.ink3, fontSize: 9 }}>▾</span>
    </span>
  );
}

// ───────────────────────────────────────────────────────────
// ContextMeter — token gauge with bar + numeric readout
// ───────────────────────────────────────────────────────────
function ContextMeter({ used, total = 200, width = 96, label = 'CTX', compact }) {
  const pct = Math.min(1, used / total);
  const tone = pct >= 0.85 ? SH.block
             : pct >= 0.7  ? SH.warn
             : pct >= 0.4  ? SH.info
             :                SH.ok;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      fontFamily: shMono, fontSize: 10, color: SH.ink3,
    }}>
      {!compact && <span style={{ color: SH.ink3, fontSize: 9, letterSpacing: 0.6 }}>{label}</span>}
      <span style={{
        position: 'relative',
        width, height: 6,
        background: SH.ruleSoft,
        display: 'inline-block',
      }}>
        <span style={{
          position: 'absolute', left: 0, top: 0, bottom: 0,
          width: (pct * 100) + '%',
          background: tone,
        }} />
        {/* danger zone tick */}
        <span style={{
          position: 'absolute', left: '85%', top: -1, bottom: -1,
          width: 1, background: SH.ink4,
        }} />
      </span>
      <span style={{ color: tone === SH.block ? SH.block : tone === SH.warn ? SH.warn : SH.ink2, minWidth: 56 }}>
        {used}k / {total}k
      </span>
    </span>
  );
}

// ───────────────────────────────────────────────────────────
// SandboxChip — sandbox mode (workspace-write, read-only, full-auto)
// ───────────────────────────────────────────────────────────
function SandboxChip({ mode, style }) {
  const map = {
    readonly:  { label: 'read-only',       tone: 'ok',     hint: 'asks for any write' },
    workspace: { label: 'workspace-write', tone: 'info',   hint: 'asks outside repo' },
    autoedit:  { label: 'auto-edit',       tone: 'warn',   hint: 'asks for shell/net' },
    full:      { label: 'full-auto',       tone: 'block',  hint: 'never asks · danger' },
    danger:    { label: 'danger-full',     tone: 'block',  hint: 'never asks · danger' },
  };
  const m = map[mode] || map.workspace;
  const c = m.tone === 'ok'    ? SH.ok
          : m.tone === 'info'  ? SH.info
          : m.tone === 'warn'  ? SH.warn
          : m.tone === 'block' ? SH.block
          :                      SH.ink2;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontFamily: shMono, fontSize: 10, letterSpacing: 0.4,
      color: c,
      border: `1px solid ${c}55`,
      background: m.tone === 'ok'    ? SH.okSoft
                : m.tone === 'info'  ? SH.infoSoft
                : m.tone === 'warn'  ? SH.warnSoft
                : m.tone === 'block' ? SH.blockSoft
                :                      'transparent',
      padding: '2px 5px',
      cursor: 'pointer',
      ...style,
    }}>
      <span style={{ fontSize: 9, letterSpacing: 0.6, color: c, opacity: 0.7 }}>SANDBOX</span>
      <span style={{ fontWeight: 600 }}>{m.label}</span>
      <span style={{ fontSize: 9, opacity: 0.7 }}>▾</span>
    </span>
  );
}

// ───────────────────────────────────────────────────────────
// NowDoing — current activity line ("now: running npm test…")
// ───────────────────────────────────────────────────────────
function NowDoing({ kind, text, dur, idle }) {
  const map = {
    edit:    { label: 'editing',   c: SH.accent },
    shell:   { label: 'shell',     c: SH.info   },
    read:    { label: 'reading',   c: SH.ink2   },
    test:    { label: 'testing',   c: SH.info   },
    think:   { label: 'thinking',  c: SH.warn   },
    mcp:     { label: 'mcp call',  c: SH.info   },
    approval:{ label: 'awaiting approval', c: SH.block },
    idle:    { label: 'idle',      c: SH.ink3   },
    done:    { label: 'done',      c: SH.ok     },
  };
  const m = map[kind] || map.idle;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '6px 8px',
      background: SH.bg,
      border: `1px solid ${SH.ruleSoft}`,
      borderLeft: `2px solid ${m.c}`,
      fontFamily: shMono, fontSize: 11, color: SH.ink,
      minWidth: 0,
    }}>
      <span style={{
        fontSize: 9, letterSpacing: 0.6, color: m.c,
        textTransform: 'uppercase',
      }}>
        {idle ? '○ idle' : '▶ now'} · {m.label}
      </span>
      <span style={{
        flex: 1, color: SH.ink2, minWidth: 0,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{text}</span>
      {dur && <span style={{ color: SH.ink3, flexShrink: 0 }}>{dur}</span>}
    </div>
  );
}

// expose
// ───────────────────────────────────────────────────────────
// StdioChip — surfaces whether raw stdio is being written to disk
//   (per TDD: logs may contain secrets, are not redacted)
// ───────────────────────────────────────────────────────────
function StdioChip({ mode, style }) {
  const map = {
    live:      { label: 'STDIO LIVE',     tone: 'warn', hint: 'streaming, no disk capture' },
    captured:  { label: 'STDIO CAPTURED', tone: 'warn', hint: 'written to disk · not redacted · audit logs' },
    off:       { label: 'STDIO OFF',      tone: 'ok',   hint: 'structured channel only' },
    none:      { label: 'NO STDIO',       tone: 'ok',   hint: 'no raw stream' },
  };
  const m = map[mode] || map.off;
  const c = m.tone === 'ok'    ? SH.ok
          : m.tone === 'warn'  ? SH.warn
          : m.tone === 'block' ? SH.block
          :                      SH.ink2;
  return (
    <span title={m.hint} style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontFamily: shMono, fontSize: 10, letterSpacing: 0.4,
      color: c,
      border: `1px solid ${c}55`,
      background: m.tone === 'ok'    ? SH.okSoft
                : m.tone === 'warn'  ? SH.warnSoft
                : m.tone === 'block' ? SH.blockSoft
                :                      'transparent',
      padding: '2px 5px',
      cursor: 'help',
      ...style,
    }}>
      <span style={{ fontWeight: 600 }}>{m.label}</span>
    </span>
  );
}

window.StdioChip = StdioChip;
window.ModelChip = ModelChip;
window.ContextMeter = ContextMeter;
window.SandboxChip = SandboxChip;
window.NowDoing = NowDoing;
window.SH = SH;
window.shMono = shMono;
window.shSans = shSans;
window.Bracket = Bracket;
window.Dot = Dot;
window.MonoPill = MonoPill;
window.SourceLabel = SourceLabel;
window.LaneHead = LaneHead;
window.CapTier = CapTier;
window.SkillTrack = SkillTrack;
window.ActivitySpark = ActivitySpark;
