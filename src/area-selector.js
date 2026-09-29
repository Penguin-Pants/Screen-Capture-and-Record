// Area Selection Tool for ScreenCapture Pro
// This script creates a draggable selection overlay

(function() {
  // Prevent multiple instances
  if (window._screenCaptureAreaSelector) {
    return;
  }
  window._screenCaptureAreaSelector = true;

  // Create overlay
  const overlay = document.createElement('div');
  overlay.id = 'screencapture-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.5);
    cursor: crosshair;
    z-index: 2147483647;
  `;

  // Create selection box
  const selectionBox = document.createElement('div');
  selectionBox.id = 'screencapture-selection';
  selectionBox.style.cssText = `
    position: fixed;
    border: 2px solid #667eea;
    background: rgba(102, 126, 234, 0.1);
    display: none;
    z-index: 2147483648;
    box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.5);
  `;

  // Create instruction text
  const instruction = document.createElement('div');
  instruction.style.cssText = `
    position: fixed;
    top: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: white;
    padding: 15px 25px;
    border-radius: 8px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 14px;
    color: #333;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
    z-index: 2147483649;
    pointer-events: none;
  `;
  instruction.innerHTML = `
    📸 <strong>Select Area to Capture</strong><br>
    <small>Click and drag to select • Press ESC to cancel</small>
  `;

  // Append to body
  document.body.appendChild(overlay);
  document.body.appendChild(selectionBox);
  document.body.appendChild(instruction);

  // Selection state
  let isSelecting = false;
  let startX = 0;
  let startY = 0;
  let endX = 0;
  let endY = 0;

  // Mouse down - start selection
  overlay.addEventListener('mousedown', (e) => {
    isSelecting = true;
    startX = e.clientX;
    startY = e.clientY;
    endX = e.clientX;
    endY = e.clientY;
    
    selectionBox.style.display = 'block';
    updateSelectionBox();
  });

  // Mouse move - update selection
  overlay.addEventListener('mousemove', (e) => {
    if (!isSelecting) return;
    
    endX = e.clientX;
    endY = e.clientY;
    updateSelectionBox();
  });

  // Mouse up - capture selection
  overlay.addEventListener('mouseup', async (e) => {
    if (!isSelecting) return;
    
    isSelecting = false;
    endX = e.clientX;
    endY = e.clientY;
    
    // Calculate selection coordinates
    const left = Math.min(startX, endX);
    const top = Math.min(startY, endY);
    const width = Math.abs(endX - startX);
    const height = Math.abs(endY - startY);
    
    // Minimum selection size
    if (width < 10 || height < 10) {
      cleanup();
      return;
    }
    
    // Hide UI elements
    selectionBox.style.display = 'none';
    instruction.style.display = 'none';
    overlay.style.display = 'none';
    
    // Wait a moment for UI to hide
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Capture the entire viewport
    try {
      const canvas = await captureViewport();
      
      // Crop to selected area
      const croppedCanvas = document.createElement('canvas');
      const devicePixelRatio = window.devicePixelRatio || 1;
      
      croppedCanvas.width = width * devicePixelRatio;
      croppedCanvas.height = height * devicePixelRatio;
      
      const ctx = croppedCanvas.getContext('2d');
      ctx.drawImage(
        canvas,
        left * devicePixelRatio,
        top * devicePixelRatio,
        width * devicePixelRatio,
        height * devicePixelRatio,
        0,
        0,
        width * devicePixelRatio,
        height * devicePixelRatio
      );
      
      // Convert to blob and download
      croppedCanvas.toBlob((blob) => {
        const url = URL.createObjectURL(blob);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
        const a = document.createElement('a');
        a.href = url;
        a.download = `area-capture-${timestamp}.png`;
        a.click();
        URL.revokeObjectURL(url);
        
        cleanup();
      }, 'image/png');
      
    } catch (error) {
      console.error('Capture error:', error);
      cleanup();
    }
  });

  // Update selection box position and size
  function updateSelectionBox() {
    const left = Math.min(startX, endX);
    const top = Math.min(startY, endY);
    const width = Math.abs(endX - startX);
    const height = Math.abs(endY - startY);
    
    selectionBox.style.left = left + 'px';
    selectionBox.style.top = top + 'px';
    selectionBox.style.width = width + 'px';
    selectionBox.style.height = height + 'px';
    
    // Update instruction with dimensions
    instruction.innerHTML = `
      📸 <strong>Select Area to Capture</strong><br>
      <small>${width} × ${height} pixels • Press ESC to cancel</small>
    `;
  }

  // Capture viewport using chrome.tabs API
  async function captureViewport() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'captureVisibleTab' }, (response) => {
        if (response && response.dataUrl) {
          const img = new Image();
          img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            resolve(canvas);
          };
          img.onerror = reject;
          img.src = response.dataUrl;
        } else {
          reject(new Error('Failed to capture'));
        }
      });
    });
  }

  // Cleanup function
  function cleanup() {
    overlay.remove();
    selectionBox.remove();
    instruction.remove();
    window._screenCaptureAreaSelector = false;
    document.body.style.cursor = '';
  }

  // ESC key to cancel
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      cleanup();
    }
  });

  // Prevent context menu
  overlay.addEventListener('contextmenu', (e) => {
    e.preventDefault();
  });
})();