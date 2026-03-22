/**
 * End-to-end test harness for the CodeRabbit review flow.
 *
 * Uses the real CodeRabbitClient from utils/trpc-client.js so any changes
 * to the WS/tRPC logic are tested directly — no reimplementation.
 *
 * Usage:
 *   node test-review-flow.js https://github.com/owner/repo/pull/123
 *
 * Credentials (.env):
 *   CODERABBIT_SESSION_TOKEN=<your access token>
 *   CODERABBIT_ORG_ID=<org UUID, optional>
 *   CODERABBIT_COOKIE=<Cookie: ... header value, needed to pass WAF>
 */

const fs = require('fs');
const path = require('path');
const NodeWebSocket = require('ws');

// ---------------------------------------------------------------------------
// Load .env
// ---------------------------------------------------------------------------
const dotenvPath = path.resolve(__dirname, '.env');
const env = {};
if (fs.existsSync(dotenvPath)) {
  fs.readFileSync(dotenvPath, 'utf8')
    .split('\n')
    .filter(line => line.includes('='))
    .forEach(line => {
      const [key, ...rest] = line.split('=');
      env[key.trim()] = rest.join('=').trim().replace(/^['"]|['"]$/g, '');
    });
}

const token = env.CODERABBIT_SESSION_TOKEN || process.env.CODERABBIT_SESSION_TOKEN;
if (!token || token.length < 20) {
  console.error('❌ Missing CODERABBIT_SESSION_TOKEN in .env');
  process.exit(1);
}

const cookie = env.CODERABBIT_COOKIE || process.env.CODERABBIT_COOKIE || null;
if (!cookie) {
  console.warn('⚠️  No CODERABBIT_COOKIE set — Cloud Armor may reject the connection with 403');
}

const organizationId = env.CODERABBIT_ORG_ID || process.env.CODERABBIT_ORG_ID || null;

// ---------------------------------------------------------------------------
// Parse PR URL from CLI arg
// ---------------------------------------------------------------------------
const prUrl = process.argv[2];
let owner, repo, prNumber;

if (prUrl) {
  const m = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) {
    console.error('❌ Invalid PR URL. Expected: https://github.com/owner/repo/pull/123');
    process.exit(1);
  }
  [, owner, repo, prNumber] = m;
} else {
  // Default to a small known-good PR for quick smoke testing
  owner = 'open-telemetry';
  repo = 'opentelemetry-collector-contrib';
  prNumber = '46010';
  console.log(`ℹ️  No PR URL provided. Using default: https://github.com/${owner}/${repo}/pull/${prNumber}`);
}

// ---------------------------------------------------------------------------
// Bootstrap CodeRabbitClient into Node.js
// The module exports itself via module.exports when not in a browser context.
// We inject a wsFactory that wraps the 'ws' library with auth headers,
// replicating what DNR rules do inside the real Chrome extension.
// ---------------------------------------------------------------------------
global.window = undefined; // ensure the module.exports path is taken
const CodeRabbitClient = require('./utils/trpc-client');
const { parseDiff } = require('./utils/diff-parser');
const { generateUUID } = require('./utils/utils');

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\n🐑 OSShepherd E2E Test — ${owner}/${repo}#${prNumber}\n`);

  // 1. Fetch the real PR diff
  const diffUrl = `https://patch-diff.githubusercontent.com/raw/${owner}/${repo}/pull/${prNumber}.diff`;
  console.log(`📥 Fetching diff from ${diffUrl}...`);
  const diffResponse = await fetch(diffUrl);
  if (!diffResponse.ok) throw new Error(`Failed to fetch diff: ${diffResponse.status}`);
  const diffContent = await diffResponse.text();
  const files = parseDiff(diffContent);
  console.log(`✅ Got diff: ${diffContent.length} bytes, ${files.length} file(s)\n`);

  const clientId = env.CODERABBIT_CLIENT_ID || generateUUID();
  const reviewId = generateUUID();

  // 2. Auto-fetch user + org using the Bearer token (same flow as VS Code extension)
  const httpHeaders = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

  console.log('👤 Fetching user profile...');
  const userResp = await fetch('https://app.coderabbit.ai/checkAndCreateUser?provider=github&selfHostedDomain=', { headers: httpHeaders });
  if (!userResp.ok) throw new Error(`Failed to fetch user (${userResp.status})`);
  const userData = await userResp.json();
  const user = userData.data;
  console.log(`✅ User: ${user.user_name} (${user.email})`);

  console.log('🏢 Fetching organization...');
  const orgInput = encodeURIComponent(JSON.stringify({
    "0": { user_name: user.user_name, user_id: user.provider_user_id, provider: user.provider, selfHostedDomain: '' }
  }));
  const orgResp = await fetch(`https://app.coderabbit.ai/trpc/organizations.getCurrentOrganization?batch=1&input=${orgInput}`, { headers: httpHeaders });
  const orgData = await orgResp.json();
  const org = orgData[0]?.result?.data?.data;
  const resolvedOrgId = org?.id || organizationId || null;
  console.log(`✅ Org: ${org?.organization_name || 'None'} (${resolvedOrgId})\n`);

  // 3. Build the wsFactory — injects auth headers the same way DNR rules do in the extension
  const wsHeaders = {
    'Authorization': token,
    'X-CodeRabbit-Extension': 'vscode',
    'X-CodeRabbit-Extension-Version': '1.0.6',
  };
  if (resolvedOrgId) wsHeaders['x-coderabbitai-organization'] = resolvedOrgId;
  if (cookie) {
    let cookieStr = cookie;
    if (cookieStr.includes("'Cookie': '")) {
      cookieStr = cookieStr.split("'Cookie': '")[1].split("'")[0];
    } else if (cookieStr.toLowerCase().startsWith('cookie: ')) {
      cookieStr = cookieStr.slice(8).trim();
    }
    wsHeaders['Cookie'] = cookieStr;
  }

  const wsFactory = (url) => new NodeWebSocket(url, { headers: wsHeaders });

  // 4. Connect using the real CodeRabbitClient
  const client = new CodeRabbitClient(token, { wsFactory });
  console.log('🔌 Connecting to CodeRabbit WebSocket...');
  await client.connect(resolvedOrgId);
  console.log('✅ Connected & authenticated\n');

  // 4. Build review payload
  const requestPayload = {
    extensionEvent: {
      userId: clientId,
      userName: 'ChromeExtensionUser',
      clientId,
      eventType: 'REVIEW',
      reviewId,
      files,
      hostUrl: 'https://github.com',
      provider: 'github',
      remoteUrl: `https://github.com/${owner}/${repo}.git`,
      host: 'vscode',
      version: '1.0.6',
    },
  };

  function onNext(data) {
    if (!data || !data.type) return;
    if (data.type === 'review_comment') {
      const c = data.payload;
      if (c?.filename) {
        const lines = c.startLine && c.startLine !== c.endLine
          ? `${c.startLine}-${c.endLine}` : (c.startLine || '?');
        console.log(`\n💬 [comment] ${c.filename}:${lines}`);
        console.log(`   ${(c.codegenInstructions || c.message || '').substring(0, 200)}`);
      }
    } else if (data.type === 'review_completed') {
      console.log(`\n✨ [review_completed] ${data.payload?.summary || ''}`);
    } else {
      console.log(`\n📦 [${data.type}]`, JSON.stringify(data.payload || data).substring(0, 120));
    }
  }

  // 5. Send subscription + mutation as a single batched frame (what the server requires)
  console.log(`\n🚀 Sending batched subscribe+mutate for ${files.length} file(s)...`);
  const { promise: reviewDone, unsubscribe } = client.subscribeAndMutate(
    'vsCode.subscribeToEvents', { clientId },
    'vsCode.requestFullReview', requestPayload,
    onNext,
    (err) => { console.error('❌ Subscription error:', err); unsubscribe(); },
    () => { console.log('\n🛑 Subscription closed — review complete'); process.exit(0); }
  );
  const mutationResponse = await reviewDone;
  console.log('✅ Mutation acknowledged:', JSON.stringify(mutationResponse).substring(0, 120));
  console.log('\n⏳ Waiting for streaming events (timeout: 60s)...\n');
}

main().catch(err => {
  console.error('\n💥 Fatal error:', err.message || err);
  process.exit(1);
});

// Safety exit
setTimeout(() => {
  console.log('\n⏰ Test timed out after 60s');
  process.exit(1);
}, 60000);
