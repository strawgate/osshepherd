/**
 * sidebar.js — Preact components for the OSShepherd review sidebar.
 *
 * Loaded by sidepanel.html (chrome.sidePanel page).
 * Depends on: vendor/preact-htm.js, utils/markdown.js
 * Mount logic is in sidepanel-mount.js.
 */

/* global html, useState, useEffect, useCallback, useMemo, useContext,
          useErrorBoundary, createContext, signal,
          CRMarkdown, formatRelativeTime */

// ---------------------------------------------------------------------------
// Error boundary — catches render errors and shows a fallback
// ---------------------------------------------------------------------------

function ErrorBoundary({ children, label }) {
  const [error, setError] = useState(null);
  useErrorBoundary((err) => {
    console.error(`[CR:sidebar] ${label || 'Component'} error:`, err);
    setError(err);
  });
  if (error) {
    return html`<div class="cr-error-fallback">
      <span>Something went wrong${label ? ` in ${label}` : ''}.</span>
      <button class="cr-action-btn" onClick=${() => setError(null)}>Retry</button>
    </div>`;
  }
  return children;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function severityRank(sev) {
  return { critical: 0, high: 1, major: 1, medium: 2, minor: 2, low: 3, trivial: 4 }[sev] ?? 5;
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function stripAIHeader(text) {
  if (!text) return '';
  return text.replace(/^##\s+AI-generated summary of changes\n\n?/, '').trim();
}

/** Extract "Estimated code review effort: X" from a file summary. Returns null or lowercase level. */
function parseEffort(text) {
  if (!text) return null;
  const m = text.match(/Estimated code review effort:\s*(\d+)\s*\[(\w+)\]/i)
         || text.match(/Estimated code review effort:\s*(\w+)/i);
  if (!m) return null;
  // Match either "3 [High]" or "High"
  const raw = (m[2] || m[1]).toLowerCase();
  if (['high', 'medium', 'low', 'trivial', 'minimal'].includes(raw)) return raw === 'minimal' ? 'trivial' : raw;
  return null;
}

// ---------------------------------------------------------------------------
// Summary metadata parser (best-effort, all fields optional)
// ---------------------------------------------------------------------------

function parseSummaryMeta(text) {
  if (!text) return null;
  const isStructured =
    /\*\*Actionable comments posted:/i.test(text) ||
    /Review info/i.test(text) ||
    /Run configuration/i.test(text) ||
    /Files selected for processing/i.test(text);
  if (!isStructured) return null;

  const meta = {};
  const countMatch = text.match(/\*\*Actionable comments posted:\s*(\d+)\*\*/);
  meta.actionableCount = countMatch ? parseInt(countMatch[1], 10) : 0;

  const kv = (label) => {
    try {
      const m = text.match(new RegExp(`\\*\\*${label}\\*\\*:\\s*(.+)`));
      return m ? m[1].replace(/`/g, '').trim() : null;
    } catch { return null; }
  };
  meta.config = kv('Configuration used');
  meta.profile = kv('Review profile');
  meta.plan = kv('Plan');
  meta.runId = kv('Run ID');

  try {
    const fb = text.match(/Files selected for processing \(\d+\)<\/summary>\n\n([\s\S]*?)\n\n<\/details>/) ||
               text.match(/Files selected for processing[^<]*<\/summary>\s*([\s\S]*?)<\/details>/);
    if (fb) meta.files = fb[1].split('\n').map(l => l.replace(/^\*\s+/, '').replace(/`/g, '').trim()).filter(Boolean);
  } catch { /* best-effort */ }

  try {
    const cb = text.match(/📥 Commits<\/summary>\n\n([\s\S]*?)\n\n<\/details>/) ||
               text.match(/Commits<\/summary>\s*([\s\S]*?)<\/details>/);
    if (cb) meta.commits = cb[1].trim();
  } catch { /* best-effort */ }

  try {
    const pb = text.match(/Prompt for [\s\S]*?```\n([\s\S]*?)```/);
    if (pb) meta.agentPrompt = pb[1].trim();
  } catch { /* best-effort */ }

  return meta;
}

// ---------------------------------------------------------------------------
// Context — eliminates prop drilling for navigation and tab switching
// ---------------------------------------------------------------------------

const SidebarContext = createContext({
  onNavigate: () => {},
  onSwitchTab: () => {},
  pr: null,
});

// ---------------------------------------------------------------------------
// Review signal — fine-grained reactivity for streaming updates
// ---------------------------------------------------------------------------

const reviewSignal = signal(null);

// ---------------------------------------------------------------------------
// Navigation helper
// ---------------------------------------------------------------------------

function navigateToFileLine(pr, filename, startLine) {
  if (!pr || !filename) return;
  chrome.storage.session.set({ crReopenSidebar: 'feedback' });
  sha256Hex(filename).then(hash => {
    const anchor = startLine ? `R${startLine}` : '';
    window.location.href = `/${pr.owner}/${pr.repo}/pull/${pr.prNumber}/files#diff-${hash}${anchor}`;
  });
}

// ---------------------------------------------------------------------------
// Small components
// ---------------------------------------------------------------------------

function Markdown({ text }) {
  if (!text) return null;
  return html`<div class="cr-md" dangerouslySetInnerHTML=${{ __html: CRMarkdown.render(text) }} />`;
}

function SeverityBadge({ severity }) {
  const s = severity || 'none';
  return html`<span class="cr-severity cr-severity-${s}">${s}</span>`;
}

function CopyButton({ text, label = '📋 Copy', copiedLabel = '✓ Copied', title, class: cls }) {
  const [copied, setCopied] = useState(false);
  const onClick = useCallback((e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [text]);
  const classes = ['cr-action-btn', copied ? 'copied' : '', cls].filter(Boolean).join(' ');
  return html`<button class=${classes} onClick=${onClick} title=${title || ''}>
    ${copied ? copiedLabel : label}
  </button>`;
}

// ---------------------------------------------------------------------------
// Toolbar: progress tracker + age/rerun (combined for density)
// ---------------------------------------------------------------------------

const STAGES = ['setup', 'summarizing', 'reviewing', 'complete'];
const STAGE_LABELS = { setup: 'Setup', summarizing: 'Summarize', reviewing: 'Review', complete: 'Done' };
const STAGE_TABS = { setup: 'setup', summarizing: 'files', reviewing: 'feedback', complete: 'feedback' };

function Toolbar({ review, onRerun }) {
  const { onSwitchTab } = useContext(SidebarContext);
  let stage = 'setup';
  if (review.status === 'complete' || review.status === 'error') stage = 'complete';
  else if (review.reviewStatus === 'summarizing') stage = 'summarizing';
  else if (review.reviewStatus === 'reviewing') stage = 'reviewing';

  const currentIdx = STAGES.indexOf(stage);
  const isDone = review.status === 'complete' || review.status === 'error';
  const ts = review.completedAt || review.startedAt;
  const age = ts ? formatRelativeTime(ts) : '';
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (review.status !== 'complete' || !review.completedAt) return;
    let cancelled = false;
    (async () => {
      try {
        const pr = { owner: review.owner, repo: review.repo, prNumber: review.prNumber };
        const resp = await fetch(
          `https://api.github.com/repos/${pr.owner}/${pr.repo}/pulls/${pr.prNumber}/commits`,
          { headers: { Accept: 'application/vnd.github.v3+json' } }
        );
        if (!resp.ok || cancelled) return;
        const commits = await resp.json();
        if (commits.length && !cancelled) {
          const last = new Date(commits[commits.length - 1].commit.committer.date).getTime();
          if (last > review.completedAt) setStale(true);
        }
      } catch { /* best-effort */ }
    })();
    return () => { cancelled = true; };
  }, [review.completedAt, review.owner, review.repo, review.prNumber, review.status]);

  return html`
    <div class="cr-toolbar visible">
      ${!isDone && html`
        <div class="cr-toolbar-row tracker-row">
          ${STAGES.map((s, idx) => html`
            ${idx > 0 && html`<div class="cr-tracker-line ${idx <= currentIdx ? 'done' : ''}" />`}
            <div
              class="cr-tracker-step ${idx < currentIdx ? 'done' : idx === currentIdx ? 'active' : ''}"
              onClick=${() => (idx <= currentIdx) && onSwitchTab(STAGE_TABS[s])}
            >
              <div class="cr-tracker-dot">✓</div>
              <span>${STAGE_LABELS[s]}</span>
            </div>
          `)}
        </div>
      `}
      <div class="cr-toolbar-row info-row">
        <span class="cr-review-age">
          ${isDone ? `Reviewed ${age}` : 'In progress…'}
          ${stale && html`<span class="cr-review-stale"> outdated</span>`}
        </span>
        <button class="cr-rerun-btn" disabled=${!isDone} onClick=${onRerun}>↻ Re-run</button>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Summary panel
// ---------------------------------------------------------------------------

// HeroStat removed — severity chips in the Feedback filter bar serve the same purpose.

function FileSummaryCard({ filename, summary, isStreaming }) {
  const { onNavigate } = useContext(SidebarContext);
  const [expanded, setExpanded] = useState(false);
  const effort = useMemo(() => parseEffort(summary), [summary]);
  return html`
    <div class="cr-stream-card ${isStreaming ? 'cr-stream-enter' : ''}">
      <div class="cr-stream-file cr-clickable-file" onClick=${() => onNavigate(filename, '')}>
        <span class="cr-stream-file-name">${filename}</span>
        ${effort && html`<span class="cr-effort-badge cr-effort-${effort}">${effort} effort</span>`}
      </div>
      <div class="cr-stream-body cr-md ${expanded ? '' : 'cr-preview'}">
        <${Markdown} text=${stripAIHeader(summary)} />
      </div>
      <button class="cr-stream-expand" onClick=${() => setExpanded(!expanded)}>
        ${expanded ? 'Show less ▴' : 'Show more ▾'}
      </button>
    </div>
  `;
}

function FileSummariesSection({ fileEntries, isStreaming }) {
  const effortOrder = ['high', 'medium', 'low', 'trivial'];

  // Parse effort for each file
  const filesWithEffort = useMemo(() =>
    fileEntries.map(([fn, s]) => [fn, s, parseEffort(s) || 'unknown']),
    [fileEntries]
  );

  // Effort counts
  const effortCounts = useMemo(() => {
    const counts = {};
    for (const [,, e] of filesWithEffort) counts[e] = (counts[e] || 0) + 1;
    return counts;
  }, [filesWithEffort]);

  // Filter state — low and trivial hidden by default (like feedback hides trivial+LGTM)
  const [hiddenEfforts, setHiddenEfforts] = useState(new Set(['low', 'trivial']));
  const toggleEffort = useCallback((e) => {
    setHiddenEfforts(prev => {
      const next = new Set(prev);
      if (next.has(e)) next.delete(e); else next.add(e);
      return next;
    });
  }, []);

  // Group by mode
  const [groupBy, setGroupBy] = useState('effort'); // 'effort' | 'flat'

  const filtered = useMemo(
    () => filesWithEffort.filter(([,, e]) => !hiddenEfforts.has(e)),
    [filesWithEffort, hiddenEfforts]
  );

  // Grouped by effort level
  const byEffort = useMemo(() => {
    const groups = new Map();
    for (const [fn, s, e] of filtered) {
      if (!groups.has(e)) groups.set(e, []);
      groups.get(e).push([fn, s]);
    }
    const order = [...effortOrder, 'unknown'];
    return order.filter(e => groups.has(e)).map(e => [e, groups.get(e)]);
  }, [filtered]);

  const hasEffort = Object.keys(effortCounts).length > 1 || !effortCounts.unknown;
  const allEfforts = [...effortOrder, 'unknown'];

  if (isStreaming) {
    return html`
      ${fileEntries.map(([fn, s]) => html`
        <${FileSummaryCard} key=${fn} filename=${fn} summary=${s} isStreaming=${true} />
      `)}
    `;
  }

  return html`
    ${hasEffort && html`
      <div class="cr-filter-bar">
        ${allEfforts.filter(e => effortCounts[e]).map(e => html`
          <button key=${e}
            class="cr-filter-chip cr-effort-chip-${e} ${hiddenEfforts.has(e) ? 'dimmed' : ''}"
            onClick=${() => toggleEffort(e)}>
            ${effortCounts[e]} ${e === 'unknown' ? 'other' : e}
          </button>
        `)}
        <span class="cr-tab-spacer" />
        <button class="cr-group-toggle" onClick=${() => setGroupBy(groupBy === 'effort' ? 'flat' : 'effort')}
          title=${groupBy === 'effort' ? 'Show flat list' : 'Group by effort'}>
          ${groupBy === 'effort' ? '☰ flat' : '⊞ by effort'}
        </button>
      </div>
    `}
    ${filtered.length === 0 && html`<div class="cr-empty">All files filtered out. Click a badge above to show.</div>`}
    ${groupBy === 'effort' && hasEffort ? byEffort.map(([effort, files]) => html`
      <div class="cr-effort-group" key=${effort}>
        <div class="cr-effort-group-header">
          <span class="cr-effort-badge cr-effort-${effort}">${effort === 'unknown' ? 'other' : effort} effort</span>
          <span>${files.length} file${files.length !== 1 ? 's' : ''}</span>
        </div>
        ${files.map(([fn, s]) => html`
          <${FileSummaryCard} key=${fn} filename=${fn} summary=${s} isStreaming=${false} />
        `)}
      </div>
    `) : filtered.map(([fn, s]) => html`
      <${FileSummaryCard} key=${fn} filename=${fn} summary=${s} isStreaming=${false} />
    `)}
  `;
}

/** Above-tabs overview: just the PR title. */
function ReviewOverview({ review }) {
  if (!review.prTitle) return null;
  return html`
    <div class="cr-overview">
      <div class="cr-pr-title-row">
        <p class="cr-pr-title">
          <span class="cr-pr-title-label">Suggested Title</span>
          ${review.prTitle}
        </p>
        <${CopyButton} text=${review.prTitle} label="📋" copiedLabel="✓" title="Copy suggested title" />
      </div>
    </div>
  `;
}

function FileSummariesPanel({ review }) {
  const fileEntries = useMemo(() => Object.entries(review.fileSummaries || {}), [review.fileSummaries]);
  const isStreaming = review.status === 'reviewing' || review.status === 'pending';
  const meta = useMemo(() => review.summary ? parseSummaryMeta(review.summary) : null, [review.summary]);

  // Timestamp for file summaries
  const summaryEvent = (review.rawEvents || []).find(e =>
    e.type === 'state_update' && e.payload?.internalState?.rawSummaryMap
  );
  const elapsed = summaryEvent?.payload?.timestamp && review.startedAt
    ? Math.round((summaryEvent.payload.timestamp - review.startedAt) / 1000)
    : null;

  if (!fileEntries.length && !review.summary) {
    return html`<div class="cr-empty">Waiting for file summaries…</div>`;
  }

  return html`
    ${!meta && review.summary && html`
      <div class="cr-summary-text cr-md">
        <${Markdown} text=${review.summary} />
      </div>
    `}
    ${fileEntries.length > 0 && html`
      <${FileSummariesSection} fileEntries=${fileEntries} isStreaming=${isStreaming} elapsed=${elapsed} />
    `}
  `;
}

// ---------------------------------------------------------------------------
// Comments panel
// ---------------------------------------------------------------------------

function CommentCard({ comment: c }) {
  const { onNavigate } = useContext(SidebarContext);
  const rawText = c.comment || c.codegenInstructions || '';

  const goToLine = useCallback((e) => {
    e.stopPropagation();
    if (c.filename) onNavigate(c.filename, c.startLine);
  }, [c.filename, c.startLine, onNavigate]);

  const lineLabel = c.startLine
    ? (c.endLine && c.endLine !== c.startLine
      ? `Go to lines ${c.startLine}–${c.endLine}`
      : `Go to line ${c.startLine}`)
    : '';

  return html`
    <div class="cr-comment-card cr-card-sev-${c.severity || 'none'}">
      <div class="cr-comment-header">
        <div class="cr-comment-meta">
          <${SeverityBadge} severity=${c.severity} />
          ${lineLabel && html`<span class="cr-line-link" onClick=${goToLine}>${lineLabel} →</span>`}
        </div>
        <div class="cr-comment-actions-inline">
          ${c.codegenInstructions && html`
            <${CopyButton} text=${c.codegenInstructions} label="🤖" copiedLabel="✓" title="Copy AI fix prompt for this issue" />
          `}
          <${CopyButton} text=${rawText} label="📋" copiedLabel="✓" title="Copy comment" />
        </div>
      </div>
      <div class="cr-comment-text">
        <${Markdown} text=${rawText} />
      </div>
    </div>
  `;
}

function CommentsPanel({ review, agentPrompt }) {
  const { onNavigate } = useContext(SidebarContext);
  const comments = review.comments || [];

  // Filter state — trivial and LGTM hidden by default
  const [hiddenSevs, setHiddenSevs] = useState(new Set(['trivial', 'none']));
  const toggleSev = useCallback((sev) => {
    setHiddenSevs(prev => {
      const next = new Set(prev);
      if (next.has(sev)) next.delete(sev); else next.add(sev);
      return next;
    });
  }, []);

  // Group by mode
  const [groupBy, setGroupBy] = useState('severity'); // 'severity' | 'file'

  const filtered = useMemo(
    () => comments.filter(c => !hiddenSevs.has(c.severity || 'none')),
    [comments, hiddenSevs]
  );

  // Severity counts (all, not filtered)
  const sevCounts = useMemo(() => {
    const counts = {};
    for (const c of comments) { const s = c.severity || 'none'; counts[s] = (counts[s] || 0) + 1; }
    return counts;
  }, [comments]);
  const sevOrder = ['critical', 'high', 'major', 'medium', 'minor', 'low', 'trivial', 'none'];

  // Grouped views
  const bySeverity = useMemo(() => {
    const groups = new Map();
    for (const c of filtered) {
      const s = c.severity || 'none';
      if (!groups.has(s)) groups.set(s, []);
      groups.get(s).push(c);
    }
    return sevOrder.filter(s => groups.has(s)).map(s => [s, groups.get(s)]);
  }, [filtered]);

  const byFile = useMemo(() => {
    const groups = new Map();
    for (const c of filtered) {
      const f = c.filename || 'unknown';
      if (!groups.has(f)) groups.set(f, []);
      groups.get(f).push(c);
    }
    return [...groups.entries()].sort((a, b) =>
      severityRank((a[1][0] || {}).severity) - severityRank((b[1][0] || {}).severity)
    );
  }, [filtered]);

  if (!comments.length) return html`<div class="cr-empty">No comments yet.</div>`;

  return html`
    <div class="cr-filter-bar">
      ${sevOrder.filter(s => sevCounts[s]).map(sev => html`
        <button key=${sev}
          class="cr-filter-chip cr-sev-badge-${sev === 'none' ? 'lgtm' : sev} ${hiddenSevs.has(sev) ? 'dimmed' : ''}"
          onClick=${() => toggleSev(sev)}>
          ${sevCounts[sev]} ${sev === 'none' ? 'LGTM' : sev}
        </button>
      `)}
      <span class="cr-tab-spacer" />
      ${agentPrompt && html`
        <${CopyButton} text=${agentPrompt} label="🤖 Fix" copiedLabel="✓ Copied" title="Copy AI prompt to fix all issues" class="cr-prompt-chip" />
      `}
      <button class="cr-group-toggle" onClick=${() => setGroupBy(groupBy === 'severity' ? 'file' : 'severity')}
        title=${groupBy === 'severity' ? 'Group by file' : 'Group by severity'}>
        ${groupBy === 'severity' ? '⊞ by file' : '⊟ by severity'}
      </button>
    </div>
    ${filtered.length === 0 && html`<div class="cr-empty">All comments filtered out. Click a badge above to show.</div>`}
    ${groupBy === 'severity' ? bySeverity.map(([sev, items]) => html`
      <div class="cr-sev-group" key=${sev}>
        ${items.map((c, i) => html`<${CommentCard} key=${c.fingerprint || i} comment=${c} />`)}
      </div>
    `) : byFile.map(([file, items]) => html`
      <div class="cr-file-group" key=${file}>
        <div class="cr-file-group-header cr-clickable-file" onClick=${() => onNavigate(file, '')}>
          <span>${file}</span>
          <span>${items.length} finding${items.length !== 1 ? 's' : ''}</span>
        </div>
        ${items.map((c, i) => html`<${CommentCard} key=${c.fingerprint || i} comment=${c} />`)}
      </div>
    `)}
  `;
}

// ---------------------------------------------------------------------------
// Raw panel
// ---------------------------------------------------------------------------

function RawPanel({ review }) {
  const events = review.rawEvents || [];
  if (!events.length) return html`<div class="cr-empty">No events yet.</div>`;
  return html`${events.map((e, i) => html`
    <div class="cr-raw-event" key=${i}>
      <span class="cr-raw-event-type">[${e.type}]</span>
      ${'\n'}${JSON.stringify(e.payload ?? e, null, 2)}
    </div>
  `)}`;
}

// ---------------------------------------------------------------------------
// Setup panel
// ---------------------------------------------------------------------------

function SetupPanel({ review }) {
  const { onNavigate } = useContext(SidebarContext);
  const meta = useMemo(() => review.summary ? parseSummaryMeta(review.summary) : null, [review.summary]);
  if (!meta) return html`<div class="cr-empty">No review info yet.</div>`;

  return html`
    <div class="cr-setup-grid">
      ${meta.profile && html`
        <div class="cr-setup-card">
          <div class="cr-setup-label">Review Profile</div>
          <div class="cr-setup-value">${meta.profile}</div>
        </div>
      `}
      ${meta.plan && html`
        <div class="cr-setup-card">
          <div class="cr-setup-label">Plan</div>
          <div class="cr-setup-value">${meta.plan}</div>
        </div>
      `}
      ${meta.config && html`
        <div class="cr-setup-card">
          <div class="cr-setup-label">Configuration</div>
          <div class="cr-setup-value">${meta.config}</div>
        </div>
      `}
      ${meta.commits && html`
        <div class="cr-setup-card">
          <div class="cr-setup-label">Commits</div>
          <div class="cr-setup-value">${meta.commits}</div>
        </div>
      `}
      ${meta.runId && html`
        <div class="cr-setup-card">
          <div class="cr-setup-label">Run ID</div>
          <div class="cr-setup-value" style="font-family:monospace;font-size:11px;color:#8b949e">${meta.runId}</div>
        </div>
      `}
    </div>
    ${meta.files?.length > 0 && html`
      <div class="cr-setup-card cr-setup-full">
        <div class="cr-setup-label">Files Reviewed (${meta.files.length})</div>
        <div class="cr-setup-files">
          ${meta.files.map(f => html`
            <div class="cr-tile-file" key=${f} onClick=${() => onNavigate(f, '')}>${f}</div>
          `)}
        </div>
      </div>
    `}
    ${meta.agentPrompt && html`
      <div class="cr-setup-card cr-setup-full">
        <div class="cr-setup-label">AI Agent Prompt</div>
        <pre class="cr-setup-prompt">${meta.agentPrompt}</pre>
      </div>
    `}
  `;
}

// ---------------------------------------------------------------------------
// Root sidebar component
// ---------------------------------------------------------------------------

/**
 * Root sidebar component.
 * Reads review data from reviewSignal (fine-grained reactivity).
 * Provides SidebarContext so children can navigate/switch tabs without prop drilling.
 */
function Sidebar({ initialTab, onClose, onRerun }) {
  const review = reviewSignal.value;
  const [activeTab, setActiveTab] = useState(initialTab || 'feedback');
  const pr = useMemo(
    () => review ? { owner: review.owner, repo: review.repo, prNumber: review.prNumber } : null,
    [review?.owner, review?.repo, review?.prNumber]
  );
  const actionableCount = useMemo(
    () => (review?.comments || []).filter(c => c.severity !== 'none').length,
    [review?.comments]
  );
  const agentPrompt = useMemo(() => {
    const meta = review?.summary ? parseSummaryMeta(review.summary) : null;
    return meta?.agentPrompt || null;
  }, [review?.summary]);

  const onNavigate = useCallback((filename, line) => {
    if (pr) navigateToFileLine(pr, filename, line);
  }, [pr]);

  const switchTab = useCallback((tab) => setActiveTab(tab), []);

  const ctx = useMemo(() => ({ onNavigate, onSwitchTab: switchTab, pr }), [onNavigate, switchTab, pr]);

  if (!review) {
    return html`<div class="cr-empty">Waiting for review…</div>`;
  }

  return html`
    <${SidebarContext.Provider} value=${ctx}>
      <div class="cr-resize-handle" />
      <div class="cr-header">
        <div style="display:flex;align-items:center;gap:8px">
          <span class="cr-status-badge ${review.status || ''}">
            ${{ pending: 'Pending', reviewing: 'Reviewing…', complete: 'Complete', error: 'Error' }[review.status] || review.status}
          </span>
          <span class="cr-pr-slug">${review.owner}/${review.repo}#${review.prNumber}</span>
        </div>
        <button class="cr-close" onClick=${onClose}>✕</button>
      </div>
      <${Toolbar} review=${review} onRerun=${onRerun} />
      <${ReviewOverview} review=${review} />
      <div class="cr-tabs">
        ${['feedback', 'files', 'setup'].map(tab => html`
          <button key=${tab} class="cr-tab ${activeTab === tab ? 'active' : ''}" onClick=${() => switchTab(tab)}>
            ${tab === 'feedback' ? html`Feedback <span class="cr-tab-badge">${actionableCount}</span>` :
              tab === 'files' ? 'File Summaries' : 'Setup'}
          </button>
        `)}
        <span class="cr-tab-spacer" />
        <button class="cr-tab cr-tab-secondary ${activeTab === 'raw' ? 'active' : ''}" onClick=${() => switchTab('raw')}>Raw</button>
      </div>
      <div class="cr-panels">
        <div class="cr-panel ${activeTab === 'files' ? 'active' : ''}">
          <${ErrorBoundary} label="File Summaries"><${FileSummariesPanel} review=${review} /><//>
        </div>
        <div class="cr-panel ${activeTab === 'feedback' ? 'active' : ''}">
          <${ErrorBoundary} label="Feedback"><${CommentsPanel} review=${review} agentPrompt=${agentPrompt} /><//>
        </div>
        <div class="cr-panel ${activeTab === 'raw' ? 'active' : ''}">
          <${ErrorBoundary} label="Raw"><${RawPanel} review=${review} /><//>
        </div>
        <div class="cr-panel ${activeTab === 'setup' ? 'active' : ''}">
          <${ErrorBoundary} label="Setup"><${SetupPanel} review=${review} /><//>
        </div>
      </div>
    <//>
  `;
}

// Components and signals are available as globals for sidepanel-mount.js
// Mount logic is in sidepanel-mount.js (for chrome.sidePanel) — no shadow DOM.
