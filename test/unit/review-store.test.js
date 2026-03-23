const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const ReviewStore = require('../../src/utils/review-store');

// ---------------------------------------------------------------------------
// Fake chrome.storage.local backend (Map-backed, synchronous callbacks)
// ---------------------------------------------------------------------------

function makeFakeStorage() {
  const data = new Map();
  return {
    _data: data,
    get(keys, cb) {
      const result = {};
      const keyList = Array.isArray(keys) ? keys : [keys];
      for (const k of keyList) {
        if (data.has(k)) result[k] = JSON.parse(JSON.stringify(data.get(k)));
      }
      cb(result);
    },
    set(items, cb) {
      for (const [k, v] of Object.entries(items)) {
        data.set(k, JSON.parse(JSON.stringify(v)));
      }
      cb();
    },
    remove(keys, cb) {
      const keyList = Array.isArray(keys) ? keys : [keys];
      for (const k of keyList) data.delete(k);
      cb();
    },
  };
}

// ---------------------------------------------------------------------------
// Pure function tests — no storage involved
// ---------------------------------------------------------------------------

describe('storageKey', () => {
  it('formats the key correctly', () => {
    assert.equal(ReviewStore.storageKey('owner', 'repo', '123'), 'reviews:owner/repo/123');
  });

  it('coerces prNumber to string', () => {
    assert.equal(ReviewStore.storageKey('a', 'b', 42), 'reviews:a/b/42');
  });
});

describe('createRecord', () => {
  it('sets status to pending', () => {
    const r = ReviewStore.createRecord('owner', 'repo', '1', 'uuid-1');
    assert.equal(r.status, 'pending');
  });

  it('initializes empty arrays', () => {
    const r = ReviewStore.createRecord('owner', 'repo', '1', 'uuid-1');
    assert.deepEqual(r.comments, []);
    assert.deepEqual(r.rawEvents, []);
  });

  it('initializes empty fileSummaries', () => {
    const r = ReviewStore.createRecord('owner', 'repo', '1', 'uuid-1');
    assert.deepEqual(r.fileSummaries, {});
  });

  it('sets the correct storage key', () => {
    const r = ReviewStore.createRecord('acme', 'widget', '99', 'uuid');
    assert.equal(r.key, 'reviews:acme/widget/99');
  });

  it('sets reviewId', () => {
    const r = ReviewStore.createRecord('o', 'r', '1', 'my-review-id');
    assert.equal(r.reviewId, 'my-review-id');
  });

  it('sets startedAt close to now', () => {
    const before = Date.now();
    const r = ReviewStore.createRecord('o', 'r', '1', 'id');
    assert.ok(r.startedAt >= before);
    assert.ok(r.startedAt <= Date.now());
  });

  it('leaves completedAt null', () => {
    const r = ReviewStore.createRecord('o', 'r', '1', 'id');
    assert.equal(r.completedAt, null);
  });
});

describe('applyEvent — product_settings', () => {
  it('sets isPaidUser', () => {
    const r = ReviewStore.createRecord('o', 'r', '1', 'id');
    const r2 = ReviewStore.applyEvent(r, { type: 'product_settings', payload: { isPaidUser: true } });
    assert.equal(r2.isPaidUser, true);
  });

  it('does not mutate the input record', () => {
    const r = ReviewStore.createRecord('o', 'r', '1', 'id');
    ReviewStore.applyEvent(r, { type: 'product_settings', payload: { isPaidUser: true } });
    assert.equal(r.isPaidUser, null);
  });
});

describe('applyEvent — review_status', () => {
  it('sets reviewStatus', () => {
    const r = ReviewStore.createRecord('o', 'r', '1', 'id');
    const r2 = ReviewStore.applyEvent(r, { type: 'review_status', payload: { reviewStatus: 'summarizing', timestamp: 1000 } });
    assert.equal(r2.reviewStatus, 'summarizing');
  });

  it('transitions status from pending to reviewing', () => {
    const r = ReviewStore.createRecord('o', 'r', '1', 'id');
    const r2 = ReviewStore.applyEvent(r, { type: 'review_status', payload: { reviewStatus: 'setting_up', timestamp: 1000 } });
    assert.equal(r2.status, 'reviewing');
  });

  it('does not overwrite status if already complete', () => {
    let r = ReviewStore.createRecord('o', 'r', '1', 'id');
    r = ReviewStore.applyEvent(r, { type: 'review_completed', payload: { summary: 'done' } });
    assert.equal(r.status, 'complete');
    r = ReviewStore.applyEvent(r, { type: 'review_status', payload: { reviewStatus: 'reviewing', timestamp: 2000 } });
    // status stays complete (review_status only transitions from pending)
    assert.equal(r.status, 'complete');
  });
});

describe('applyEvent — pr_title', () => {
  it('sets prTitle', () => {
    const r = ReviewStore.createRecord('o', 'r', '1', 'id');
    const r2 = ReviewStore.applyEvent(r, { type: 'pr_title', payload: 'My PR Title' });
    assert.equal(r2.prTitle, 'My PR Title');
  });

  it('ignores non-string payload', () => {
    const r = ReviewStore.createRecord('o', 'r', '1', 'id');
    const r2 = ReviewStore.applyEvent(r, { type: 'pr_title', payload: { oops: true } });
    assert.equal(r2.prTitle, null);
  });
});

describe('applyEvent — state_update', () => {
  it('merges rawSummaryMap into fileSummaries', () => {
    const r = ReviewStore.createRecord('o', 'r', '1', 'id');
    const r2 = ReviewStore.applyEvent(r, {
      type: 'state_update',
      payload: {
        internalState: { rawSummaryMap: { 'foo.go': 'summary A' }, crReviewed: false },
        timestamp: 1000,
      },
    });
    assert.equal(r2.fileSummaries['foo.go'], 'summary A');
  });

  it('accumulates across multiple state_update events', () => {
    let r = ReviewStore.createRecord('o', 'r', '1', 'id');
    r = ReviewStore.applyEvent(r, {
      type: 'state_update',
      payload: { internalState: { rawSummaryMap: { 'a.go': 'A' }, crReviewed: false }, timestamp: 1000 },
    });
    r = ReviewStore.applyEvent(r, {
      type: 'state_update',
      payload: { internalState: { rawSummaryMap: { 'b.go': 'B' }, crReviewed: false }, timestamp: 2000 },
    });
    assert.equal(r.fileSummaries['a.go'], 'A');
    assert.equal(r.fileSummaries['b.go'], 'B');
  });

  it('marks complete and sets completedAt when crReviewed is true', () => {
    const r = ReviewStore.createRecord('o', 'r', '1', 'id');
    const r2 = ReviewStore.applyEvent(r, {
      type: 'state_update',
      payload: { internalState: { rawSummaryMap: {}, crReviewed: true }, timestamp: 9999 },
    });
    assert.equal(r2.status, 'complete');
    assert.equal(r2.completedAt, 9999);
  });

  it('does not overwrite completedAt if already set', () => {
    let r = ReviewStore.createRecord('o', 'r', '1', 'id');
    r = ReviewStore.applyEvent(r, {
      type: 'state_update',
      payload: { internalState: { rawSummaryMap: {}, crReviewed: true }, timestamp: 1111 },
    });
    r = ReviewStore.applyEvent(r, {
      type: 'state_update',
      payload: { internalState: { rawSummaryMap: {}, crReviewed: true }, timestamp: 2222 },
    });
    assert.equal(r.completedAt, 1111);
  });
});

describe('applyEvent — review_comment', () => {
  function makeComment(overrides = {}) {
    return {
      filename: 'foo.go',
      startLine: 10,
      endLine: 12,
      severity: 'medium',
      comment: 'Something is off here.',
      codegenInstructions: 'Fix it like this.',
      fingerprint: 'aaa:bbb:ccc',
      ...overrides,
    };
  }

  it('appends a comment to comments array', () => {
    const r = ReviewStore.createRecord('o', 'r', '1', 'id');
    const r2 = ReviewStore.applyEvent(r, { type: 'review_comment', payload: makeComment() });
    assert.equal(r2.comments.length, 1);
    assert.equal(r2.comments[0].filename, 'foo.go');
  });

  it('deduplicates by fingerprint', () => {
    let r = ReviewStore.createRecord('o', 'r', '1', 'id');
    r = ReviewStore.applyEvent(r, { type: 'review_comment', payload: makeComment({ fingerprint: 'fp-1' }) });
    r = ReviewStore.applyEvent(r, { type: 'review_comment', payload: makeComment({ fingerprint: 'fp-1' }) });
    assert.equal(r.comments.length, 1);
  });

  it('allows multiple comments with different fingerprints', () => {
    let r = ReviewStore.createRecord('o', 'r', '1', 'id');
    r = ReviewStore.applyEvent(r, { type: 'review_comment', payload: makeComment({ fingerprint: 'fp-1' }) });
    r = ReviewStore.applyEvent(r, { type: 'review_comment', payload: makeComment({ fingerprint: 'fp-2', filename: 'bar.go' }) });
    assert.equal(r.comments.length, 2);
  });

  it('ignores comments without a filename', () => {
    const r = ReviewStore.createRecord('o', 'r', '1', 'id');
    const r2 = ReviewStore.applyEvent(r, { type: 'review_comment', payload: { severity: 'none' } });
    assert.equal(r2.comments.length, 0);
  });
});

describe('applyEvent — additional_details', () => {
  it('appends additional_details to streaming comments (does not replace)', () => {
    let r = ReviewStore.createRecord('o', 'r', '1', 'id');
    // First add a streaming actionable comment
    r = ReviewStore.applyEvent(r, {
      type: 'review_comment',
      payload: { filename: 'a.go', startLine: 1, endLine: 1, severity: 'minor', fingerprint: 'actionable-1' },
    });
    assert.equal(r.comments.length, 1);

    // Now receive additional_details — should append, not replace
    r = ReviewStore.applyEvent(r, {
      type: 'additional_details',
      payload: {
        additionalComments: {
          'b.go': [
            { filename: 'b.go', startLine: 5, severity: 'none', comment: 'LGTM', fingerprint: 'lgtm-1' },
          ],
        },
        assertiveComments: {
          'c.go': [
            { filename: 'c.go', startLine: 10, severity: 'none', comment: 'Nitpick', fingerprint: 'nitpick-1' },
          ],
        },
      },
    });
    // Streaming comment preserved + 2 from additional_details
    assert.equal(r.comments.length, 3);
    assert.equal(r.comments[0].filename, 'a.go');  // original streaming comment kept
    assert.equal(r.comments[0].severity, 'minor');
  });

  it('deduplicates additional_details by fingerprint', () => {
    let r = ReviewStore.createRecord('o', 'r', '1', 'id');
    r = ReviewStore.applyEvent(r, {
      type: 'review_comment',
      payload: { filename: 'a.go', startLine: 1, severity: 'major', fingerprint: 'shared-fp' },
    });
    // additional_details has the same fingerprint — should not duplicate
    r = ReviewStore.applyEvent(r, {
      type: 'additional_details',
      payload: {
        additionalComments: {
          'a.go': [{ filename: 'a.go', startLine: 1, severity: 'major', fingerprint: 'shared-fp' }],
        },
        assertiveComments: {},
      },
    });
    assert.equal(r.comments.length, 1);
  });

  it('allows same fingerprint on different files (CodeRabbit reuses fingerprints)', () => {
    let r = ReviewStore.createRecord('o', 'r', '1', 'id');
    r = ReviewStore.applyEvent(r, {
      type: 'additional_details',
      payload: {
        additionalComments: {
          'a.go': [{ filename: 'a.go', startLine: 1, severity: 'none', fingerprint: 'phantom:triton:puma' }],
          'b.go': [{ filename: 'b.go', startLine: 5, severity: 'none', fingerprint: 'phantom:triton:puma' }],
          'c.go': [{ filename: 'c.go', startLine: 10, severity: 'minor', fingerprint: 'phantom:triton:puma' }],
        },
        assertiveComments: {},
      },
    });
    assert.equal(r.comments.length, 3, 'same fingerprint but different files should all be kept');
  });

  it('merges assertive and additional comments', () => {
    const r = ReviewStore.createRecord('o', 'r', '1', 'id');
    const r2 = ReviewStore.applyEvent(r, {
      type: 'additional_details',
      payload: {
        assertiveComments: {
          'a.go': [{ filename: 'a.go', startLine: 1, endLine: 1, severity: 'high', comment: 'Bug!', fingerprint: 'a1' }],
        },
        additionalComments: {
          'b.go': [{ filename: 'b.go', startLine: 2, endLine: 2, severity: 'none', comment: 'LGTM', fingerprint: 'b1' }],
        },
        counts: { assertive: 1, additional: 1 },
      },
    });
    assert.equal(r2.comments.length, 2);
    const assertive = r2.comments.find(c => c.type === 'assertive');
    const additional = r2.comments.find(c => c.type === 'additional');
    assert.ok(assertive, 'should have an assertive comment');
    assert.ok(additional, 'should have an additional comment');
  });
});

describe('applyEvent — review_completed', () => {
  it('sets summary', () => {
    const r = ReviewStore.createRecord('o', 'r', '1', 'id');
    const r2 = ReviewStore.applyEvent(r, { type: 'review_completed', payload: { summary: 'All good.' } });
    assert.equal(r2.summary, 'All good.');
  });

  it('sets status to complete', () => {
    const r = ReviewStore.createRecord('o', 'r', '1', 'id');
    const r2 = ReviewStore.applyEvent(r, { type: 'review_completed', payload: { summary: '' } });
    assert.equal(r2.status, 'complete');
  });

  it('sets completedAt if not already set', () => {
    const before = Date.now();
    const r = ReviewStore.createRecord('o', 'r', '1', 'id');
    const r2 = ReviewStore.applyEvent(r, { type: 'review_completed', payload: { summary: '' } });
    assert.ok(r2.completedAt >= before);
  });
});

describe('applyEvent — unknown event type', () => {
  it('appends to rawEvents and does not throw', () => {
    const r = ReviewStore.createRecord('o', 'r', '1', 'id');
    const r2 = ReviewStore.applyEvent(r, { type: 'something_new', payload: { data: 42 } });
    assert.equal(r2.rawEvents.length, 1);
    assert.equal(r2.rawEvents[0].type, 'something_new');
  });
});

describe('applyEvent — rawEvents cap', () => {
  it('stops appending rawEvents after 200', () => {
    let r = ReviewStore.createRecord('o', 'r', '1', 'id');
    for (let i = 0; i < 210; i++) {
      r = ReviewStore.applyEvent(r, { type: 'unknown_x', payload: { i } });
    }
    assert.equal(r.rawEvents.length, 200);
  });
});

// ---------------------------------------------------------------------------
// Storage function tests (fake backend)
// ---------------------------------------------------------------------------

describe('save and load', () => {
  it('saves a record and loads it back', async () => {
    const storage = makeFakeStorage();
    const record = ReviewStore.createRecord('owner', 'repo', '42', 'rev-id');
    await ReviewStore.save(record, storage);
    const loaded = await ReviewStore.load('owner', 'repo', '42', storage);
    assert.equal(loaded.reviewId, 'rev-id');
    assert.equal(loaded.status, 'pending');
  });

  it('returns null for unknown review', async () => {
    const storage = makeFakeStorage();
    const result = await ReviewStore.load('nobody', 'nothing', '0', storage);
    assert.equal(result, null);
  });

  it('updates an existing record (save twice, same key)', async () => {
    const storage = makeFakeStorage();
    let record = ReviewStore.createRecord('o', 'r', '1', 'id');
    await ReviewStore.save(record, storage);
    record = ReviewStore.applyEvent(record, { type: 'pr_title', payload: 'New Title' });
    await ReviewStore.save(record, storage);

    const loaded = await ReviewStore.load('o', 'r', '1', storage);
    assert.equal(loaded.prTitle, 'New Title');

    // Index should only have one entry for this key
    const idx = storage._data.get('reviews:index');
    assert.equal(idx.filter(k => k === 'reviews:o/r/1').length, 1);
  });
});

describe('loadAll', () => {
  it('returns empty array when no reviews', async () => {
    const storage = makeFakeStorage();
    const all = await ReviewStore.loadAll(storage);
    assert.deepEqual(all, []);
  });

  it('returns all saved reviews, newest first', async () => {
    const storage = makeFakeStorage();
    const r1 = ReviewStore.createRecord('o', 'r', '1', 'id1');
    const r2 = ReviewStore.createRecord('o', 'r', '2', 'id2');
    await ReviewStore.save(r1, storage);
    await ReviewStore.save(r2, storage);

    const all = await ReviewStore.loadAll(storage);
    assert.equal(all.length, 2);
    // r2 saved last → at front of index
    assert.equal(all[0].reviewId, 'id2');
    assert.equal(all[1].reviewId, 'id1');
  });
});

describe('prune', () => {
  it('removes oldest entries beyond max', async () => {
    const storage = makeFakeStorage();
    for (let i = 0; i < 5; i++) {
      const r = ReviewStore.createRecord('o', 'r', String(i), `id-${i}`);
      await ReviewStore.save(r, storage);
    }
    await ReviewStore.prune(3, storage);

    const all = await ReviewStore.loadAll(storage);
    assert.equal(all.length, 3);
    // Newest 3 remain
    assert.ok(all.some(r => r.reviewId === 'id-4'));
    assert.ok(all.some(r => r.reviewId === 'id-3'));
    assert.ok(all.some(r => r.reviewId === 'id-2'));
  });

  it('does nothing when under max', async () => {
    const storage = makeFakeStorage();
    await ReviewStore.save(ReviewStore.createRecord('o', 'r', '1', 'id'), storage);
    await ReviewStore.prune(50, storage);
    const all = await ReviewStore.loadAll(storage);
    assert.equal(all.length, 1);
  });
});

describe('remove', () => {
  it('removes a record and its index entry', async () => {
    const storage = makeFakeStorage();
    const r = ReviewStore.createRecord('o', 'r', '1', 'id');
    await ReviewStore.save(r, storage);
    await ReviewStore.remove('o', 'r', '1', storage);

    const loaded = await ReviewStore.load('o', 'r', '1', storage);
    assert.equal(loaded, null);

    const all = await ReviewStore.loadAll(storage);
    assert.equal(all.length, 0);
  });
});

describe('save-then-load consistency (race condition guard)', () => {
  it('a load immediately after save returns the saved data', async () => {
    const storage = makeFakeStorage();
    let record = ReviewStore.createRecord('o', 'r', '1', 'id');
    record = ReviewStore.applyEvent(record, { type: 'pr_title', payload: 'My PR' });
    record = ReviewStore.applyEvent(record, { type: 'product_settings', payload: { isPaidUser: true } });

    // Simulate saveAndForward: save completes, THEN the consumer reads
    await ReviewStore.save(record, storage);
    const loaded = await ReviewStore.load('o', 'r', '1', storage);

    assert.equal(loaded.prTitle, 'My PR');
    assert.equal(loaded.isPaidUser, true);
    assert.equal(loaded.rawEvents.length, 2);
  });

  it('rapid sequential saves preserve the latest state', async () => {
    const storage = makeFakeStorage();
    let record = ReviewStore.createRecord('o', 'r', '1', 'id');

    // Simulate multiple events arriving and being saved sequentially
    for (let i = 0; i < 5; i++) {
      record = ReviewStore.applyEvent(record, { type: 'unknown_x', payload: { i } });
      await ReviewStore.save(record, storage);
    }

    const loaded = await ReviewStore.load('o', 'r', '1', storage);
    assert.equal(loaded.rawEvents.length, 5);
    assert.equal(loaded.rawEvents[4].payload.i, 4);
  });
});
