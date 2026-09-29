// Area selection overlay. The background page injects this file into the
// active tab. It sends the selected rectangle in document CSS pixels.
(() => {
  'use strict';

  // A second injection replaces the first overlay.
  if (window.__screenCaptureAndRecordOverlay) {
    window.__screenCaptureAndRecordOverlay.destroy();
  }

  const MIN_SIZE = 5;
  const host = document.createElement('div');
  host.setAttribute('style', 'all: initial; position: fixed; inset: 0; z-index: 2147483647;');
  const root = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    .layer { position: fixed; inset: 0; cursor: crosshair; background: rgba(0, 0, 0, 0.45); }
    .layer.selecting { background: transparent; }
    .box { position: fixed; display: none; border: 2px solid #667eea; box-sizing: border-box;
           box-shadow: 0 0 0 100vmax rgba(0, 0, 0, 0.45); pointer-events: none; }
    .label, .hint { position: fixed; font: 600 13px/1.3 system-ui, sans-serif; color: #fff;
                    background: #667eea; border-radius: 4px; padding: 4px 8px; pointer-events: none; }
    .label { display: none; }
    .hint { top: 16px; left: 50%; transform: translateX(-50%); background: rgba(20, 20, 30, 0.9);
            padding: 10px 16px; border-radius: 8px; text-align: center; }
    .hint small { font-weight: 400; opacity: 0.85; }
  `;

  const layer = document.createElement('div');
  layer.className = 'layer';
  const box = document.createElement('div');
  box.className = 'box';
  const label = document.createElement('div');
  label.className = 'label';
  const hint = document.createElement('div');
  hint.className = 'hint';
  const hintTitle = document.createElement('div');
  hintTitle.textContent = 'Drag to select an area';
  const hintKeys = document.createElement('small');
  hintKeys.textContent = 'Enter: visible area · Esc: cancel';
  hint.append(hintTitle, hintKeys);

  root.append(style, layer, box, label, hint);
  document.documentElement.appendChild(host);

  let start = null;
  let current = null;

  function rectFrom(a, b) {
    return {
      left: Math.min(a.x, b.x),
      top: Math.min(a.y, b.y),
      width: Math.abs(b.x - a.x),
      height: Math.abs(b.y - a.y)
    };
  }

  function render() {
    const r = rectFrom(start, current);
    Object.assign(box.style, {
      display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`
    });
    label.textContent = `${Math.round(r.width)} × ${Math.round(r.height)}`;
    const labelTop = r.top > 30 ? r.top - 28 : r.top + r.height + 6;
    Object.assign(label.style, { display: 'block', left: `${r.left}px`, top: `${labelTop}px` });
  }

  function destroy() {
    document.removeEventListener('keydown', onKeyDown, true);
    host.remove();
    delete window.__screenCaptureAndRecordOverlay;
  }

  // Remove the overlay, wait until Firefox paints the page without it,
  // then ask the background page to capture.
  function finish(message) {
    destroy();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      browser.runtime.sendMessage(message).catch(() => {});
    }));
  }

  function selectRect(viewportRect) {
    finish({
      action: 'areaSelected',
      rect: {
        x: viewportRect.left + window.scrollX,
        y: viewportRect.top + window.scrollY,
        width: viewportRect.width,
        height: viewportRect.height
      },
      scale: window.devicePixelRatio || 1
    });
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      destroy();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      const page = document.documentElement;
      selectRect({ left: 0, top: 0, width: page.clientWidth, height: page.clientHeight });
    }
  }

  layer.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    layer.setPointerCapture(event.pointerId);
    start = current = { x: event.clientX, y: event.clientY };
    layer.classList.add('selecting');
    hint.style.display = 'none';
  });

  layer.addEventListener('pointermove', (event) => {
    if (!start) return;
    current = { x: event.clientX, y: event.clientY };
    render();
  });

  layer.addEventListener('pointerup', (event) => {
    if (!start) return;
    current = { x: event.clientX, y: event.clientY };
    const r = rectFrom(start, current);
    start = null;
    if (r.width < MIN_SIZE || r.height < MIN_SIZE) {
      box.style.display = 'none';
      label.style.display = 'none';
      layer.classList.remove('selecting');
      hint.style.display = '';
      return;
    }
    selectRect(r);
  });

  layer.addEventListener('contextmenu', (event) => event.preventDefault());
  document.addEventListener('keydown', onKeyDown, true);

  window.__screenCaptureAndRecordOverlay = { destroy };
})();
