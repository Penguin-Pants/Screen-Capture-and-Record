// Firefox compatible popup script
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// Capture visible area
document.getElementById('captureVisible').addEventListener('click', async () => {
  try {
    console.log('Capture visible clicked');
    
    // Get active tab
    const tabs = await browserAPI.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    
    console.log('Active tab:', tab.id, tab.url);
    
    // Check if we can capture this tab
    if (tab.url.startsWith('about:') || 
        tab.url.startsWith('moz-extension://') ||
        tab.url.startsWith('chrome://') ||
        tab.url.startsWith('file://')) {
      alert('Cannot capture browser internal pages.\n\nPlease try on a regular webpage (like google.com)');
      return;
    }
    
    // Capture as PNG
    const dataUrl = await browserAPI.tabs.captureVisibleTab(tab.windowId, { 
      format: 'png'
    });
    
    console.log('Captured successfully, length:', dataUrl.length);
    
    // Convert data URL to blob
    const arr = dataUrl.split(',');
    const mime = arr[0].match(/:(.*?);/)[1];
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while(n--){
      u8arr[n] = bstr.charCodeAt(n);
    }
    const blob = new Blob([u8arr], {type: mime});
    
    // Create object URL
    const blobUrl = URL.createObjectURL(blob);
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const filename = `screenshot-${timestamp}.png`;
    
    console.log('Starting download...');
    
    // Download using blob URL
    const downloadId = await browserAPI.downloads.download({
      url: blobUrl,
      filename: filename,
      saveAs: false,
      conflictAction: 'uniquify'
    });
    
    console.log('Download started with ID:', downloadId);
    
    // Clean up after download completes
    setTimeout(() => {
      URL.revokeObjectURL(blobUrl);
      console.log('Blob URL cleaned up');
    }, 2000);
    
    window.close();
    
  } catch (error) {
    console.error('Capture error:', error);
    alert('Failed to capture screenshot.\n\nError: ' + error.message + '\n\nPlease try:\n1. Checking Downloads permission in about:addons\n2. Reloading the extension\n3. Trying on a different website');
  }
});

// Full page capture
document.getElementById('captureFullPage').addEventListener('click', async () => {
  try {
    console.log('Full page capture clicked');
    // Send message to background to capture full page
    await browserAPI.runtime.sendMessage({ action: 'captureFullPage' });
    window.close();
  } catch (error) {
    console.error('Full page capture error:', error);
    alert('Failed to start full page capture: ' + error.message);
  }
});

// Area capture
document.getElementById('captureArea').addEventListener('click', async () => {
  const tabs = await browserAPI.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  
  // Check if restricted URL
  if (tab.url.startsWith('about:') || 
      tab.url.startsWith('moz-extension://') ||
      tab.url.startsWith('chrome://') ||
      tab.url.startsWith('file://')) {
    alert('❌ Cannot capture browser internal pages. Please try on a regular webpage.');
    return;
  }
  
  console.log('Starting area capture on tab:', tab.id);
  
  try {
    // Inject and execute in one go
    console.log('Injecting and executing content script...');
    
    await browserAPI.tabs.executeScript(tab.id, {
      code: `
        (function() {
          console.log('Inline script executing...');
          
          // Check if already initialized
          if (window.screenCaptureActive) {
            console.log('Already active, cleaning up...');
            // Clean up existing
            ['screencapture-overlay', 'screencapture-selection', 'screencapture-size', 'screencapture-instruction'].forEach(id => {
              const el = document.getElementById(id);
              if (el) el.remove();
            });
            window.screenCaptureActive = false;
          }
          
          window.screenCaptureActive = true;
          
          // Create overlay immediately
          const overlay = document.createElement('div');
          overlay.id = 'screencapture-overlay';
          overlay.style.cssText = 'position:fixed!important;top:0!important;left:0!important;width:100vw!important;height:100vh!important;background:rgba(0,0,0,0.5)!important;cursor:crosshair!important;z-index:2147483647!important;';
          
          const selectionBox = document.createElement('div');
          selectionBox.id = 'screencapture-selection';
          selectionBox.style.cssText = 'position:fixed!important;border:3px solid #667eea!important;background:rgba(102,126,234,0.2)!important;display:none!important;z-index:2147483648!important;pointer-events:none!important;box-shadow:0 0 0 9999px rgba(0,0,0,0.3)!important;';
          
          const sizeIndicator = document.createElement('div');
          sizeIndicator.id = 'screencapture-size';
          sizeIndicator.style.cssText = 'position:fixed!important;background:#667eea!important;color:white!important;padding:6px 12px!important;border-radius:4px!important;font-family:system-ui,sans-serif!important;font-size:13px!important;font-weight:600!important;display:none!important;z-index:2147483649!important;pointer-events:none!important;';
          
          const instruction = document.createElement('div');
          instruction.id = 'screencapture-instruction';
          instruction.style.cssText = 'position:fixed!important;top:20px!important;left:50%!important;transform:translateX(-50%)!important;background:white!important;padding:15px 25px!important;border-radius:8px!important;font-family:system-ui,sans-serif!important;font-size:14px!important;color:#333!important;box-shadow:0 4px 20px rgba(0,0,0,0.3)!important;z-index:2147483649!important;pointer-events:none!important;';
          instruction.innerHTML = '📸 <strong>Select Area to Capture</strong><br><small>Click and drag • Press ESC to cancel</small>';
          
          document.body.appendChild(overlay);
          document.body.appendChild(selectionBox);
          document.body.appendChild(sizeIndicator);
          document.body.appendChild(instruction);
          
          let isSelecting = false;
          let startX = 0, startY = 0;
          
          const cleanup = () => {
            ['screencapture-overlay', 'screencapture-selection', 'screencapture-size', 'screencapture-instruction'].forEach(id => {
              const el = document.getElementById(id);
              if (el) el.remove();
            });
            window.screenCaptureActive = false;
          };
          
          overlay.addEventListener('mousedown', (e) => {
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
            
            const left = Math.min(startX, e.clientX);
            const top = Math.min(startY, e.clientY);
            const width = Math.abs(e.clientX - startX);
            const height = Math.abs(e.clientY - startY);
            
            selectionBox.style.left = left + 'px';
            selectionBox.style.top = top + 'px';
            selectionBox.style.width = width + 'px';
            selectionBox.style.height = height + 'px';
            
            sizeIndicator.textContent = width + ' × ' + height + ' px';
            sizeIndicator.style.left = (left + width + 10) + 'px';
            sizeIndicator.style.top = top + 'px';
            sizeIndicator.style.display = 'block';
          });
          
          overlay.addEventListener('mouseup', async (e) => {
            if (!isSelecting) return;
            e.preventDefault();
            e.stopPropagation();
            isSelecting = false;
            
            const left = Math.min(startX, e.clientX);
            const top = Math.min(startY, e.clientY);
            const width = Math.abs(e.clientX - startX);
            const height = Math.abs(e.clientY - startY);
            
            if (width < 10 || height < 10) {
              cleanup();
              return;
            }
            
            // Hide UI
            selectionBox.style.display = 'none';
            sizeIndicator.style.display = 'none';
            instruction.style.display = 'none';
            overlay.style.display = 'none';
            
            setTimeout(() => {
              cleanup();
              
              const browserAPI = typeof browser !== 'undefined' ? browser : chrome;
              const selection = {
                left: Math.round(left),
                top: Math.round(top),
                width: Math.round(width),
                height: Math.round(height)
              };
              
              browserAPI.runtime.sendMessage({
                action: 'captureViewportForCrop',
                selection: selection
              }).catch(err => console.error('Message error:', err));
            }, 250);
          });
          
          document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
              cleanup();
            }
          });
          
          overlay.addEventListener('contextmenu', (e) => {
            e.preventDefault();
          });
          
          console.log('Overlay created and ready');
          return true;
        })();
      `
    });
    
    console.log('Script executed successfully');
    
    // Close popup IMMEDIATELY
    window.close();
    
  } catch (error) {
    console.error('Error starting area capture:', error);
    alert('Failed to start area selection.\n\n' +
          'Error: ' + error.message + '\n\n' +
          'This page may block extensions. Try:\n' +
          '1. Refresh this page (F5)\n' +
          '2. Try on google.com or wikipedia.org');
  }
});

// Screen recording
document.getElementById('startRecording').addEventListener('click', async () => {
  // Open recording page
  browserAPI.tabs.create({ url: 'recorder.html' });
  window.close();
});

// Edit screenshot
document.getElementById('editScreenshot').addEventListener('click', async () => {
  browserAPI.tabs.create({ url: 'editor.html' });
  window.close();
});

// Support button - PayPal
document.getElementById('supportBtn').addEventListener('click', () => {
  const paypalEmail = 'josegpneto@yahoo.com.br';
  const paypalUrl = `https://www.paypal.com/donate/?business=${encodeURIComponent(paypalEmail)}&currency_code=USD`;
  browserAPI.tabs.create({ url: paypalUrl });
});

// Options link
document.getElementById('optionsLink').addEventListener('click', (e) => {
  e.preventDefault();
  browserAPI.runtime.openOptionsPage();
});

// Open downloads folder
document.getElementById('openFolderLink').addEventListener('click', (e) => {
  e.preventDefault();
  // Firefox doesn't have showDefaultFolder, just show downloads
  browserAPI.tabs.create({ url: 'about:downloads' });
});
