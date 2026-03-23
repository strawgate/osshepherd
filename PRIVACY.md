# Privacy Policy — OSShepherd for CodeRabbit™

**Effective date:** March 22, 2026
**Last updated:** March 22, 2026

## Summary

OSShepherd does not operate servers that collect or store your data. All data handling occurs locally in your browser or is transmitted directly to third-party services you authorize (CodeRabbit and GitHub).

## Data handling

- **No analytics or telemetry.** OSShepherd does not send usage data, crash reports, or any telemetry to any server operated by the OSShepherd project.
- **No tracking.** There are no cookies, pixels, fingerprinting, or third-party tracking scripts.
- **No remote servers.** OSShepherd has no backend. There is no server operated by the project that receives data from the extension.
- **Local storage only.** Review results, authentication tokens, and settings are stored in your browser's `chrome.storage.local` and are never transmitted to the OSShepherd project.

## Third-party services

OSShepherd connects to **CodeRabbit** (`app.coderabbit.ai` and `ide.coderabbit.ai`) to authenticate and stream AI code reviews. This communication is between your browser and CodeRabbit's servers — OSShepherd does not proxy, log, or store this traffic beyond caching review results locally for your convenience.

Your use of CodeRabbit is governed by [CodeRabbit's privacy policy](https://www.coderabbit.ai/privacy-policy). OSShepherd has no access to your CodeRabbit account beyond the OAuth token you grant during sign-in.

OSShepherd also fetches PR diffs from **GitHub** (`patch-diff.githubusercontent.com`) to send to CodeRabbit for review. No GitHub data is sent anywhere other than directly to CodeRabbit's API.

## Data retention and deletion

All data is stored locally in your browser via `chrome.storage.local`. This includes cached review results (up to 50 PRs), authentication tokens, and settings. This data is automatically deleted when you uninstall the extension. You can also clear cached reviews at any time via the extension's Settings page.

## Your rights

Since OSShepherd does not collect or store data on any server, there is no personal data held by the project to access, correct, or delete. All data resides in your browser and is under your control. If you have questions about data handled by CodeRabbit or GitHub, refer to their respective privacy policies.

## Contact

If you have questions about this privacy policy, [open an issue](https://github.com/strawgate/chromerabbit/issues).

## Disclaimer

OSShepherd is not affiliated with, endorsed by, or sponsored by CodeRabbit, Inc. CodeRabbit™ is a trademark of CodeRabbit, Inc.
