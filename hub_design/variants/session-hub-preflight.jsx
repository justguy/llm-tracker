// Preflight banner — appears at top of Run Session screen.
// Runs the checks that should fail BEFORE Brief opens (per PRD §preflight).

function PreflightBanner({ task, checks }) {
  if (!checks || checks.length === 0) return null;
  const hasFail = checks.some(c => c.status === 'fail');
  const hasWarn = checks.some(c => c.status === 'warn');
  const tone = hasFail ? 'block' : hasWarn ? 'warn' : 'ok';
  const c = tone === 'block' ? SH.block : tone === 'warn' ? SH.warn : SH.ok;
  const bg = tone === 'block' ? SH.blockSoft : tone === 'warn' ? SH.warnSoft : SH.okSoft;
  return (
    <div style={{
      padding: '10px 22px',
      background: bg, borderBottom: `1px solid ${c}33`,
      display: 'flex', alignItems: 'center', gap: 14,
    }}>
      <span style={{ fontFamily: shMono, fontSize: 10, color: c, letterSpacing: 0.6, fontWeight: 600 }}>
        PREFLIGHT · {hasFail ? 'blocks launch' : hasWarn ? 'review' : 'all clear'}
      </span>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', flex: 1 }}>
        {checks.map((ch, i) => <CheckChip key={i} ch={ch} />)}
      </div>
      {hasFail && <Bracket dense tone="warn">OVERRIDE</Bracket>}
    </div>
  );
}

function CheckChip({ ch }) {
  const c = ch.status === 'fail' ? SH.block
          : ch.status === 'warn' ? SH.warn
          :                        SH.ok;
  const glyph = ch.status === 'fail' ? '✕' : ch.status === 'warn' ? '!' : '✓';
  return (
    <span title={ch.detail} style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      fontFamily: shMono, fontSize: 10, color: c,
      background: 'rgba(255,255,255,0.55)',
      padding: '2px 6px',
      border: `1px solid ${c}55`,
      cursor: 'help',
    }}>
      <span style={{ fontWeight: 700 }}>{glyph}</span>
      {ch.label}
    </span>
  );
}

// Default preflight result — most things pass.
const PREFLIGHT_DEFAULT = [
  { label: 'no active job on task',           status: 'ok',   detail: 'task has no in-flight session' },
  { label: 'tracker rev fresh',                status: 'ok',   detail: 'rev:984 (HEAD) · no drift since list' },
  { label: 'worktree clean',                   status: 'ok',   detail: 'no overlapping sessions in ~/dev/Project-Phalanx' },
  { label: 'allowed_paths cover scope',        status: 'ok',   detail: 'repos.allowed_paths covers all task files' },
  { label: 'profile compatible with agent',    status: 'ok',   detail: 'reviewer + codex app-server: full capability' },
  { label: 'deps satisfied',                   status: 'ok',   detail: '2/2 deps closed' },
  { label: 'adapter accepts context injection',status: 'ok',   detail: 'codex app-server: direct injection supported' },
];
const PREFLIGHT_WARN = [
  { label: 'no active job on task',           status: 'ok' },
  { label: 'tracker rev fresh',                status: 'warn', detail: 'list was rev:982, HEAD is rev:984 (2 commits drift)' },
  { label: 'worktree clean',                   status: 'warn', detail: 'ses-V2QJ writes to same worktree · review CONFLICTS tab' },
  { label: 'allowed_paths cover scope',        status: 'ok' },
  { label: 'profile compatible with agent',    status: 'ok' },
  { label: 'deps satisfied',                   status: 'ok' },
];

window.PreflightBanner = PreflightBanner;
window.PREFLIGHT_DEFAULT = PREFLIGHT_DEFAULT;
window.PREFLIGHT_WARN = PREFLIGHT_WARN;

// ───────────────────────────────────────────────────────────
// Capability matrix — shown inside the runtime picker
// ───────────────────────────────────────────────────────────
function CapabilityMatrix({ agent }) {
  const caps = AGENT_CAPS[agent] || AGENT_CAPS['codex-app'];
  return (
    <div style={{
      padding: '10px 12px',
      background: SH.bgSink, border: `1px solid ${SH.rule}`,
      marginTop: 8,
    }}>
      <div style={{ fontFamily: shMono, fontSize: 10, color: SH.ink3, letterSpacing: 0.6, marginBottom: 8 }}>
        CAPABILITY · {caps.tierLabel}
      </div>
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4,
        fontFamily: shMono, fontSize: 11, lineHeight: 1.6,
      }}>
        {caps.items.map((c, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{
              width: 10, textAlign: 'center', fontWeight: 700,
              color: c.on ? SH.ok : SH.ink4,
            }}>{c.on ? '✓' : '○'}</span>
            <span style={{ color: c.on ? SH.ink : SH.ink3 }}>{c.label}</span>
          </div>
        ))}
      </div>
      {caps.note && (
        <div style={{
          marginTop: 8,
          fontFamily: shMono, fontSize: 10, color: SH.ink3, lineHeight: 1.55,
        }}>
          <span style={{ color: SH.warn }}>note</span> · {caps.note}
        </div>
      )}
    </div>
  );
}

const AGENT_CAPS = {
  'codex-app': {
    tierLabel: 'CODEX·APPSRV · structured tier',
    items: [
      { label: 'structured chat',          on: true },
      { label: 'structured approvals',     on: true },
      { label: 'context-usage reporting',  on: true },
      { label: 'direct context injection', on: true },
      { label: 'stop / restart',           on: true },
      { label: 'model swap mid-thread',    on: true },
      { label: 'raw stdio capture',        on: false },
      { label: 'streaming token output',   on: true },
    ],
  },
  'codex-cli': {
    tierLabel: 'HYBRID · pseudo-tty + MCP',
    items: [
      { label: 'structured chat',          on: true },
      { label: 'structured approvals',     on: true },
      { label: 'context-usage reporting',  on: true },
      { label: 'direct context injection', on: false },
      { label: 'stop / restart',           on: true },
      { label: 'model swap mid-thread',    on: false },
      { label: 'raw stdio capture',        on: true },
      { label: 'streaming token output',   on: true },
    ],
    note: 'model swap requires successor spawn with new launch config (not in-thread).',
  },
  'claude': {
    tierLabel: 'HYBRID · pseudo-tty + MCP',
    items: [
      { label: 'structured chat',          on: true },
      { label: 'structured approvals',     on: true },
      { label: 'context-usage reporting',  on: true },
      { label: 'direct context injection', on: true },
      { label: 'stop / restart',           on: true },
      { label: 'model swap mid-thread',    on: false },
      { label: 'raw stdio capture',        on: true },
      { label: 'streaming token output',   on: true },
    ],
  },
  'plain': {
    tierLabel: 'DUMB·TERM · raw stdio only',
    items: [
      { label: 'raw stdio capture',        on: true },
      { label: 'stdin write',              on: true },
      { label: 'stop / restart',           on: true },
      { label: 'structured chat',          on: false },
      { label: 'structured approvals',     on: false },
      { label: 'context-usage reporting',  on: false },
      { label: 'direct context injection', on: false },
      { label: 'model swap',               on: false },
    ],
    note: 'no MCP contract pasted in launch prompt — task status comes only from human or wrapped tools.',
  },
};

window.CapabilityMatrix = CapabilityMatrix;
window.AGENT_CAPS = AGENT_CAPS;
