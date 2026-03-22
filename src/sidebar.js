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
const STAGE_TABS = { setup: 'setup', summarizing: 'files', reviewing: 'feedback', complete: 'files' };

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
      <div class="cr-toolbar-row tracker-row">
        ${STAGES.map((s, idx) => html`
          ${idx > 0 && html`<div class="cr-tracker-line ${idx <= currentIdx ? 'done' : ''}" />`}
          <div
            class="cr-tracker-step ${idx < currentIdx ? 'done' : idx === currentIdx ? (isDone ? 'done' : 'active') : ''}"
            onClick=${() => (idx <= currentIdx) && onSwitchTab(STAGE_TABS[s])}
          >
            <div class="cr-tracker-dot">✓</div>
            <span>${STAGE_LABELS[s]}</span>
          </div>
        `)}
      </div>
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

function HeroStat({ review, meta }) {
  const { onSwitchTab } = useContext(SidebarContext);
  const actionable = useMemo(
    () => (review.comments || []).filter(c => c.severity !== 'none'),
    [review.comments]
  );
  const sevCounts = useMemo(() => {
    const counts = {};
    for (const c of actionable) { const s = c.severity || 'medium'; counts[s] = (counts[s] || 0) + 1; }
    return counts;
  }, [actionable]);

  const isZero = actionable.length === 0;

  const onClick = useCallback(() => {
    if (actionable.length > 0) onSwitchTab('feedback');
  }, [actionable.length, onSwitchTab]);

  return html`
    <div class="cr-hero-row">
      <div class="cr-hero cr-hero-clickable" onClick=${onClick}>
        <span class="cr-hero-number ${isZero ? 'zero' : ''}">${actionable.length}</span>
        <div>
          <div class="cr-hero-label">
            ${isZero ? 'All Clear' : `Actionable Finding${actionable.length !== 1 ? 's' : ''}`}
            ${actionable.length > 0 && ' →'}
          </div>
          ${Object.keys(sevCounts).length > 0 && html`
            <div class="cr-hero-breakdown">
              ${Object.entries(sevCounts)
                .sort((a, b) => severityRank(a[0]) - severityRank(b[0]))
                .map(([sev, n]) => html`<span class="cr-sev-dot cr-sev-dot-${sev}">${n} ${sev}</span>`)}
            </div>
          `}
        </div>
      </div>
      ${meta?.agentPrompt && html`
        <${CopyButton} text=${meta.agentPrompt} label="🤖" copiedLabel="✓" title="Copy AI prompt to fix these issues" class="cr-copy-prompt-btn" />
      `}
    </div>
  `;
}

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

function FileSummariesSection({ fileEntries, isStreaming, elapsed }) {
  const effortCounts = useMemo(() => {
    const counts = {};
    for (const [, summary] of fileEntries) {
      const e = parseEffort(summary);
      if (e) counts[e] = (counts[e] || 0) + 1;
    }
    return counts;
  }, [fileEntries]);
  const hasEffort = Object.keys(effortCounts).length > 0;
  const effortOrder = ['high', 'medium', 'low', 'trivial'];

  return html`
    <div class="cr-timeline-divider">
      <span class="cr-timeline-line" />
      <span class="cr-timeline-label">
        ${isStreaming
          ? html`<span class="cr-emoji">📝</span> File Summaries${elapsed !== null ? ` · ${elapsed}s` : ''}`
          : html`<span class="cr-emoji">📝</span> ${fileEntries.length} File${fileEntries.length !== 1 ? 's' : ''} Analyzed`}
      </span>
      <span class="cr-timeline-line" />
    </div>
    ${hasEffort && !isStreaming && html`
      <div class="cr-effort-bar">
        <span class="cr-effort-label">Review Effort</span>
        ${effortOrder.filter(e => effortCounts[e]).map(e => html`
          <span class="cr-effort-badge cr-effort-${e}">${effortCounts[e]} ${e}</span>
        `)}
      </div>
    `}
    ${fileEntries.map(([fn, s]) => html`
      <${FileSummaryCard} key=${fn} filename=${fn} summary=${s} isStreaming=${isStreaming} />
    `)}
  `;
}

/** Above-tabs overview: PR title + actionable findings hero. */
function ReviewOverview({ review }) {
  const meta = useMemo(() => review.summary ? parseSummaryMeta(review.summary) : null, [review.summary]);
  if (!review.prTitle && !meta) return null;
  return html`
    <div class="cr-overview">
      ${review.prTitle && html`
        <div class="cr-pr-title-row">
          <p class="cr-pr-title">
            <span class="cr-pr-title-label">Suggested Title</span>
            ${review.prTitle}
          </p>
          <${CopyButton} text=${review.prTitle} label="📋" copiedLabel="✓" title="Copy suggested title" />
        </div>
      `}
      ${meta && html`<${HeroStat} review=${review} meta=${meta} />`}
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
        <${CopyButton} text=${rawText} label="📋" copiedLabel="✓" title="Copy comment" />
      </div>
      <div class="cr-comment-text">
        <${Markdown} text=${rawText} />
      </div>
    </div>
  `;
}

function CommentsPanel({ review }) {
  const { onNavigate } = useContext(SidebarContext);
  const comments = review.comments || [];
  const actionable = useMemo(
    () => comments.filter(c => c.severity !== 'none').sort((a, b) => severityRank(a.severity) - severityRank(b.severity)),
    [comments]
  );
  const lgtm = useMemo(() => comments.filter(c => c.severity === 'none'), [comments]);

  // Severity counts for badge bar
  const sevCounts = useMemo(() => {
    const counts = {};
    for (const c of actionable) { const s = c.severity || 'medium'; counts[s] = (counts[s] || 0) + 1; }
    return counts;
  }, [actionable]);

  // Group by file, sorted by highest severity
  const fileGroups = useMemo(() => {
    const byFile = new Map();
    for (const c of actionable) {
      if (!byFile.has(c.filename)) byFile.set(c.filename, []);
      byFile.get(c.filename).push(c);
    }
    return [...byFile.entries()].sort((a, b) => severityRank(a[1][0].severity) - severityRank(b[1][0].severity));
  }, [actionable]);

  if (!comments.length) return html`<div class="cr-empty">No comments yet.</div>`;

  return html`
    ${(Object.keys(sevCounts).length > 0 || lgtm.length > 0) && html`
      <div class="cr-sev-bar">
        ${Object.entries(sevCounts)
          .sort((a, b) => severityRank(a[0]) - severityRank(b[0]))
          .map(([sev, n]) => html`<span class="cr-sev-badge cr-sev-badge-${sev}">${n} ${sev}</span>`)}
        ${lgtm.length > 0 && html`<span class="cr-sev-badge cr-sev-badge-lgtm">${lgtm.length} LGTM</span>`}
      </div>
    `}
    ${fileGroups.map(([file, fileComments]) => html`
      <div class="cr-file-group" key=${file}>
        <div class="cr-file-group-header cr-clickable-file" onClick=${() => onNavigate(file, '')}>
          <span>${file}</span>
          <span>${fileComments.length} finding${fileComments.length !== 1 ? 's' : ''}</span>
        </div>
        ${fileComments.map((c, i) => html`<${CommentCard} key=${c.fingerprint || i} comment=${c} />`)}
      </div>
    `)}
    ${lgtm.length > 0 && html`
      <div class="cr-timeline-divider" style="margin-top:16px">
        <span class="cr-timeline-line" />
        <span class="cr-timeline-label"><span class="cr-emoji">✅</span> ${lgtm.length} LGTM</span>
        <span class="cr-timeline-line" />
      </div>
      ${lgtm.map((c, i) => html`<${CommentCard} key=${c.fingerprint || 'lgtm-' + i} comment=${c} />`)}
    `}
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
    ${meta.files?.length > 0 && html`
      <div class="cr-setup-card">
        <div class="cr-setup-label">Files Reviewed (${meta.files.length})</div>
        <div class="cr-setup-files">
          ${meta.files.map(f => html`
            <div class="cr-tile-file" key=${f} onClick=${() => onNavigate(f, '')}>${f}</div>
          `)}
        </div>
      </div>
    `}
    ${meta.runId && html`
      <div class="cr-setup-card">
        <div class="cr-setup-label">Run ID</div>
        <div class="cr-setup-value" style="font-family:monospace;font-size:11px;color:#8b949e">${meta.runId}</div>
      </div>
    `}
    ${meta.agentPrompt && html`
      <div class="cr-setup-card">
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
  const [activeTab, setActiveTab] = useState(initialTab || 'files');
  const pr = useMemo(
    () => review ? { owner: review.owner, repo: review.repo, prNumber: review.prNumber } : null,
    [review?.owner, review?.repo, review?.prNumber]
  );
  const actionableCount = useMemo(
    () => (review?.comments || []).filter(c => c.severity !== 'none').length,
    [review?.comments]
  );

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
        ${['files', 'feedback', 'setup'].map(tab => html`
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
          <${ErrorBoundary} label="Feedback"><${CommentsPanel} review=${review} /><//>
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
