// ScreenCapture Pro - Content Script (Firefox Compatible)
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

console.log('ScreenCapture Pro content script loaded - ' + new Date().toISOString());

// Prevent multiple script instances
if (window.screenCaptureProLoaded) {
  console.log('Content script already loaded, skipping initialization');
} else {
  window.screenCaptureProLoaded = true;
  console.log('Content script initialized for first time');
}

// Flag to prevent multiple overlays
let isOverlayActive = false;

// Listen for messages from popup
browserAPI.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Content script received message:', request.action);
  
  // Respond to ping to check if script is loaded
  if (request.action === 'ping') {
    console.log('Responding to ping - script is loaded');
    sendResponse({ loaded: true, timestamp: Date.now() });
    return true;
  }
  
  if (request.action === 'startAreaCapture') {
    console.log('Starting area capture... isOverlayActive:', isOverlayActive);
    
    // If overlay is already active, clean it up first
    if (isOverlayActive) {
      console.log('Overlay already active, cleaning up first');
      removeExistingElements();
      isOverlayActive = false;
    }
    
    // Start area selection immediately
    try {
      startAreaSelection();
      sendResponse({ success: true });
    } catch (error) {
      console.error('Error starting area selection:', error);
      sendResponse({ success: false, error: error.message });
    }
    
    return true; // Keep channel open for async response
  }
  
  return false;
});

function startAreaSelection() {
  console.log('startAreaSelection called, isOverlayActive:', isOverlayActive);
  
  // Prevent multiple instances
  if (isOverlayActive) {
    console.log('Area selection already active, aborting');
    return;
  }
  
  // Set flag immediately
  isOverlayActive = true;
  console.log('Set isOverlayActive to true');
  
  // Remove any existing elements first
  removeExistingElements();

  // Create overlay
  const overlay = document.createElement('div');
  overlay.id = 'screencapture-overlay';
  overlay.style.cssText = `
    position: fixed !important;
    top: 0 !important;
    left: 0 !important;
    width: 100vw !important;
    height: 100vh !important;
    background: rgba(0, 0, 0, 0.5) !important;
    cursor: crosshair !important;
    z-index: 2147483647 !important;
    margin: 0 !important;
    padding: 0 !important;
  `;

  // Create selection box
  const selectionBox = document.createElement('div');
  selectionBox.id = 'screencapture-selection';
  selectionBox.style.cssText = `
    position: fixed !important;
    border: 3px solid #667eea !important;
    background: rgba(102, 126, 234, 0.2) !important;
    display: none !important;
    z-index: 2147483648 !important;
    pointer-events: none !important;
    box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.3) !important;
    margin: 0 !important;
    padding: 0 !important;
  `;

  // Create size indicator
  const sizeIndicator = document.createElement('div');
  sizeIndicator.id = 'screencapture-size';
  sizeIndicator.style.cssText = `
    position: fixed !important;
    background: #667eea !important;
    color: white !important;
    padding: 6px 12px !important;
    border-radius: 4px !important;
    font-family: system-ui, sans-serif !important;
    font-size: 13px !important;
    font-weight: 600 !important;
    display: none !important;
    z-index: 2147483649 !important;
    pointer-events: none !important;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3) !important;
    margin: 0 !important;
  `;

  // Create instruction
  const instruction = document.createElement('div');
  instruction.id = 'screencapture-instruction';
  instruction.style.cssText = `
    position: fixed !important;
    top: 20px !important;
    left: 50% !important;
    transform: translateX(-50%) !important;
    background: white !important;
    padding: 15px 25px !important;
    border-radius: 8px !important;
    font-family: system-ui, sans-serif !important;
    font-size: 14px !important;
    color: #333 !important;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3) !important;
    z-index: 2147483649 !important;
    pointer-events: none !important;
    margin: 0 !important;
  `;
  instruction.innerHTML = '📸 <strong>Select Area to Capture</strong><br><small>Click and drag • Press ESC to cancel</small>';

  // Append to body
  try {
    document.body.appendChild(overlay);
    document.body.appendChild(selectionBox);
    document.body.appendChild(sizeIndicator);
    document.body.appendChild(instruction);
    console.log('UI elements added to page successfully');
  } catch (error) {
    console.error('Error adding UI elements:', error);
    isOverlayActive = false;
    return;
  }

  let isSelecting = false;
  let startX = 0, startY = 0;

  const updateSelection = (currentX, currentY) => {
    const left = Math.min(startX, currentX);
    const top = Math.min(startY, currentY);
    const width = Math.abs(currentX - startX);
    const height = Math.abs(currentY - startY);

    selectionBox.style.left = left + 'px';
    selectionBox.style.top = top + 'px';
    selectionBox.style.width = width + 'px';
    selectionBox.style.height = height + 'px';
    selectionBox.style.display = 'block';

    sizeIndicator.textContent = `${width} × ${height} px`;
    sizeIndicator.style.left = (left + width + 10) + 'px';
    sizeIndicator.style.top = top + 'px';
    sizeIndicator.style.display = 'block';
  };

  const cleanup = () => {
    console.log('Cleaning up UI elements');
    removeExistingElements();
    isOverlayActive = false;
    console.log('isOverlayActive set to false');
  };

  overlay.addEventListener('mousedown', (e) => {
    console.log('Mouse down at:', e.clientX, e.clientY);
    e.preventDefault();
    e.stopPropagation();
    isSelecting = true;
    startX = e.clientX;
    startY = e.clientY;
    selectionBox.style.display = 'block';
  });

  overlay.addEventListener('mousemove', (e) => {
    if (!isSelecting) return;
    e.preventDefault();
    e.stopPropagation();
    updateSelection(e.clientX, e.clientY);
  });

  overlay.addEventListener('mouseup', (e) => {
    if (!isSelecting) return;
    
    console.log('Mouse up at:', e.clientX, e.clientY);
    e.preventDefault();
    e.stopPropagation();
    isSelecting = false;

    const left = Math.min(startX, e.clientX);
    const top = Math.min(startY, e.clientY);
    const width = Math.abs(e.clientX - startX);
    const height = Math.abs(e.clientY - startY);

    console.log('Area selected:', { left, top, width, height });

    if (width < 10 || height < 10) {
      console.log('Selection too small, cancelling');
      cleanup();
      return;
    }

    // Hide UI before capture
    selectionBox.style.display = 'none';
    sizeIndicator.style.display = 'none';
    instruction.style.display = 'none';
    overlay.style.display = 'none';

    console.log('UI hidden, sending capture request...');

    // Delay to ensure UI is hidden
    setTimeout(() => {
      console.log('Cleanup and sending message NOW');
      cleanup();
      
      const selection = { 
        left: Math.round(left), 
        top: Math.round(top), 
        width: Math.round(width), 
        height: Math.round(height) 
      };
      
      console.log('Sending captureViewportForCrop message with selection:', selection);
      
      // Send message to background to capture
      browserAPI.runtime.sendMessage({
        action: 'captureViewportForCrop',
        selection: selection
      }).then(response => {
        console.log('Capture response received:', response);
      }).catch(error => {
        console.error('Message send error:', error);
      });
    }, 250);
  });

  const escHandler = (e) => {
    if (e.key === 'Escape') {
      console.log('ESC pressed, cancelling');
      cleanup();
      document.removeEventListener('keydown', escHandler);
    }
  };

  document.addEventListener('keydown', escHandler);
  
  overlay.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  
  console.log('Area selection initialized successfully');
}

function removeExistingElements() {
  const elements = [
    'screencapture-overlay',
    'screencapture-selection',
    'screencapture-size',
    'screencapture-instruction'
  ];
  
  elements.forEach(id => {
    const element = document.getElementById(id);
    if (element) {
      element.remove();
      console.log(`Removed element: ${id}`);
    }
  });
}

// Make sure we're ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    console.log('ScreenCapture Pro ready (DOMContentLoaded)');
  });
} else {
  console.log('ScreenCapture Pro ready (already loaded)');
}
