// Minimal stand-in for the Firefox WebExtension "browser" API, so the
// extension pages can run in a normal Chromium page during tests.
// Every call is recorded in window.__calls.
(() => {
  const calls = { messages: [], downloads: [], shown: [], tabsCreated: [], tabsUpdated: [], badge: [] };
  const store = {};
  const downloadListeners = new Set();
  const clone = (value) => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

  window.__calls = calls;
  window.__downloadBlobs = [];
  window.__store = store;
  // Pages that extension.getViews() returns (tests can add fake views).
  window.__views = [];

  // An event object that keeps its listeners, so tests can fire them.
  const event = () => {
    const listeners = [];
    return {
      listeners,
      addListener: (listener) => listeners.push(listener),
      removeListener: (listener) => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      }
    };
  };

  window.browser = {
    browserAction: {
      onClicked: event(),
      setBadgeText: (details) => calls.badge.push({ text: details.text }),
      setBadgeBackgroundColor: () => {}
    },
    extension: {
      // A fake view can name its tab in __tabId.
      getViews: (filter = {}) => window.__views.filter((view) => filter.tabId === undefined || view.__tabId === filter.tabId)
    },
    storage: {
      local: {
        async get(keys) {
          const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(store);
          const result = {};
          for (const key of list) if (key in store) result[key] = clone(store[key]);
          return result;
        },
        async set(values) {
          Object.assign(store, clone(values));
        }
      }
    },
    runtime: {
      getURL: (path) => new URL(path.replace(/^\//, ''), location.href).href,
      async sendMessage(message) {
        calls.messages.push(clone(message));
        return { ok: true };
      },
      openOptionsPage: async () => calls.messages.push({ action: 'openOptionsPage' }),
      onMessage: event()
    },
    downloads: {
      // Tests can make a download fail (window.__downloadError = 'FILE_NO_SPACE')
      // or report its end before download() resolves (window.__downloadEndsFirst).
      async download(options) {
        const blob = await (await fetch(options.url)).blob();
        calls.downloads.push({ filename: options.filename, saveAs: options.saveAs, size: blob.size, type: blob.type });
        window.__downloadBlobs.push(blob);
        const id = calls.downloads.length;
        const end = window.__downloadError
          ? { id, state: { current: 'interrupted' }, error: { current: window.__downloadError } }
          : { id, state: { current: 'complete' } };
        const report = () => downloadListeners.forEach((listener) => listener(end));
        if (window.__downloadEndsFirst) report();
        else setTimeout(report, 0);
        return id;
      },
      onChanged: {
        addListener: (listener) => downloadListeners.add(listener),
        removeListener: (listener) => downloadListeners.delete(listener)
      },
      show: async (id) => calls.shown.push(id),
      showDefaultFolder: async () => calls.shown.push('default')
    },
    tabs: {
      getCurrent: async () => ({ id: 42, windowId: 3 }),
      get: async (id) => ({ id, windowId: 3, status: 'complete' }),
      create: async (options) => {
        calls.tabsCreated.push(options);
        return { id: 99 };
      },
      update: async (id, options) => {
        calls.tabsUpdated.push({ id, ...options });
        return { id, windowId: 3 };
      },
      onRemoved: event()
    },
    windows: {
      update: async () => ({})
    },
    commands: {
      onCommand: event(),
      getAll: async () => [
        { name: '_execute_browser_action', description: 'Open the screen recorder', shortcut: 'Alt+Shift+R' }
      ]
    }
  };
})();
