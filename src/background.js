// Firefox compatible background script
// Use browser namespace for Firefox compatibility
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// Handle messages
browserAPI.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Background received message:', request.action, 'from tab:', sender.tab?.id);
  
  if (request.action === 'captureViewportForCrop') {
    console.log('Starting captureAndCropArea...');
    captureAndCropArea(request.selection, sender.tab.id).then(() => {
      sendResponse({ success: true, message: 'Capture started' });
    }).catch(error => {
      console.error('Capture error:', error);
      sendResponse({ success: false, error: error.message });
    });
    return true; // Keep channel open for async response
  } else if (request.action === 'openEditor') {
    openEditor();
    sendResponse({ success: true });
  } else if (request.action === 'captureFullPage') {
    captureFullPage().then(() => {
      sendResponse({ success: true });
    });
    return true;
  } else if (request.action === 'cropAndSave') {
    cropAndSaveImage(request.data);
    sendResponse({ success: true });
  } else if (request.action === 'recordingStopped') {
    showNotification('Recording Saved!', 'Your screen recording has been saved');
    sendResponse({ success: true });
  } else if (request.action === 'captureVisibleTab') {
    // Direct capture request from content script
    browserAPI.tabs.captureVisibleTab(null, { format: 'png' }).then(dataUrl => {
      sendResponse({ dataUrl: dataUrl });
    }).catch(error => {
      sendResponse({ error: error.message });
    });
    return true;
  }
  
  return true;
});

// Safe notification function
function showNotification(title, message) {
  try {
    if (browserAPI.notifications) {
      browserAPI.notifications.create({
        type: 'basic',
        iconUrl: browserAPI.runtime.getURL('icons/icon128.png'),
        title: title,
        message: message
      });
    }
  } catch (error) {
    console.log(title + ': ' + message);
  }
}

// Capture and crop area
async function captureAndCropArea(selection, tabId) {
  console.log('=== CAPTURE AND CROP AREA STARTED ===');
  console.log('Selection:', selection);
  console.log('Tab ID:', tabId);
  
  try {
    // Small delay to ensure UI is hidden
    console.log('Waiting 200ms for UI to hide...');
    await new Promise(resolve => setTimeout(resolve, 200));
    
    console.log('Capturing visible tab...');
    const dataUrl = await browserAPI.tabs.captureVisibleTab(null, { format: 'png' });
    console.log('Captured! Data URL length:', dataUrl.length);
    
    if (!dataUrl || dataUrl.length === 0) {
      throw new Error('Capture returned empty data');
    }
    
    // Process in content script
    console.log('Injecting crop script into tab:', tabId);
    
    // Firefox uses different API for script execution
    const result = await browserAPI.tabs.executeScript(tabId, {
      code: `
        (function(dataUrl, sel) {
          console.log('=== CROP SCRIPT EXECUTING ===');
          console.log('Selection received:', sel);
          console.log('DataURL length:', dataUrl.length);
          
          try {
            const img = document.createElement('img');
            
            img.onload = () => {
              console.log('Image loaded successfully');
              console.log('Image dimensions:', img.width, 'x', img.height);
              
              const canvas = document.createElement('canvas');
              const dpr = window.devicePixelRatio || 1;
              console.log('Device pixel ratio:', dpr);
              
              canvas.width = sel.width * dpr;
              canvas.height = sel.height * dpr;
              console.log('Canvas size:', canvas.width, 'x', canvas.height);
              
              const ctx = canvas.getContext('2d');
              
              ctx.drawImage(
                img,
                sel.left * dpr, 
                sel.top * dpr, 
                sel.width * dpr, 
                sel.height * dpr,
                0, 
                0, 
                canvas.width, 
                canvas.height
              );
              
              console.log('Image drawn to canvas, creating blob...');
              
              canvas.toBlob((blob) => {
                console.log('Blob created, size:', blob.size);
                
                const url = URL.createObjectURL(blob);
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
                const filename = 'area-capture-' + timestamp + '.png';
                
                console.log('Creating download link:', filename);
                
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                
                setTimeout(() => {
                  URL.revokeObjectURL(url);
                  console.log('=== DOWNLOAD COMPLETE ===');
                }, 100);
              }, 'image/png');
            };
            
            img.onerror = (err) => {
              console.error('Image load error:', err);
              alert('Failed to load captured image');
            };
            
            console.log('Setting image src...');
            img.src = dataUrl;
            
          } catch (error) {
            console.error('Error in crop script:', error);
            alert('Crop error: ' + error.message);
          }
        })(${JSON.stringify(dataUrl)}, ${JSON.stringify(selection)});
      `
    });
    
    console.log('Script injection result:', result);
    
    await addToHistory({
      type: 'area',
      filename: `area-capture-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)}.png`,
      timestamp: Date.now()
    });
    
    showNotification('Area Captured!', 'Selected area saved successfully');
    console.log('=== CAPTURE AND CROP AREA COMPLETED ===');
    
  } catch (error) {
    console.error('=== CAPTURE AND CROP AREA FAILED ===');
    console.error('Error:', error);
    console.error('Error stack:', error.stack);
    showNotification('Capture Failed', 'Could not capture area: ' + error.message);
  }
}

// Keyboard shortcuts
browserAPI.commands.onCommand.addListener((command) => {
  if (command === 'capture-visible') {
    captureVisibleArea();
  }
});

// Capture visible area
async function captureVisibleArea() {
  const dataUrl = await browserAPI.tabs.captureVisibleTab(null, { format: 'png' });
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const filename = `screenshot-${timestamp}.png`;
  
  browserAPI.downloads.download({
    url: dataUrl,
    filename: filename,
    saveAs: false
  });
}

// Capture full page
async function captureFullPage() {
  try {
    const tabs = await browserAPI.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    
    if (tab.url.startsWith('about:') || tab.url.startsWith('moz-extension://')) {
      showNotification('Cannot Capture', 'Browser internal pages cannot be captured.');
      return;
    }
    
    showNotification('Capturing...', 'Please wait while capturing the full page');
    
    // Get page dimensions
    const pageInfo = await browserAPI.tabs.executeScript(tab.id, {
      code: `
        ({
          width: Math.max(
            document.body.scrollWidth || 0,
            document.documentElement.scrollWidth || 0,
            document.body.offsetWidth || 0,
            document.documentElement.offsetWidth || 0
          ),
          height: Math.max(
            document.body.scrollHeight || 0,
            document.documentElement.scrollHeight || 0,
            document.body.offsetHeight || 0,
            document.documentElement.offsetHeight || 0
          ),
          viewportHeight: window.innerHeight,
          originalScrollY: window.scrollY,
          dpr: window.devicePixelRatio || 1
        })
      `
    });
    
    const { width, height, viewportHeight, originalScrollY, dpr } = pageInfo[0];
    
    // Check if page is too large
    if (height > 30000) {
      const dataUrl = await browserAPI.tabs.captureVisibleTab(null, { format: 'png' });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      browserAPI.downloads.download({
        url: dataUrl,
        filename: `fullpage-${timestamp}.png`,
        saveAs: true
      });
      
      showNotification('Page Too Large', 'Captured visible area only');
      return;
    }
    
    const numCaptures = Math.ceil(height / viewportHeight);
    const captures = [];
    
    // Capture sections with longer delays
    for (let i = 0; i < numCaptures; i++) {
      // Scroll to position
      await browserAPI.tabs.executeScript(tab.id, {
        code: `window.scrollTo(0, ${i * viewportHeight});`
      });
      
      // Wait for page to settle
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      // Capture
      const dataUrl = await browserAPI.tabs.captureVisibleTab(null, { format: 'png' });
      captures.push(dataUrl);
    }
    
    // Restore original scroll position
    await browserAPI.tabs.executeScript(tab.id, {
      code: `window.scrollTo(0, ${originalScrollY});`
    });
    
    // Stitch images together in content script
    await browserAPI.tabs.executeScript(tab.id, {
      code: `
        (function(captures, width, height, viewportHeight, dpr) {
          return new Promise((resolve) => {
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            
            ctx.fillStyle = 'white';
            ctx.fillRect(0, 0, width, height);
            
            let loadedCount = 0;
            const totalCaptures = captures.length;
            
            captures.forEach((dataUrl, index) => {
              const img = document.createElement('img');
              img.onload = () => {
                const y = index * viewportHeight;
                ctx.drawImage(img, 0, y);
                
                loadedCount++;
                
                if (loadedCount === totalCaptures) {
                  canvas.toBlob((blob) => {
                    const url = URL.createObjectURL(blob);
                    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'fullpage-' + timestamp + '.png';
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    setTimeout(() => {
                      URL.revokeObjectURL(url);
                      resolve();
                    }, 100);
                  }, 'image/png');
                }
              };
              img.onerror = () => {
                console.error('Failed to load image segment');
                loadedCount++;
                if (loadedCount === totalCaptures) {
                  resolve();
                }
              };
              img.src = dataUrl;
            });
          });
        })(${JSON.stringify(captures)}, ${width}, ${height}, ${viewportHeight}, ${dpr})
      `
    });
    
    await addToHistory({
      type: 'fullpage',
      filename: `fullpage-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)}.png`,
      timestamp: Date.now(),
      url: tab.url
    });
    
    showNotification('Full Page Captured!', 'Screenshot saved successfully');
    
  } catch (error) {
    console.error('Full page capture error:', error);
    showNotification('Capture Failed', error.message || 'Could not capture page');
  }
}

async function cropAndSaveImage(data) {
  try {
    const tabs = await browserAPI.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    
    await browserAPI.tabs.executeScript(tab.id, {
      code: `
        (function(dataUrl, selection) {
          const img = document.createElement('img');
          img.onload = () => {
            const canvas = document.createElement('canvas');
            const dpr = window.devicePixelRatio || 1;
            
            canvas.width = selection.width * dpr;
            canvas.height = selection.height * dpr;
            
            const ctx = canvas.getContext('2d');
            ctx.drawImage(
              img,
              selection.left * dpr, 
              selection.top * dpr,
              selection.width * dpr, 
              selection.height * dpr,
              0, 
              0,
              canvas.width, 
              canvas.height
            );
            
            canvas.toBlob((blob) => {
              const url = URL.createObjectURL(blob);
              const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
              const a = document.createElement('a');
              a.href = url;
              a.download = 'area-capture-' + timestamp + '.png';
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              setTimeout(() => URL.revokeObjectURL(url), 100);
            });
          };
          img.src = dataUrl;
        })(${JSON.stringify(data.image)}, ${JSON.stringify(data.selection)})
      `
    });
    
    await addToHistory({
      type: 'area',
      filename: `area-capture-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)}.png`,
      timestamp: Date.now()
    });
    
    showNotification('Area Captured!', 'Selected area saved');
    
  } catch (error) {
    console.error('Crop error:', error);
  }
}

function openEditor() {
  browserAPI.tabs.create({ url: 'editor.html' });
}

async function addToHistory(capture) {
  try {
    const result = await browserAPI.storage.local.get(['captureHistory']);
    const history = result.captureHistory || [];
    
    history.unshift(capture);
    
    if (history.length > 100) {
      history.pop();
    }
    
    await browserAPI.storage.local.set({ captureHistory: history });
  } catch (error) {
    console.error('History error:', error);
  }
}
