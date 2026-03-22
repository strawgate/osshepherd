const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Inject fake WebSocket so the module's wsFactory default is overridable
global.window = undefined;  // force module.exports path
const CodeRabbitClient = require('../../utils/trpc-client');

// ---------------------------------------------------------------------------
// Fake WebSocket — records sent frames, lets tests drive server responses
// ---------------------------------------------------------------------------

class FakeWS {
  constructor() {
    this.sent = [];
    this.readyState = 1; // OPEN
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
  }

  send(data) {
    this.sent.push(data);
  }

  // Test helpers — simulate server messages
  receive(obj) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) });
  }

  open() {
    if (this.onopen) this.onopen();
  }

  close(code = 1000, reason = '') {
    if (this.onclose) this.onclose({ code, reason });
  }

  error(err) {
    if (this.onerror) this.onerror(err);
  }
}

// authTimeout: 0 makes the auth promise resolve synchronously after open,
// so tests don't need artificial delays.
function makeClient(ws) {
  return new CodeRabbitClient('test-token', { wsFactory: () => ws, authTimeout: 0 });
}

// ---------------------------------------------------------------------------
// connect()
// ---------------------------------------------------------------------------

describe('connect — happy path', () => {
  it('sends connectionParams immediately after open', async () => {
    const ws = new FakeWS();
    const client = makeClient(ws);

    const connectP = client.connect(null);
    ws.open();
    await connectP;

    assert.equal(ws.sent.length, 1);
    const msg = JSON.parse(ws.sent[0]);
    assert.equal(msg.method, 'connectionParams');
    assert.ok(msg.data.accessToken);
  });

  it('includes organizationId in connectionParams when provided', async () => {
    const ws = new FakeWS();
    const client = makeClient(ws);
    const connectP = client.connect('org-123');
    ws.open();
    await connectP;

    const msg = JSON.parse(ws.sent[0]);
    assert.equal(msg.data.organizationId, 'org-123');
  });

  it('omits organizationId when null', async () => {
    const ws = new FakeWS();
    const client = makeClient(ws);
    const connectP = client.connect(null);
    ws.open();
    await connectP;

    const msg = JSON.parse(ws.sent[0]);
    assert.equal(msg.data.organizationId, undefined);
  });
});

describe('connect — rejection cases', () => {
  it('rejects if socket closes before auth completes', async () => {
    const ws = new FakeWS();
    const client = makeClient(ws);
    const connectP = client.connect(null);
    ws.open();
    ws.close(1006);
    await assert.rejects(connectP, /closed before auth/i);
  });

  it('rejects on connection_error message from server', async () => {
    const ws = new FakeWS();
    const client = makeClient(ws);
    const connectP = client.connect(null);
    ws.open();
    ws.receive({ type: 'connection_error', payload: { message: 'Invalid token' } });
    await assert.rejects(connectP, /invalid token/i);
  });
});

describe('connect — resolver drain on close', () => {
  it('rejects pending sendRequest resolvers when socket closes', async () => {
    const ws = new FakeWS();
    const client = makeClient(ws);
    const connectP = client.connect(null);
    ws.open();
    await connectP;

    // Start a request that will never get a response
    const reqP = client.sendRequest('some.method', {});
    ws.close(1001);

    await assert.rejects(reqP, /WebSocket closed/i);
  });
});

// ---------------------------------------------------------------------------
// subscribeAndMutate()
// ---------------------------------------------------------------------------

describe('subscribeAndMutate', () => {
  async function connectedClient() {
    const ws = new FakeWS();
    const client = makeClient(ws);
    const connectP = client.connect(null);
    ws.open();
    await connectP;
    ws.sent.length = 0; // clear connectionParams frame
    return { client, ws };
  }

  it('sends a single JSON array frame with [subscription, mutation]', async () => {
    const { client, ws } = await connectedClient();

    client.subscribeAndMutate(
      'vsCode.subscribeToEvents', { clientId: 'c1' },
      'vsCode.requestFullReview', { extensionEvent: {} },
      () => {}, () => {}, () => {}
    );

    assert.equal(ws.sent.length, 1);
    const frame = JSON.parse(ws.sent[0]);
    assert.ok(Array.isArray(frame), 'frame should be an array');
    assert.equal(frame.length, 2);
  });

  it('first element is the subscription, second is the mutation', async () => {
    const { client, ws } = await connectedClient();

    client.subscribeAndMutate(
      'vsCode.subscribeToEvents', { clientId: 'c1' },
      'vsCode.requestFullReview', { extensionEvent: {} },
      () => {}, () => {}, () => {}
    );

    const [sub, mut] = JSON.parse(ws.sent[0]);
    assert.equal(sub.method, 'subscription');
    assert.equal(sub.params.path, 'vsCode.subscribeToEvents');
    assert.equal(mut.method, 'mutation');
    assert.equal(mut.params.path, 'vsCode.requestFullReview');
  });

  it('subscription id and mutation id are distinct', async () => {
    const { client, ws } = await connectedClient();

    client.subscribeAndMutate(
      'vsCode.subscribeToEvents', {},
      'vsCode.requestFullReview', {},
      () => {}, () => {}, () => {}
    );

    const [sub, mut] = JSON.parse(ws.sent[0]);
    assert.notEqual(sub.id, mut.id);
  });

  it('returns { promise, unsubscribe }', async () => {
    const { client } = await connectedClient();

    const result = client.subscribeAndMutate(
      'vsCode.subscribeToEvents', {},
      'vsCode.requestFullReview', {},
      () => {}, () => {}, () => {}
    );

    assert.ok(result.promise instanceof Promise, 'should have a promise');
    assert.equal(typeof result.unsubscribe, 'function', 'should have an unsubscribe function');
  });

  it('calls onNext for each next message matching subscription id', async () => {
    const { client, ws } = await connectedClient();
    const received = [];

    client.subscribeAndMutate(
      'vsCode.subscribeToEvents', {},
      'vsCode.requestFullReview', {},
      (data) => received.push(data),
      () => {}, () => {}
    );

    const [sub, mut] = JSON.parse(ws.sent[0]);

    // Server acks mutation
    ws.receive({ id: mut.id, result: { data: { success: true } } });
    // Server sends subscription data
    ws.receive({ id: sub.id, result: { type: 'data', data: { type: 'pr_title', payload: 'My PR' } } });
    ws.receive({ id: sub.id, result: { type: 'data', data: { type: 'review_status', payload: { reviewStatus: 'reviewing' } } } });

    assert.equal(received.length, 2);
    assert.equal(received[0].type, 'pr_title');
    assert.equal(received[1].type, 'review_status');
  });

  it('calls onComplete when server sends stopped for subscription id', async () => {
    const { client, ws } = await connectedClient();
    let completed = false;

    client.subscribeAndMutate(
      'vsCode.subscribeToEvents', {},
      'vsCode.requestFullReview', {},
      () => {}, () => {}, () => { completed = true; }
    );

    const [sub, mut] = JSON.parse(ws.sent[0]);
    ws.receive({ id: mut.id, result: { data: { success: true } } });
    ws.receive({ id: sub.id, result: { type: 'stopped' } });

    assert.equal(completed, true);
  });

  it('resolves returned Promise with mutation result', async () => {
    const { client, ws } = await connectedClient();

    const { promise } = client.subscribeAndMutate(
      'vsCode.subscribeToEvents', {},
      'vsCode.requestFullReview', {},
      () => {}, () => {}, () => {}
    );

    const [, mut] = JSON.parse(ws.sent[0]);
    ws.receive({ id: mut.id, result: { data: { success: true } } });

    const result = await promise;
    assert.deepEqual(result, { success: true });
  });

  it('rejects returned Promise on mutation error', async () => {
    const { client, ws } = await connectedClient();

    const { promise } = client.subscribeAndMutate(
      'vsCode.subscribeToEvents', {},
      'vsCode.requestFullReview', {},
      () => {}, () => {}, () => {}
    );

    const [, mut] = JSON.parse(ws.sent[0]);
    ws.receive({ id: mut.id, error: { message: 'Server rejected mutation' } });

    await assert.rejects(promise, /server rejected mutation/i);
  });

  it('calls onError on subscription error message', async () => {
    const { client, ws } = await connectedClient();
    let errReceived = null;

    client.subscribeAndMutate(
      'vsCode.subscribeToEvents', {},
      'vsCode.requestFullReview', {},
      () => {}, (err) => { errReceived = err; }, () => {}
    );

    const [sub, mut] = JSON.parse(ws.sent[0]);
    ws.receive({ id: mut.id, result: { data: { success: true } } });
    ws.receive({ id: sub.id, error: { message: 'stream died' } });

    assert.ok(errReceived, 'onError should have been called');
  });

  it('unsubscribe sends subscription.stop and removes subscription', async () => {
    const { client, ws } = await connectedClient();

    const { unsubscribe } = client.subscribeAndMutate(
      'vsCode.subscribeToEvents', {},
      'vsCode.requestFullReview', {},
      () => {}, () => {}, () => {}
    );

    const [sub] = JSON.parse(ws.sent[0]);
    ws.sent.length = 0;

    unsubscribe();

    assert.equal(ws.sent.length, 1);
    const stopMsg = JSON.parse(ws.sent[0]);
    assert.equal(stopMsg.id, sub.id);
    assert.equal(stopMsg.method, 'subscription.stop');
    // Subscription should be removed from the map
    assert.equal(client.subscriptions.has(sub.id), false);
  });
});
