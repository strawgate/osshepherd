// using native fetch

// Dummy partial token — just enough to test 403 vs 404 endpoint behavior
const token = 'test-dummy-token';

async function testEndpoint(url, name) {
  try {
    console.log(`\n--- Testing ${name} ---`);
    console.log(`URL: ${url}`);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': token,
        'x-coderabbit-extension': 'vscode'
      },
      body: JSON.stringify({
        "0": {
          "extensionEvent": {
            "eventType": "REVIEW"
          }
        }
      }) // tRPC format
    });

    console.log(`STATUS: ${res.status} ${res.statusText}`);
    const text = await res.text();
    console.log(`BODY: ${text}`);
    return res.status;
  } catch (err) {
    console.log(`ERROR: ${err.message}`);
    if (err.stack) console.log(`STACK: ${err.stack}`);
    if (err.cause) console.log(`CAUSE:`, err.cause);
    return null;
  }
}

async function main() {
  const ideStatus = await testEndpoint('https://ide.coderabbit.ai/trpc/vsCode.requestFullReview', 'IDE POST');
  const appStatus = await testEndpoint('https://app.coderabbit.ai/trpc/vsCode.requestFullReview', 'APP POST');

  const ok = (s) => s !== null && s < 500;
  if (ok(ideStatus) && ok(appStatus)) {
    console.log('\n✅ Both endpoints reachable');
    process.exitCode = 0;
  } else {
    console.log('\n❌ One or more endpoints unreachable or server error');
    process.exitCode = 1;
  }
}

main();
