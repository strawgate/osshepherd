'use strict';

const globals = require('globals');

// Chrome extension global — not in any standard environment set
const chromeGlobal = { chrome: 'readonly' };

// Globals injected by each file's HTML/importScripts (not imports)
const swInjected = {
  ReviewStore: 'readonly',
  generateUUID: 'readonly',
  CodeRabbitClient: 'readonly',
};
const offscreenInjected = {
  CodeRabbitClient: 'readonly',
  CRDiffParser: 'readonly',
};
const contentInjected = {
  ReviewStore: 'readonly',
  CRUtils: 'readonly',
  CRMarkdown: 'readonly',
  // Sidebar runs in sidepanel.html (not content script) — no CRSidebar global needed here
  // Bare functions from utils/utils.js (injected via manifest content_scripts)
  generateUUID: 'readonly',
  formatRelativeTime: 'readonly',
};
// Preact globals from vendor/preact-htm.js
const preactGlobals = {
  html: 'readonly',
  render: 'readonly',
  useState: 'readonly',
  useEffect: 'readonly',
  useRef: 'readonly',
  useCallback: 'readonly',
  useMemo: 'readonly',
  useContext: 'readonly',
  useErrorBoundary: 'readonly',
  createContext: 'readonly',
  signal: 'readonly',
  computed: 'readonly',
  effect: 'readonly',
  batch: 'readonly',
};

module.exports = [
  // ── Ignored paths ────────────────────────────────────────────────────────
  {
    ignores: ['node_modules/**', '_metadata/**', 'src/vendor/**', 'plans/**'],
  },

  // ── Base rules applied to every file ─────────────────────────────────────
  {
    rules: {
      'eqeqeq':        ['error', 'always', { null: 'ignore' }],
      'no-var':        'error',
      'prefer-const':  'error',
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
  },

  // ── Service Worker — background.js ───────────────────────────────────────
  // Environment: ServiceWorkerGlobalScope — no window, no DOM.
  // Globals arrive via importScripts(); they are not imports.
  {
    files: ['src/background.js'],
    languageOptions: {
      globals: {
        ...globals.serviceworker,   // self, importScripts, caches, clients…
        ...chromeGlobal,
        ...swInjected,
      },
    },
    rules: {
      'no-undef': 'error',
      'no-restricted-globals': ['error',
        {
          name: 'window',
          message: 'Service workers have no window — use globalThis or the chrome.* API.',
        },
      ],
    },
  },

  // ── Offscreen document — offscreen.js ────────────────────────────────────
  // Has DOM but only chrome.runtime (NOT chrome.storage, chrome.tabs, etc.).
  // Globals arrive via <script> tags in offscreen.html.
  {
    files: ['src/offscreen.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...chromeGlobal,
        ...offscreenInjected,
      },
    },
    rules: {
      'no-undef': 'error',
    },
  },

  // ── Sidebar (Preact components) ──────────────────────────────────────────
  {
    files: ['src/sidebar.js', 'src/sidepanel-mount.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...chromeGlobal,
        ...contentInjected,
        ...preactGlobals,
        // Cross-file globals: sidebar.js defines these, sidepanel-mount.js consumes them
        Sidebar: 'writable',
        reviewSignal: 'writable',
        SidebarContext: 'writable',
        navigateToFileLine: 'writable',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^(Sidebar|reviewSignal|SidebarContext|navigateToFileLine)$',
      }],
    },
  },

  // ── Content scripts, popup, options ──────────────────────────────────────
  {
    files: ['src/content.js', 'src/popup.js', 'src/options.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...chromeGlobal,
        ...contentInjected,
      },
    },
    rules: {
      'no-undef': 'error',
    },
  },

  // ── Shared utilities ──────────────────────────────────────────────────────
  // These run in SW, browser, AND Node — must not reference window.
  // chrome is included because review-store.js uses chrome.storage.local as a
  // default parameter (only evaluated at call time in browser contexts).
  {
    files: ['src/utils/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        ...chromeGlobal,
      },
    },
    rules: {
      'no-undef': 'error',
      'no-restricted-globals': ['error',
        {
          name: 'window',
          message: 'Utils run in SW and Node contexts — use globalThis instead.',
        },
      ],
    },
  },

  // ── Node.js test runner scripts (test-*.js) ───────────────────────────────
  {
    files: ['test-*.js', 'test/scripts/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-undef': 'error',
    },
  },

  // ── Unit test files ───────────────────────────────────────────────────────
  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...chromeGlobal,  // provided by jest-webextension-mock at runtime
      },
    },
    rules: {
      'no-undef': 'error',
    },
  },
];
