document.getElementById('optionsBtn').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Escape HTML special characters for safe insertion into innerHTML. */
function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Severity counts from a review's comments array. */
function severityCounts(review) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, trivial: 0, lgtm: 0 };
  for (const c of review.comments || []) {
    const s = (c.severity || 'none').toLowerCase();
    if (s === 'critical') counts.critical++;
    else if (s === 'high' || s === 'major') counts.high++;
    else if (s === 'medium' || s === 'minor') counts.medium++;
    else if (s === 'low') counts.low++;
    else if (s === 'trivial') counts.trivial++;
    else counts.lgtm++;
  }
  return counts;
}

/** Total actionable (non-LGTM) comments. */
function actionableCount(counts) {
  return counts.critical + counts.high + counts.medium + counts.low;
}

function statusLabel(review) {
  if (review.status === 'complete') return 'Complete';
  if (review.status === 'reviewing') return review.reviewStatus || 'Reviewing…';
  if (review.status === 'error') return 'Error';
  return 'Pending';
}

function dotClass(status) {
  return { complete: 'dot-complete', reviewing: 'dot-reviewing', pending: 'dot-pending', error: 'dot-error' }[status] || 'dot-pending';
}

// ── Stale detection (best-effort, cached, non-blocking) ─────────────────────

const staleCache = new Map(); // key → { stale: bool, ts: number }
const STALE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function checkStale(review) {
  if (review.status !== 'complete' || !review.completedAt) return false;
  const key = `${review.owner}/${review.repo}/${review.prNumber}`;
  const cached = staleCache.get(key);
  if (cached && Date.now() - cached.ts < STALE_CACHE_TTL) return cached.stale;
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${review.owner}/${review.repo}/pulls/${review.prNumber}/commits`,
      { headers: { Accept: 'application/vnd.github.v3+json' } }
    );
    if (!resp.ok) return false;
    const commits = await resp.json();
    if (!commits.length) return false;
    const last = new Date(commits[commits.length - 1].commit.committer.date).getTime();
    const stale = last > review.completedAt;
    staleCache.set(key, { stale, ts: Date.now() });
    return stale;
  } catch { return false; }
}

// ── Render ───────────────────────────────────────────────────────────────────

let currentRenderId = 0; // Incremented per render — stale checks from old renders are ignored

function render(reviews) {
  const renderId = ++currentRenderId;
  const list = document.getElementById('reviewsList');
  const summaryBar = document.getElementById('summaryBar');
  const headerCount = document.getElementById('headerCount');

  if (!reviews.length) {
    summaryBar.style.display = 'none';
    headerCount.style.display = 'none';
    list.innerHTML = `
      <div class="empty">
        <span class="empty-icon">🐑</span>
        <span>No reviews yet.</span>
        <span class="empty-hint">Navigate to a GitHub PR and click<br>the OSShepherd button to start a review.</span>
      </div>`;
    return;
  }

  // Global stats
  let totalCritical = 0, totalWarnings = 0, totalClean = 0;
  const reviewData = reviews.map(r => {
    const counts = severityCounts(r);
    const ac = actionableCount(counts);
    if (counts.critical + counts.high > 0) totalCritical++;
    else if (ac > 0) totalWarnings++;
    else if (r.status === 'complete') totalClean++;
    return { review: r, counts, actionable: ac, stale: false };
  });

  // Header count
  headerCount.textContent = reviews.length;
  headerCount.style.display = '';

  // Summary bar
  const stats = [];
  if (totalCritical) stats.push(`<span class="summary-stat critical"><span class="num">${totalCritical}</span> need attention</span>`);
  if (totalWarnings) stats.push(`<span class="summary-stat warnings"><span class="num">${totalWarnings}</span> with findings</span>`);
  if (totalClean) stats.push(`<span class="summary-stat clean"><span class="num">${totalClean}</span> clean</span>`);
  if (stats.length) {
    summaryBar.innerHTML = stats.join('');
    summaryBar.style.display = 'flex';
  } else {
    summaryBar.style.display = 'none';
  }

  // Group by repo
  const groups = new Map();
  for (const rd of reviewData) {
    const key = `${rd.review.owner}/${rd.review.repo}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rd);
  }

  // Sort: repos with critical findings first, then by most recent review
  const sortedGroups = [...groups.entries()].sort((a, b) => {
    const aCrit = a[1].some(d => d.counts.critical + d.counts.high > 0) ? 0 : 1;
    const bCrit = b[1].some(d => d.counts.critical + d.counts.high > 0) ? 0 : 1;
    if (aCrit !== bCrit) return aCrit - bCrit;
    const aTime = Math.max(...a[1].map(d => d.review.completedAt || d.review.startedAt || 0));
    const bTime = Math.max(...b[1].map(d => d.review.completedAt || d.review.startedAt || 0));
    return bTime - aTime;
  });

  const html = [];
  for (const [repoSlug, items] of sortedGroups) {
    // Sort PRs within group: in-progress first, then by severity, then by time
    items.sort((a, b) => {
      const aActive = a.review.status === 'reviewing' || a.review.status === 'pending' ? 0 : 1;
      const bActive = b.review.status === 'reviewing' || b.review.status === 'pending' ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      const aSev = a.counts.critical * 100 + a.counts.high * 10 + a.counts.medium;
      const bSev = b.counts.critical * 100 + b.counts.high * 10 + b.counts.medium;
      if (bSev !== aSev) return bSev - aSev;
      return (b.review.completedAt || 0) - (a.review.completedAt || 0);
    });

    html.push(`<div class="repo-group" data-repo="${esc(repoSlug)}">
      <div class="repo-header"><span class="repo-chevron">▼</span> ${esc(repoSlug)}</div>
      <div class="repo-cards">`);

    for (const { review: r, counts, actionable: ac } of items) {
      const title = r.prTitle || `PR #${r.prNumber}`;
      const ts = r.completedAt || r.startedAt;
      const age = ts ? formatRelativeTime(ts) : '';
      const status = statusLabel(r);
      const commentText = ac > 0 ? `${ac} comment${ac !== 1 ? 's' : ''}` : (r.status === 'complete' ? 'All clear' : '');

      // Meta line: dot + status + comments + age
      const metaParts = [status, commentText, age].filter(Boolean);

      // Severity pills
      const pills = [];
      if (counts.critical) pills.push(`<span class="sev-pill sev-critical">${counts.critical} critical</span>`);
      if (counts.high) pills.push(`<span class="sev-pill sev-high">${counts.high} high</span>`);
      if (counts.medium) pills.push(`<span class="sev-pill sev-medium">${counts.medium} medium</span>`);
      if (counts.low) pills.push(`<span class="sev-pill sev-low">${counts.low} low</span>`);
      if (ac === 0 && r.status === 'complete') pills.push(`<span class="sev-pill sev-lgtm">LGTM</span>`);

      html.push(`
        <div class="pr-card" data-owner="${esc(r.owner)}" data-repo="${esc(r.repo)}" data-pr="${esc(r.prNumber)}">
          <div class="pr-card-top">
            <div class="pr-title"><span class="pr-number">#${esc(r.prNumber)}</span> ${esc(title)}</div>
            <span class="pr-stale-badge" data-stale-key="${esc(r.owner)}/${esc(r.repo)}/${esc(r.prNumber)}" style="display:none">outdated</span>
          </div>
          <div class="pr-card-meta">
            <span class="pr-status-dot ${dotClass(r.status)}"></span>
            ${metaParts.map(p => esc(p)).join(`<span class="pr-sep">·</span>`)}
          </div>
          ${pills.length ? `<div class="pr-card-severity">${pills.join('')}</div>` : ''}
        </div>`);
    }
    html.push('</div></div>');
  }

  list.innerHTML = html.join('');

  // ── Wire interactions ────────────────────────────────────────────────────

  // Card click → navigate to PR
  list.querySelectorAll('.pr-card').forEach(card => {
    card.addEventListener('click', async () => {
      const { owner, repo, pr } = card.dataset;
      const prUrl = `https://github.com/${owner}/${repo}/pull/${pr}`;
      const tabs = await chrome.tabs.query({ url: `https://github.com/${owner}/${repo}/pull/${pr}*` });
      if (tabs.length) {
        try {
          await chrome.tabs.update(tabs[0].id, { active: true });
          await chrome.windows.update(tabs[0].windowId, { focused: true });
        } catch {
          await chrome.tabs.create({ url: prUrl });
        }
      } else {
        await chrome.tabs.create({ url: prUrl });
      }
      window.close();
    });
  });

  // Repo header click → collapse/expand
  list.querySelectorAll('.repo-header').forEach(header => {
    header.addEventListener('click', () => {
      header.parentElement.classList.toggle('collapsed');
    });
  });

  // Async stale checks — scoped to this render pass via renderId
  let staleCount = 0;
  for (const rd of reviewData) {
    if (rd.review.status !== 'complete') continue;
    checkStale(rd.review).then(stale => {
      if (!stale || renderId !== currentRenderId) return; // ignore if a newer render happened
      rd.stale = true;
      const key = `${rd.review.owner}/${rd.review.repo}/${rd.review.prNumber}`;
      const badge = list.querySelector(`[data-stale-key="${CSS.escape(key)}"]`);
      if (badge) badge.style.display = '';
      staleCount++;
      const existingStale = summaryBar.querySelector('.summary-stat.stale');
      if (existingStale) {
        existingStale.querySelector('.num').textContent = staleCount;
      } else {
        summaryBar.insertAdjacentHTML('beforeend',
          `<span class="summary-stat stale"><span class="num">${staleCount}</span> outdated</span>`);
        summaryBar.style.display = 'flex';
      }
    });
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────

ReviewStore.loadAll().then(render);

// Live updates while popup is open
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (Object.keys(changes).some(k => k.startsWith('reviews:'))) {
    ReviewStore.loadAll().then(render);
  }
});
