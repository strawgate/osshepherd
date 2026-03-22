// @ts-check
/**
 * ReviewStore — persists CodeRabbit review data to chrome.storage.local.
 *
 * Pure functions (createRecord, applyEvent, storageKey) have zero side-effects
 * and no Chrome API usage — they are safe to require() in Node.js tests.
 *
 * Storage functions (save, load, loadAll, prune) accept an optional `storage`
 * argument so tests can inject a fake backend without touching Chrome APIs.
 */

/**
 * @typedef {'pending'|'reviewing'|'complete'|'error'} ReviewStatus
 *
 * @typedef {Object} ReviewComment
 * @property {string|null} filename
 * @property {number|null} startLine
 * @property {number|null} endLine
 * @property {string} severity
 * @property {string|null} comment
 * @property {string|null} codegenInstructions
 * @property {string} type
 * @property {string|null} fingerprint
 *
 * @typedef {Object} ReviewRecord
 * @property {string}  key          - Storage key (`reviews:owner/repo/prNumber`)
 * @property {string}  owner
 * @property {string}  repo
 * @property {string}  prNumber
 * @property {string}  reviewId
 * @property {ReviewStatus} status
 * @property {number}  startedAt
 * @property {number|null} completedAt
 * @property {string|null} prTitle
 * @property {boolean|null} isPaidUser
 * @property {string|null} reviewStatus
 * @property {string|null} summary
 * @property {Object.<string,string>} fileSummaries
 * @property {ReviewComment[]} comments
 * @property {Object[]} rawEvents
 */

const INDEX_KEY = 'reviews:index';
const MAX_REVIEWS = 50;
const MAX_RAW_EVENTS = 200;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function storageKey(owner, repo, prNumber) {
  return `reviews:${owner}/${repo}/${prNumber}`;
}

function createRecord(owner, repo, prNumber, reviewId) {
  return {
    key: storageKey(owner, repo, prNumber),
    owner,
    repo,
    prNumber: String(prNumber),
    reviewId,
    status: 'pending',      // pending | reviewing | complete | error
    startedAt: Date.now(),
    completedAt: null,
    prTitle: null,
    isPaidUser: null,
    reviewStatus: null,     // last raw reviewStatus string from the server
    summary: null,
    fileSummaries: {},
    comments: [],
    rawEvents: [],
  };
}

/**
 * Pure reducer. Returns a new record with the event applied.
 * Never mutates the input record.
 */
function applyEvent(record, event) {
  const r = Object.assign({}, record, {
    fileSummaries: Object.assign({}, record.fileSummaries),
    comments: record.comments.slice(),
    rawEvents: record.rawEvents.slice(),
  });

  // Always append to rawEvents — FIFO trim so late events (e.g. review_completed) are never dropped
  if (r.rawEvents.length >= MAX_RAW_EVENTS) {
    r.rawEvents.shift();
  }
  r.rawEvents.push(event);

  const { type, payload } = event;

  switch (type) {
    case 'product_settings': {
      r.isPaidUser = payload?.isPaidUser ?? r.isPaidUser;
      break;
    }

    case 'review_status': {
      r.reviewStatus = payload?.reviewStatus ?? r.reviewStatus;
      if (r.status === 'pending') r.status = 'reviewing';
      break;
    }

    case 'pr_title': {
      // payload is the title string directly
      r.prTitle = typeof payload === 'string' ? payload : r.prTitle;
      break;
    }

    case 'state_update': {
      const internal = payload?.internalState;
      if (!internal) break;
      if (internal.rawSummaryMap) {
        Object.assign(r.fileSummaries, internal.rawSummaryMap);
      }
      if (internal.crReviewed && !r.completedAt) {
        r.completedAt = payload.timestamp || Date.now();
        r.status = 'complete';
      }
      break;
    }

    case 'review_comment': {
      // Streaming — CodeRabbit sends the same comment repeatedly as it refines.
      // Deduplicate by composite key (fingerprint alone is NOT unique per-comment;
      // CodeRabbit reuses fingerprints like "phantom:triton:puma" across files).
      if (payload?.filename) {
        const key = commentKey(payload);
        const alreadyPresent = r.comments.some(c => commentKey(c) === key);
        if (!alreadyPresent) {
          r.comments.push(normalizeComment(payload, 'assertive'));
        }
      }
      break;
    }

    case 'additional_details': {
      // additional_details is supplementary — it does NOT replace streaming review_comments.
      // Contains assertiveComments (nitpicks) and additionalComments (LGTM, context).
      const assertMap = payload?.assertiveComments || {};
      const addMap = payload?.additionalComments || {};
      const existingKeys = new Set(r.comments.map(c => commentKey(c)));

      for (const [, comments] of Object.entries(assertMap)) {
        for (const c of comments) {
          const k = commentKey(c);
          if (existingKeys.has(k)) continue;
          r.comments.push(normalizeComment(c, 'assertive'));
          existingKeys.add(k);
        }
      }
      for (const [, comments] of Object.entries(addMap)) {
        for (const c of comments) {
          const k = commentKey(c);
          if (existingKeys.has(k)) continue;
          r.comments.push(normalizeComment(c, 'additional'));
          existingKeys.add(k);
        }
      }
      break;
    }

    case 'review_completed': {
      r.summary = payload?.summary || r.summary;
      if (!r.completedAt) {
        r.completedAt = Date.now();
        r.status = 'complete';
      }
      break;
    }
  }

  return r;
}

/** Composite dedup key — fingerprint alone is NOT unique (CodeRabbit reuses them across files). */
function commentKey(c) {
  return `${c.fingerprint || ''}:${c.filename || ''}:${c.startLine ?? ''}`;
}

function normalizeComment(raw, defaultType) {
  return {
    filename: raw.filename || null,
    startLine: raw.startLine ?? null,   // ?? preserves 0; || would coerce it to null
    endLine: raw.endLine ?? null,
    severity: raw.severity || 'none',
    comment: raw.comment || null,
    codegenInstructions: raw.codegenInstructions || null,
    type: raw.type || defaultType,
    fingerprint: raw.fingerprint || null,
  };
}

// ---------------------------------------------------------------------------
// Storage functions (injectable backend for testing)
// ---------------------------------------------------------------------------

function chromeStorageGet(keys, storage) {
  return new Promise((resolve, reject) => {
    storage.get(keys, (result) => {
      if (typeof chrome !== 'undefined' && chrome.runtime?.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve(result);
      }
    });
  });
}

function chromeStorageSet(items, storage) {
  return new Promise((resolve, reject) => {
    storage.set(items, () => {
      if (typeof chrome !== 'undefined' && chrome.runtime?.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve();
      }
    });
  });
}

function chromeStorageRemove(keys, storage) {
  return new Promise((resolve, reject) => {
    storage.remove(keys, () => {
      if (typeof chrome !== 'undefined' && chrome.runtime?.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve();
      }
    });
  });
}

async function save(record, storage = chrome.storage.local) {
  const result = await chromeStorageGet([INDEX_KEY], storage);
  let index = result[INDEX_KEY] || [];

  // Insert at front if new, otherwise keep position
  if (!index.includes(record.key)) {
    index = [record.key, ...index];
  }

  await chromeStorageSet({ [record.key]: record, [INDEX_KEY]: index }, storage);

  // Auto-prune oldest reviews if over the limit
  if (index.length > MAX_REVIEWS) {
    await prune(MAX_REVIEWS, storage);
  }
}

async function load(owner, repo, prNumber, storage = chrome.storage.local) {
  const key = storageKey(owner, repo, prNumber);
  const result = await chromeStorageGet([key], storage);
  return result[key] || null;
}

async function loadAll(storage = chrome.storage.local) {
  const idxResult = await chromeStorageGet([INDEX_KEY], storage);
  const index = idxResult[INDEX_KEY] || [];
  if (!index.length) return [];

  const result = await chromeStorageGet(index, storage);
  return index.map(k => result[k]).filter(Boolean);
}

async function prune(max = MAX_REVIEWS, storage = chrome.storage.local) {
  const idxResult = await chromeStorageGet([INDEX_KEY], storage);
  const index = idxResult[INDEX_KEY] || [];
  if (index.length <= max) return;

  const toRemove = index.slice(max);
  const newIndex = index.slice(0, max);
  await chromeStorageRemove(toRemove, storage);
  await chromeStorageSet({ [INDEX_KEY]: newIndex }, storage);
}

async function remove(owner, repo, prNumber, storage = chrome.storage.local) {
  const key = storageKey(owner, repo, prNumber);
  const idxResult = await chromeStorageGet([INDEX_KEY], storage);
  const index = (idxResult[INDEX_KEY] || []).filter(k => k !== key);
  await chromeStorageRemove([key], storage);
  await chromeStorageSet({ [INDEX_KEY]: index }, storage);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const ReviewStore = {
  storageKey,
  createRecord,
  applyEvent,
  save,
  load,
  loadAll,
  prune,
  remove,
};

if (typeof module !== 'undefined') {
  module.exports = ReviewStore;
} else {
  globalThis.ReviewStore = ReviewStore;
}
