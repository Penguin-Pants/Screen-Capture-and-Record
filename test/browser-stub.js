// Minimal stand-in for the Firefox WebExtension "browser" API, so the
// extension pages can run in a normal Chromium page during tests.
// Every call is recorded in window.__calls.
(() => {
  const calls = { messages: [], downloads: [], clipboard: [], shown: [], tabsCreated: [], captureTab: [], executeScript: [] };
  const store = {};
  const downloadListeners = new Set();
  const clone = (value) => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

  window.__calls = calls;
  window.__store = store;

  // A 400x300 test image: red left half, blue right half.
  window.__makeCaptureDataUrl = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 300;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, 200, 300);
    ctx.fillStyle = '#0000ff';
    ctx.fillRect(200, 0, 200, 300);
    return canvas.toDataURL('image/png');
  };

  // Event objects that only record listeners (enough to load background.js).
  const event = () => ({ addListener() {}, removeListener() {} });

  window.browser = {
    browserAction: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    notifications: { create: async () => 'n1', onClicked: event(), onClosed: event() },
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
        if (message.action === 'getCapture') {
          return message.id === 'missing' ? null : { name: 'area-test', dataUrl: window.__makeCaptureDataUrl() };
        }
        return { ok: true };
      },
      openOptionsPage: async () => calls.messages.push({ action: 'openOptionsPage' }),
      onMessage: event()
    },
    downloads: {
      async download(options) {
        const blob = await (await fetch(options.url)).blob();
        calls.downloads.push({ filename: options.filename, saveAs: options.saveAs, size: blob.size, type: blob.type });
        const id = calls.downloads.length;
        setTimeout(() => downloadListeners.forEach((listener) => listener({ id, state: { current: 'complete' } })), 0);
        return id;
      },
      onChanged: {
        addListener: (listener) => downloadListeners.add(listener),
        removeListener: (listener) => downloadListeners.delete(listener)
      },
      show: async (id) => calls.shown.push(id),
      showDefaultFolder: async () => calls.shown.push('default')
    },
    clipboard: {
      async setImageData(buffer, type) {
        calls.clipboard.push({ bytes: buffer.byteLength, type });
      }
    },
    tabs: {
      query: async () => [{ id: 7, index: 0, windowId: 1, url: window.__activeTabUrl || 'https://example.com/' }],
      create: async (options) => {
        calls.tabsCreated.push(options);
        return { id: 99 };
      },
      onRemoved: event()
    },
    commands: {
      onCommand: event(),
      getAll: async () => [
        { name: 'capture-area', description: 'Capture a selected area', shortcut: 'Alt+Shift+A' },
        { name: 'capture-visible', description: 'Capture the visible area', shortcut: 'Alt+Shift+S' },
        { name: 'capture-fullpage', description: 'Capture the full page', shortcut: '' }
      ]
    }
  };
})();
