// Canvas setup
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const uploadArea = document.getElementById('uploadArea');
const fileInput = document.getElementById('fileInput');
const previewOverlay = document.getElementById('previewOverlay');
const sizeIndicator = document.getElementById('sizeIndicator');

let currentTool = 'draw';
let isDrawing = false;
let startX, startY;
let currentColor = '#ff0000';
let currentSize = 5;
// Undo history: snapshots of { base canvas, floating layers }.
// Canvas copies are fast to make and restore, unlike PNG data URLs.
const HISTORY_MAX_STATES = 50;
const HISTORY_MAX_BYTES = 512 * 1024 * 1024;
let history = [];
let historyStep = -1;
let originalState = null;
let documentName = `edited-${fileTimestamp()}`;
let tempCanvas = null;
// Image layers float over layerBase until another tool merges them.
let layers = [];
let layerBase = null;
let selectedLayer = null;
let isDraggingLayer = false;
let dragStartX = 0;
let dragStartY = 0;
let highlightPoints = [];
let pendingTextPosition = null;
let zoomLevel = null; // null means "fit to window"

// Tool selection
document.querySelectorAll('[data-tool]').forEach(btn => {
  btn.addEventListener('click', (e) => {
    const tool = e.target.closest('.tool-btn').dataset.tool;
    
    document.querySelectorAll('[data-tool]').forEach(b => b.classList.remove('active'));
    e.target.closest('.tool-btn').classList.add('active');
    currentTool = tool;
    
    if (tool === 'eyedropper') {
      canvas.style.cursor = 'crosshair';
    } else if (tool === 'move') {
      canvas.style.cursor = 'move';
    } else {
      canvas.style.cursor = 'crosshair';
    }
  });
});

// Color picker
const colorPicker = document.getElementById('colorPicker');
if (colorPicker) {
  colorPicker.addEventListener('change', (e) => {
    currentColor = e.target.value;
  });

  colorPicker.addEventListener('input', (e) => {
    currentColor = e.target.value;
  });
}

// Size slider
const sizeSlider = document.getElementById('sizeSlider');
const sizeLabel = document.getElementById('sizeLabel');
if (sizeSlider) {
  sizeSlider.addEventListener('input', (e) => {
    currentSize = parseInt(e.target.value);
    if (sizeLabel) sizeLabel.textContent = currentSize;
  });
}

// New canvas button
const btnNew = document.getElementById('btnNew');
if (btnNew) {
  btnNew.addEventListener('click', createNewCanvas);
}

function createNewCanvas() {
  const width = prompt('Canvas width (px):', '800');
  if (!width) return;
  
  const height = prompt('Canvas height (px):', '600');
  if (!height) return;
  
  const w = parseInt(width);
  const h = parseInt(height);
  
  if (isNaN(w) || isNaN(h) || w < 1 || h < 1) {
    alert('Invalid dimensions');
    return;
  }
  
  canvas.width = w;
  canvas.height = h;
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, w, h);
  
  startDocument(`image-${fileTimestamp()}`);
  showStatus(`New ${w}×${h}px canvas created`);
}

// Reset history and layers for a new image that is already on the canvas.
function startDocument(name) {
  uploadArea.style.display = 'none';
  canvas.style.display = 'block';
  documentName = name;
  layers = [];
  layerBase = null;
  history = [];
  historyStep = -1;
  zoomLevel = null;
  originalState = snapshot();
  saveState();
}

// File upload
const btnUpload = document.getElementById('btnUpload');
const btnOpenFile = document.getElementById('btnOpenFile');

if (btnUpload) btnUpload.addEventListener('click', () => fileInput.click());
if (btnOpenFile) btnOpenFile.addEventListener('click', () => fileInput.click());

if (fileInput) {
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      loadImage(file);
      fileInput.value = '';
    }
  });
}

// Drag and drop
if (uploadArea) {
  uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.style.borderColor = '#667eea';
  });

  uploadArea.addEventListener('dragleave', () => {
    uploadArea.style.borderColor = '#3a3a3a';
  });

  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.style.borderColor = '#3a3a3a';
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
      loadImage(file);
    }
  });
}

canvas.addEventListener('dragover', (e) => {
  e.preventDefault();
});

canvas.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) {
    addImageLayer(file);
  }
});

// Paste from clipboard
document.addEventListener('paste', (e) => {
  const items = e.clipboardData.items;
  for (let item of items) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (canvas.style.display === 'none') {
        loadImage(file);
      } else {
        addImageLayer(file);
      }
      break;
    }
  }
});

function loadImage(file) {
  const baseName = (file.name || '').replace(/\.[^.]+$/, '');
  const reader = new FileReader();
  reader.onload = (e) => {
    loadImageUrl(e.target.result, baseName ? `${baseName}-edited` : `image-${fileTimestamp()}`)
      .then(() => showStatus('Image loaded'));
  };
  reader.readAsDataURL(file);
}

function loadImageUrl(url, name) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      startDocument(name);
      resolve();
    };
    img.onerror = () => reject(new Error('The image could not be loaded.'));
    img.src = url;
  });
}

// Open a capture that the background page sent: editor.html?capture=<id>
async function loadCaptureFromUrl() {
  const id = new URLSearchParams(location.search).get('capture');
  if (!id) return;
  try {
    const capture = await browser.runtime.sendMessage({ action: 'getCapture', id });
    if (!capture) {
      showStatus('This capture is no longer available.');
      return;
    }
    await loadImageUrl(capture.dataUrl, capture.name);
    showStatus('Capture ready. Save (Ctrl+S) or copy (Ctrl+C) when done.');
  } catch (error) {
    console.error('Could not load capture:', error);
    showStatus('Could not load the capture.');
  }
}

function addImageLayer(file) {
  if (!hasImage()) {
    loadImage(file);
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      const x = (canvas.width - img.width) / 2;
      const y = (canvas.height - img.height) / 2;
      
      // The first layer keeps a copy of the pixels under all layers.
      if (layers.length === 0) layerBase = copyCanvas(canvas);
      layers.push({
        image: img,
        x: x,
        y: y,
        width: img.width,
        height: img.height
      });
      
      redrawCanvas();
      saveState();
      showStatus('Layer added! Use Move tool to reposition.');
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

// Draw the pixels under the layers, then the layers. The base holds all
// drawings and filters, so moving a layer does not erase them.
function redrawCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (layerBase) ctx.drawImage(layerBase, 0, 0);
  
  layers.forEach(layer => {
    ctx.drawImage(layer.image, layer.x, layer.y, layer.width, layer.height);
  });
}

// Merge the floating layers into the image. The canvas already shows
// them, so only the layer state changes. Call before any edit that is not
// a layer move.
function flattenLayers() {
  layers = [];
  layerBase = null;
  selectedLayer = null;
}

function copyCanvas(source) {
  const copy = document.createElement('canvas');
  copy.width = source.width;
  copy.height = source.height;
  copy.getContext('2d').drawImage(source, 0, 0);
  return copy;
}

function getCanvasCoordinates(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / canvas.clientWidth;
  const scaleY = canvas.height / canvas.clientHeight;
  
  return {
    x: (e.clientX - rect.left - canvas.clientLeft) * scaleX,
    y: (e.clientY - rect.top - canvas.clientTop) * scaleY
  };
}

canvas.addEventListener('mousedown', (e) => {
  const coords = getCanvasCoordinates(e);
  startX = coords.x;
  startY = coords.y;

  // Eye dropper tool
  if (currentTool === 'eyedropper') {
    const x = Math.floor(startX);
    const y = Math.floor(startY);
    if (x >= 0 && x < canvas.width && y >= 0 && y < canvas.height) {
      const imageData = ctx.getImageData(x, y, 1, 1);
      const r = imageData.data[0];
      const g = imageData.data[1];
      const b = imageData.data[2];
      const hexColor = '#' + [r, g, b].map(x => {
        const hex = x.toString(16);
        return hex.length === 1 ? '0' + hex : hex;
      }).join('');
      currentColor = hexColor;
      if (colorPicker) colorPicker.value = hexColor;
      showStatus(`Color picked: ${hexColor}`);
    }
    return;
  }

  // Move tool
  if (currentTool === 'move') {
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];
      if (startX >= layer.x && startX <= layer.x + layer.width &&
          startY >= layer.y && startY <= layer.y + layer.height) {
        selectedLayer = i;
        isDraggingLayer = true;
        dragStartX = startX - layer.x;
        dragStartY = startY - layer.y;
        return;
      }
    }
    return;
  }

  flattenLayers();
  isDrawing = true;

  if (currentTool === 'text') {
    showTextModal(startX, startY);
    isDrawing = false;
  } else if (currentTool === 'draw') {
    ctx.beginPath();
    ctx.moveTo(startX, startY);
  } else if (currentTool === 'highlight') {
    // Redraw the full stroke over a snapshot on each move, so the
    // transparency does not build up where the path overlaps itself.
    tempCanvas = copyCanvas(canvas);
    highlightPoints = [{ x: startX, y: startY }];
  } else if (currentTool === 'eraser') {
    if (!tempCanvas) {
      tempCanvas = document.createElement('canvas');
    }
    tempCanvas.width = canvas.width;
    tempCanvas.height = canvas.height;
    tempCanvas.getContext('2d').drawImage(canvas, 0, 0);
    
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineWidth = currentSize;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,1)';
    ctx.beginPath();
    ctx.moveTo(startX, startY);
  } else {
    if (!tempCanvas) {
      tempCanvas = document.createElement('canvas');
    }
    tempCanvas.width = canvas.width;
    tempCanvas.height = canvas.height;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.drawImage(canvas, 0, 0);
  }
});

canvas.addEventListener('mousemove', (e) => {
  const coords = getCanvasCoordinates(e);
  const currentX = coords.x;
  const currentY = coords.y;

  if (isDraggingLayer && selectedLayer !== null) {
    layers[selectedLayer].x = currentX - dragStartX;
    layers[selectedLayer].y = currentY - dragStartY;
    redrawCanvas();
    return;
  }

  if (!isDrawing) {
    if (sizeIndicator) sizeIndicator.style.display = 'none';
    return;
  }

  if (currentTool === 'draw') {
    ctx.strokeStyle = currentColor;
    ctx.lineWidth = currentSize;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineTo(currentX, currentY);
    ctx.stroke();
  } else if (currentTool === 'highlight') {
    highlightPoints.push({ x: currentX, y: currentY });
    drawHighlight();
  } else if (currentTool === 'eraser') {
    ctx.lineTo(currentX, currentY);
    ctx.stroke();
  } else if (currentTool === 'crop') {
    if (tempCanvas) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(tempCanvas, 0, 0);
    }
    
    const left = Math.min(startX, currentX);
    const top = Math.min(startY, currentY);
    const width = Math.abs(currentX - startX);
    const height = Math.abs(currentY - startY);
    
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(0, 0, canvas.width, top);
    ctx.fillRect(0, top, left, height);
    ctx.fillRect(left + width, top, canvas.width - left - width, height);
    ctx.fillRect(0, top + height, canvas.width, canvas.height - top - height);
    
    ctx.strokeStyle = '#667eea';
    ctx.lineWidth = 3;
    ctx.strokeRect(left, top, width, height);
    
    showSizeIndicator(left, top, width, height);
  } else if (currentTool === 'blur' || currentTool === 'pixelate') {
    if (tempCanvas) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(tempCanvas, 0, 0);
    }
    
    const left = Math.min(startX, currentX);
    const top = Math.min(startY, currentY);
    const width = Math.abs(currentX - startX);
    const height = Math.abs(currentY - startY);
    
    ctx.strokeStyle = '#667eea';
    ctx.lineWidth = 3;
    ctx.strokeRect(left, top, width, height);
    
    ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
    ctx.fillRect(0, 0, canvas.width, top);
    ctx.fillRect(0, top, left, height);
    ctx.fillRect(left + width, top, canvas.width - left - width, height);
    ctx.fillRect(0, top + height, canvas.width, canvas.height - top - height);
    
    showSizeIndicator(left, top, width, height);
  } else {
    if (tempCanvas) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(tempCanvas, 0, 0);
    }
    
    ctx.save();
    switch (currentTool) {
      case 'line':
        drawLine(startX, startY, currentX, currentY);
        break;
      case 'arrow':
        drawArrow(startX, startY, currentX, currentY);
        break;
      case 'doubleArrow':
        drawDoubleArrow(startX, startY, currentX, currentY);
        break;
      case 'rect':
        drawRect(startX, startY, currentX, currentY);
        break;
      case 'rectFilled':
        drawRectFilled(startX, startY, currentX, currentY);
        break;
      case 'circle':
        drawCircle(startX, startY, currentX, currentY);
        break;
      case 'circleFilled':
        drawCircleFilled(startX, startY, currentX, currentY);
        break;
      case 'star':
        drawStar(startX, startY, currentX, currentY);
        break;
    }
    ctx.restore();
    
    const left = Math.min(startX, currentX);
    const top = Math.min(startY, currentY);
    const width = Math.abs(currentX - startX);
    const height = Math.abs(currentY - startY);
    
    showSizeIndicator(left, top, width, height);
  }
});

function showSizeIndicator(left, top, width, height) {
  if (sizeIndicator) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width / canvas.width;
    const scaleY = rect.height / canvas.height;
    const displayX = left * scaleX;
    const displayY = top * scaleY;
    const displayW = width * scaleX;
    
    sizeIndicator.textContent = `${Math.round(width)} × ${Math.round(height)} px`;
    sizeIndicator.style.left = (rect.left + displayX + displayW + 10) + 'px';
    sizeIndicator.style.top = (rect.top + displayY) + 'px';
    sizeIndicator.style.display = 'block';
  }
}

canvas.addEventListener('mouseup', (e) => {
  if (isDraggingLayer) {
    isDraggingLayer = false;
    selectedLayer = null;
    saveState();
    return;
  }

  if (!isDrawing) return;
  
  const coords = getCanvasCoordinates(e);
  const endX = coords.x;
  const endY = coords.y;

  if (sizeIndicator) sizeIndicator.style.display = 'none';

  if (currentTool === 'draw') {
    ctx.lineTo(endX, endY);
    ctx.stroke();
    saveState();
  } else if (currentTool === 'highlight') {
    highlightPoints.push({ x: endX, y: endY });
    drawHighlight();
    highlightPoints = [];
    saveState();
  } else if (currentTool === 'eraser') {
    ctx.lineTo(endX, endY);
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
    saveState();
  } else {
    if (tempCanvas) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(tempCanvas, 0, 0);
    }
    
    switch (currentTool) {
      case 'line':
        drawLine(startX, startY, endX, endY);
        break;
      case 'arrow':
        drawArrow(startX, startY, endX, endY);
        break;
      case 'doubleArrow':
        drawDoubleArrow(startX, startY, endX, endY);
        break;
      case 'rect':
        drawRect(startX, startY, endX, endY);
        break;
      case 'rectFilled':
        drawRectFilled(startX, startY, endX, endY);
        break;
      case 'circle':
        drawCircle(startX, startY, endX, endY);
        break;
      case 'circleFilled':
        drawCircleFilled(startX, startY, endX, endY);
        break;
      case 'star':
        drawStar(startX, startY, endX, endY);
        break;
      case 'blur':
        drawBlur(startX, startY, endX, endY);
        break;
      case 'pixelate':
        drawPixelate(startX, startY, endX, endY);
        break;
      case 'crop':
        cropImage(startX, startY, endX, endY);
        break;
    }
    
    saveState();
  }

  isDrawing = false;
});

canvas.addEventListener('mouseleave', () => {
  if (isDrawing) {
    if (currentTool === 'eraser') {
      ctx.globalCompositeOperation = 'source-over';
    } else if (currentTool === 'highlight') {
      highlightPoints = [];
    }
    if (currentTool === 'draw' || currentTool === 'eraser' || currentTool === 'highlight') {
      saveState();
    } else if (tempCanvas) {
      // Remove the shape preview that was not finished.
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(tempCanvas, 0, 0);
    }
  }
  isDrawing = false;
  isDraggingLayer = false;
  if (sizeIndicator) sizeIndicator.style.display = 'none';
});

function drawHighlight() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(tempCanvas, 0, 0);
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = currentColor;
  ctx.lineWidth = currentSize * 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(highlightPoints[0].x, highlightPoints[0].y);
  highlightPoints.forEach(point => ctx.lineTo(point.x, point.y));
  ctx.stroke();
  ctx.restore();
}

function normalizeRect(x1, y1, x2, y2) {
  const left = Math.max(0, Math.round(Math.min(x1, x2)));
  const top = Math.max(0, Math.round(Math.min(y1, y2)));
  const right = Math.min(canvas.width, Math.round(Math.max(x1, x2)));
  const bottom = Math.min(canvas.height, Math.round(Math.max(y1, y2)));
  return { left, top, width: right - left, height: bottom - top };
}

// Drawing functions
function drawLine(x1, y1, x2, y2) {
  ctx.strokeStyle = currentColor;
  ctx.lineWidth = currentSize;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function drawArrow(x1, y1, x2, y2) {
  const headlen = 15 + currentSize;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx.strokeStyle = currentColor;
  ctx.lineWidth = currentSize;
  ctx.fillStyle = currentColor;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - headlen * Math.cos(angle - Math.PI / 6), y2 - headlen * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(x2 - headlen * Math.cos(angle + Math.PI / 6), y2 - headlen * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}

function drawDoubleArrow(x1, y1, x2, y2) {
  const headlen = 15 + currentSize;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx.strokeStyle = currentColor;
  ctx.lineWidth = currentSize;
  ctx.fillStyle = currentColor;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - headlen * Math.cos(angle - Math.PI / 6), y2 - headlen * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(x2 - headlen * Math.cos(angle + Math.PI / 6), y2 - headlen * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 + headlen * Math.cos(angle - Math.PI / 6), y1 + headlen * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(x1 + headlen * Math.cos(angle + Math.PI / 6), y1 + headlen * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}

function drawRect(x1, y1, x2, y2) {
  ctx.strokeStyle = currentColor;
  ctx.lineWidth = currentSize;
  ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
}

function drawRectFilled(x1, y1, x2, y2) {
  ctx.fillStyle = currentColor;
  ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
}

function drawCircle(x1, y1, x2, y2) {
  const radius = Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
  ctx.strokeStyle = currentColor;
  ctx.lineWidth = currentSize;
  ctx.beginPath();
  ctx.arc(x1, y1, radius, 0, 2 * Math.PI);
  ctx.stroke();
}

function drawCircleFilled(x1, y1, x2, y2) {
  const radius = Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
  ctx.fillStyle = currentColor;
  ctx.beginPath();
  ctx.arc(x1, y1, radius, 0, 2 * Math.PI);
  ctx.fill();
}

function drawStar(x1, y1, x2, y2) {
  const radius = Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
  const spikes = 5;
  const outerRadius = radius;
  const innerRadius = radius / 2;
  ctx.strokeStyle = currentColor;
  ctx.fillStyle = currentColor;
  ctx.lineWidth = currentSize;
  ctx.beginPath();
  for (let i = 0; i < spikes * 2; i++) {
    const angle = (i * Math.PI) / spikes - Math.PI / 2;
    const r = i % 2 === 0 ? outerRadius : innerRadius;
    const x = x1 + r * Math.cos(angle);
    const y = y1 + r * Math.sin(angle);
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.closePath();
  ctx.stroke();
  ctx.fill();
}

// Gaussian blur. The strength follows the Size slider.
function drawBlur(x1, y1, x2, y2) {
  const { left, top, width, height } = normalizeRect(x1, y1, x2, y2);
  if (width < 1 || height < 1) return;
  const radius = Math.max(4, currentSize * 2);
  // Blur a larger area so the edges of the selection blur evenly.
  const pad = radius * 2;
  const sx = Math.max(0, left - pad);
  const sy = Math.max(0, top - pad);
  const sw = Math.min(canvas.width, left + width + pad) - sx;
  const sh = Math.min(canvas.height, top + height + pad) - sy;

  const blurred = document.createElement('canvas');
  blurred.width = sw;
  blurred.height = sh;
  const blurCtx = blurred.getContext('2d');
  blurCtx.filter = `blur(${radius}px)`;
  blurCtx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);

  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, width, height);
  ctx.clip();
  ctx.drawImage(blurred, sx, sy);
  ctx.restore();
}

// Pixelate. The block size follows the Size slider.
function drawPixelate(x1, y1, x2, y2) {
  const { left, top, width, height } = normalizeRect(x1, y1, x2, y2);
  if (width < 1 || height < 1) return;
  const block = Math.max(4, currentSize * 2);
  const small = document.createElement('canvas');
  small.width = Math.max(1, Math.round(width / block));
  small.height = Math.max(1, Math.round(height / block));
  small.getContext('2d').drawImage(canvas, left, top, width, height, 0, 0, small.width, small.height);

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, small.width, small.height, left, top, width, height);
  ctx.restore();
}

function cropImage(x1, y1, x2, y2) {
  const { left, top, width, height } = normalizeRect(x1, y1, x2, y2);
  if (width < 10 || height < 10) return;
  const imageData = ctx.getImageData(left, top, width, height);
  canvas.width = width;
  canvas.height = height;
  ctx.putImageData(imageData, 0, 0);
  showStatus('Image cropped');
}

const btnResize = document.getElementById('btnResize');
if (btnResize) {
  btnResize.addEventListener('click', () => {
    const keepRatio = confirm('Keep aspect ratio?\n\nOK = keep proportions\nCancel = custom size');
    
    if (keepRatio) {
      const newWidth = prompt('Enter new width (current: ' + canvas.width + 'px):');
      if (!newWidth) return;
      
      const width = parseInt(newWidth);
      if (isNaN(width) || width < 1) {
        alert('Invalid width');
        return;
      }
      
      const ratio = canvas.height / canvas.width;
      const height = Math.round(width * ratio);
      
      resizeCanvas(width, height);
    } else {
      const newWidth = prompt('Enter new width (current: ' + canvas.width + 'px):');
      if (!newWidth) return;
      
      const newHeight = prompt('Enter new height (current: ' + canvas.height + 'px):');
      if (!newHeight) return;
      
      const width = parseInt(newWidth);
      const height = parseInt(newHeight);
      
      if (isNaN(width) || isNaN(height) || width < 1 || height < 1) {
        alert('Invalid dimensions');
        return;
      }
      
      resizeCanvas(width, height);
    }
  });
}

function resizeCanvas(width, height) {
  flattenLayers();
  const temp = document.createElement('canvas');
  temp.width = canvas.width;
  temp.height = canvas.height;
  temp.getContext('2d').drawImage(canvas, 0, 0);
  
  canvas.width = width;
  canvas.height = height;
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(temp, 0, 0, width, height);
  
  saveState();
  showStatus(`Resized to ${width} × ${height}px`);
}

const btnWatermark = document.getElementById('btnWatermark');
if (btnWatermark) {
  btnWatermark.addEventListener('click', () => {
    const text = prompt('Enter watermark text:');
    if (!text) return;
    flattenLayers();
    
    const size = Math.max(20, Math.min(canvas.width, canvas.height) / 20);
    
    ctx.save();
    ctx.font = `${size}px Arial`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    
    const padding = 20;
    ctx.fillText(text, canvas.width - padding, canvas.height - padding);
    
    ctx.restore();
    saveState();
    showStatus('Watermark added');
  });
}

const btnRotate = document.getElementById('btnRotate');
if (btnRotate) {
  btnRotate.addEventListener('click', () => {
    const angle = prompt('Rotate angle (90, 180, 270, or custom):', '90');
    if (!angle) return;
    
    const deg = parseInt(angle);
    if (isNaN(deg)) {
      alert('Invalid angle');
      return;
    }
    
    rotateCanvas(deg);
  });
}

// Any angle. The canvas grows to the rotated bounding box, so no corner
// is clipped. New corner areas are transparent.
function rotateCanvas(degrees) {
  flattenLayers();
  const temp = copyCanvas(canvas);
  const radians = (degrees * Math.PI) / 180;
  const sin = Math.abs(Math.sin(radians));
  const cos = Math.abs(Math.cos(radians));
  
  canvas.width = Math.max(1, Math.round(temp.width * cos + temp.height * sin));
  canvas.height = Math.max(1, Math.round(temp.width * sin + temp.height * cos));
  
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(radians);
  ctx.drawImage(temp, -temp.width / 2, -temp.height / 2);
  ctx.restore();
  
  saveState();
  showStatus(`Rotated ${degrees}°`);
}

const btnFlip = document.getElementById('btnFlip');
if (btnFlip) {
  btnFlip.addEventListener('click', () => {
    const direction = confirm('OK = Flip Horizontal\nCancel = Flip Vertical');
    flipCanvas(direction ? 'horizontal' : 'vertical');
  });
}

function flipCanvas(direction) {
  flattenLayers();
  const temp = document.createElement('canvas');
  temp.width = canvas.width;
  temp.height = canvas.height;
  temp.getContext('2d').drawImage(canvas, 0, 0);
  
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  
  if (direction === 'horizontal') {
    ctx.scale(-1, 1);
    ctx.drawImage(temp, -canvas.width, 0);
  } else {
    ctx.scale(1, -1);
    ctx.drawImage(temp, 0, -canvas.height);
  }
  
  ctx.restore();
  saveState();
  showStatus(`Flipped ${direction}`);
}

const btnBrightness = document.getElementById('btnBrightness');
if (btnBrightness) {
  btnBrightness.addEventListener('click', () => {
    showSliderModal('Brightness', -100, 100, 0, adjustBrightness);
  });
}

const btnContrast = document.getElementById('btnContrast');
if (btnContrast) {
  btnContrast.addEventListener('click', () => {
    showSliderModal('Contrast', -100, 100, 0, adjustContrast);
  });
}

const btnSaturate = document.getElementById('btnSaturate');
if (btnSaturate) {
  btnSaturate.addEventListener('click', () => {
    showSliderModal('Saturation', -100, 100, 0, adjustSaturation);
  });
}

let currentSliderCallback = null;
let originalImageData = null;

function showSliderModal(title, min, max, initial, callback) {
  const modal = document.getElementById('sliderModal');
  const backdrop = document.getElementById('modalBackdrop');
  const sliderTitle = document.getElementById('sliderTitle');
  const slider = document.getElementById('adjustSlider');
  const label = document.getElementById('sliderLabel');
  
  if (!modal || !backdrop) return;
  
  flattenLayers();
  originalImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  
  sliderTitle.textContent = title;
  slider.min = min;
  slider.max = max;
  slider.value = initial;
  label.textContent = `Value: ${initial}`;
  
  currentSliderCallback = callback;
  
  modal.classList.add('active');
  backdrop.classList.add('active');
  
  slider.oninput = (e) => {
    const value = parseInt(e.target.value);
    label.textContent = `Value: ${value}`;
    
    ctx.putImageData(originalImageData, 0, 0);
    callback(value);
  };
}

function closeSliderModal(apply) {
  const modal = document.getElementById('sliderModal');
  const backdrop = document.getElementById('modalBackdrop');
  
  if (!apply && originalImageData) {
    ctx.putImageData(originalImageData, 0, 0);
  } else if (apply) {
    saveState();
  }
  
  modal.classList.remove('active');
  backdrop.classList.remove('active');
  currentSliderCallback = null;
  originalImageData = null;
}

const btnApplyAdjust = document.getElementById('btnApplyAdjust');
const btnCancelAdjust = document.getElementById('btnCancelAdjust');

if (btnApplyAdjust) {
  btnApplyAdjust.addEventListener('click', () => closeSliderModal(true));
}

if (btnCancelAdjust) {
  btnCancelAdjust.addEventListener('click', () => closeSliderModal(false));
}

function adjustBrightness(value) {
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = imageData.data;
  
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = Math.max(0, Math.min(255, pixels[i] + value));
    pixels[i + 1] = Math.max(0, Math.min(255, pixels[i + 1] + value));
    pixels[i + 2] = Math.max(0, Math.min(255, pixels[i + 2] + value));
  }
  
  ctx.putImageData(imageData, 0, 0);
}

function adjustContrast(value) {
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = imageData.data;
  
  const factor = (259 * (value + 255)) / (255 * (259 - value));
  
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = Math.max(0, Math.min(255, factor * (pixels[i] - 128) + 128));
    pixels[i + 1] = Math.max(0, Math.min(255, factor * (pixels[i + 1] - 128) + 128));
    pixels[i + 2] = Math.max(0, Math.min(255, factor * (pixels[i + 2] - 128) + 128));
  }
  
  ctx.putImageData(imageData, 0, 0);
}

function adjustSaturation(value) {
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = imageData.data;
  
  const factor = (value + 100) / 100;
  
  for (let i = 0; i < pixels.length; i += 4) {
    const gray = 0.2989 * pixels[i] + 0.5870 * pixels[i + 1] + 0.1140 * pixels[i + 2];
    pixels[i] = Math.max(0, Math.min(255, gray + factor * (pixels[i] - gray)));
    pixels[i + 1] = Math.max(0, Math.min(255, gray + factor * (pixels[i + 1] - gray)));
    pixels[i + 2] = Math.max(0, Math.min(255, gray + factor * (pixels[i + 2] - gray)));
  }
  
  ctx.putImageData(imageData, 0, 0);
}

const btnGrayscale = document.getElementById('btnGrayscale');
if (btnGrayscale) {
  btnGrayscale.addEventListener('click', () => {
    applyGrayscale();
  });
}

function applyGrayscale() {
  flattenLayers();
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = imageData.data;
  
  for (let i = 0; i < pixels.length; i += 4) {
    const gray = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
    pixels[i] = gray;
    pixels[i + 1] = gray;
    pixels[i + 2] = gray;
  }
  
  ctx.putImageData(imageData, 0, 0);
  saveState();
  showStatus('Grayscale applied');
}

const btnSepia = document.getElementById('btnSepia');
if (btnSepia) {
  btnSepia.addEventListener('click', () => {
    applySepia();
  });
}

function applySepia() {
  flattenLayers();
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = imageData.data;
  
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    
    pixels[i] = Math.min(255, r * 0.393 + g * 0.769 + b * 0.189);
    pixels[i + 1] = Math.min(255, r * 0.349 + g * 0.686 + b * 0.168);
    pixels[i + 2] = Math.min(255, r * 0.272 + g * 0.534 + b * 0.131);
  }
  
  ctx.putImageData(imageData, 0, 0);
  saveState();
  showStatus('Sepia applied');
}

const btnInvert = document.getElementById('btnInvert');
if (btnInvert) {
  btnInvert.addEventListener('click', () => {
    applyInvert();
  });
}

function applyInvert() {
  flattenLayers();
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = imageData.data;
  
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 255 - pixels[i];
    pixels[i + 1] = 255 - pixels[i + 1];
    pixels[i + 2] = 255 - pixels[i + 2];
  }
  
  ctx.putImageData(imageData, 0, 0);
  saveState();
  showStatus('Colors inverted');
}

const btnSharpen = document.getElementById('btnSharpen');
if (btnSharpen) {
  btnSharpen.addEventListener('click', () => {
    applySharpen();
  });
}

function applySharpen() {
  flattenLayers();
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = imageData.data;
  const width = canvas.width;
  const height = canvas.height;
  
  const kernel = [
    0, -1, 0,
    -1, 5, -1,
    0, -1, 0
  ];
  
  const tempPixels = new Uint8ClampedArray(pixels);
  
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const idx = ((y + ky) * width + (x + kx)) * 4 + c;
            const kidx = (ky + 1) * 3 + (kx + 1);
            sum += tempPixels[idx] * kernel[kidx];
          }
        }
        pixels[(y * width + x) * 4 + c] = Math.max(0, Math.min(255, sum));
      }
    }
  }
  
  ctx.putImageData(imageData, 0, 0);
  saveState();
  showStatus('Sharpened');
}

const btnVintage = document.getElementById('btnVintage');
if (btnVintage) {
  btnVintage.addEventListener('click', () => {
    applyVintage();
  });
}

function applyVintage() {
  flattenLayers();
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = imageData.data;
  
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    
    let nr = r * 0.393 + g * 0.769 + b * 0.189;
    let ng = r * 0.349 + g * 0.686 + b * 0.168;
    let nb = r * 0.272 + g * 0.534 + b * 0.131;
    
    const gray = 0.299 * nr + 0.587 * ng + 0.114 * nb;
    nr = gray + 0.6 * (nr - gray);
    ng = gray + 0.6 * (ng - gray);
    nb = gray + 0.6 * (nb - gray);
    
    pixels[i] = Math.min(255, nr);
    pixels[i + 1] = Math.min(255, ng);
    pixels[i + 2] = Math.min(255, nb);
  }
  
  ctx.putImageData(imageData, 0, 0);
  saveState();
  showStatus('Vintage filter applied');
}

const btnVignette = document.getElementById('btnVignette');
if (btnVignette) {
  btnVignette.addEventListener('click', () => {
    applyVignette();
  });
}

function applyVignette() {
  flattenLayers();
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = imageData.data;
  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;
  const maxDistance = Math.sqrt(centerX * centerX + centerY * centerY);
  
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const dx = x - centerX;
      const dy = y - centerY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const factor = Math.max(0, 1 - (distance / maxDistance) * 1.2);
      
      const i = (y * canvas.width + x) * 4;
      pixels[i] *= factor;
      pixels[i + 1] *= factor;
      pixels[i + 2] *= factor;
    }
  }
  
  ctx.putImageData(imageData, 0, 0);
  saveState();
  showStatus('Vignette applied');
}

const btnNoise = document.getElementById('btnNoise');
if (btnNoise) {
  btnNoise.addEventListener('click', () => {
    applyNoise();
  });
}

function applyNoise() {
  flattenLayers();
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = imageData.data;
  const amount = 25;
  
  for (let i = 0; i < pixels.length; i += 4) {
    const noise = (Math.random() - 0.5) * amount;
    pixels[i] = Math.max(0, Math.min(255, pixels[i] + noise));
    pixels[i + 1] = Math.max(0, Math.min(255, pixels[i + 1] + noise));
    pixels[i + 2] = Math.max(0, Math.min(255, pixels[i + 2] + noise));
  }
  
  ctx.putImageData(imageData, 0, 0);
  saveState();
  showStatus('Noise added');
}

const btnAddImage = document.getElementById('btnAddImage');
if (btnAddImage) {
  btnAddImage.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (file) addImageLayer(file);
    };
    input.click();
  });
}

const btnRemoveBg = document.getElementById('btnRemoveBg');
if (btnRemoveBg) {
  btnRemoveBg.addEventListener('click', () => {
    const tolerance = prompt('Enter tolerance (0-255):', '30');
    if (!tolerance) return;
    
    const tol = parseInt(tolerance);
    if (isNaN(tol) || tol < 0 || tol > 255) {
      alert('Invalid tolerance');
      return;
    }
    
    removeBackground(tol);
  });
}

function removeBackground(tolerance) {
  flattenLayers();
  try {
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = imageData.data;
    
    const samples = [
      [0, 0],
      [canvas.width - 1, 0],
      [0, canvas.height - 1],
      [canvas.width - 1, canvas.height - 1],
      [Math.floor(canvas.width / 2), 0],
      [Math.floor(canvas.width / 2), canvas.height - 1],
      [0, Math.floor(canvas.height / 2)],
      [canvas.width - 1, Math.floor(canvas.height / 2)]
    ];
    
    let bgR = 0, bgG = 0, bgB = 0;
    samples.forEach(([x, y]) => {
      const i = (y * canvas.width + x) * 4;
      bgR += pixels[i];
      bgG += pixels[i + 1];
      bgB += pixels[i + 2];
    });
    
    bgR = Math.floor(bgR / samples.length);
    bgG = Math.floor(bgG / samples.length);
    bgB = Math.floor(bgB / samples.length);
    
    // Flood fill from the edges. Typed arrays and numeric pixel indices
    // keep this fast and small on large screenshots.
    const width = canvas.width;
    const height = canvas.height;
    const removed = new Uint8Array(width * height);
    const queued = new Uint8Array(width * height);
    const stack = [];
    const push = (index) => {
      if (!queued[index]) {
        queued[index] = 1;
        stack.push(index);
      }
    };
    
    for (let x = 0; x < width; x++) {
      push(x);
      push((height - 1) * width + x);
    }
    for (let y = 0; y < height; y++) {
      push(y * width);
      push(y * width + width - 1);
    }
    
    const toleranceSq = tolerance * tolerance;
    while (stack.length > 0) {
      const index = stack.pop();
      const i = index * 4;
      const dr = pixels[i] - bgR;
      const dg = pixels[i + 1] - bgG;
      const db = pixels[i + 2] - bgB;
      if (dr * dr + dg * dg + db * db >= toleranceSq) continue;
      
      removed[index] = 1;
      const x = index % width;
      if (x > 0) push(index - 1);
      if (x < width - 1) push(index + 1);
      if (index >= width) push(index - width);
      if (index < width * (height - 1)) push(index + width);
    }
    
    // Edge smoothing: a kept pixel next to removed pixels gets partial
    // alpha, in proportion to the kept pixels around it.
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = y * width + x;
        if (removed[index]) {
          pixels[index * 4 + 3] = 0;
          continue;
        }
        let kept = 0;
        let total = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= width) continue;
            total++;
            if (!removed[ny * width + nx]) kept++;
          }
        }
        if (kept < total) {
          pixels[index * 4 + 3] = Math.round(pixels[index * 4 + 3] * kept / total);
        }
      }
    }
    
    ctx.putImageData(imageData, 0, 0);
    saveState();
    showStatus('Background removed with edge smoothing');
  } catch (error) {
    console.error('Remove bg error:', error);
    showStatus('Failed to remove background');
  }
}

function showTextModal(x, y) {
  const backdrop = document.getElementById('modalBackdrop');
  const modal = document.getElementById('textModal');
  const textInput = document.getElementById('textInput');
  
  if (!backdrop || !modal || !textInput) return;
  
  pendingTextPosition = { x, y };
  backdrop.classList.add('active');
  modal.classList.add('active');
  textInput.value = '';
  textInput.focus();
}

// One listener for the whole page. The old code added a listener per
// click and never removed it when the modal closed without text.
function addPendingText() {
  const text = document.getElementById('textInput').value;
  if (text && pendingTextPosition) {
    ctx.font = `${currentSize * 4}px Arial`;
    ctx.fillStyle = currentColor;
    ctx.fillText(text, pendingTextPosition.x, pendingTextPosition.y);
    saveState();
  }
  closeTextModal();
}

document.getElementById('btnAddText').addEventListener('click', addPendingText);

function closeTextModal() {
  const backdrop = document.getElementById('modalBackdrop');
  const modal = document.getElementById('textModal');
  if (backdrop) backdrop.classList.remove('active');
  if (modal) modal.classList.remove('active');
  pendingTextPosition = null;
}

const modalBackdrop = document.getElementById('modalBackdrop');
if (modalBackdrop) {
  modalBackdrop.addEventListener('click', closeTextModal);
}

const textInput = document.getElementById('textInput');
if (textInput) {
  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      addPendingText();
    } else if (e.key === 'Escape') {
      closeTextModal();
    }
  });
}

function snapshot() {
  return {
    base: copyCanvas(layers.length ? layerBase : canvas),
    layers: layers.map(layer => ({ ...layer }))
  };
}

function applySnapshot(state) {
  canvas.width = state.base.width;
  canvas.height = state.base.height;
  ctx.drawImage(state.base, 0, 0);
  layers = state.layers.map(layer => ({ ...layer }));
  layerBase = layers.length ? copyCanvas(state.base) : null;
  if (layers.length) redrawCanvas();
  applyZoom();
}

function stateBytes(state) {
  return state.base.width * state.base.height * 4;
}

function saveState() {
  // A new edit removes the redo steps.
  history.length = historyStep + 1;
  history.push(snapshot());
  historyStep = history.length - 1;

  let bytes = history.reduce((sum, state) => sum + stateBytes(state), 0);
  while (history.length > 2 && (history.length > HISTORY_MAX_STATES || bytes > HISTORY_MAX_BYTES)) {
    bytes -= stateBytes(history.shift());
    historyStep--;
  }
  applyZoom();
}

function undo() {
  if (historyStep > 0) {
    historyStep--;
    applySnapshot(history[historyStep]);
    showStatus('Undo');
  }
}

function redo() {
  if (historyStep < history.length - 1) {
    historyStep++;
    applySnapshot(history[historyStep]);
    showStatus('Redo');
  }
}

const btnUndo = document.getElementById('btnUndo');
const btnRedo = document.getElementById('btnRedo');
if (btnUndo) btnUndo.addEventListener('click', undo);
if (btnRedo) btnRedo.addEventListener('click', redo);

document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  if (e.target.tagName === 'INPUT') return;
  const key = e.key.toLowerCase();
  if (key === 'z' && !e.shiftKey) {
    e.preventDefault();
    undo();
  } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
    e.preventDefault();
    redo();
  } else if (key === 's') {
    e.preventDefault();
    saveImage(e.shiftKey);
  } else if (key === 'c' && !e.shiftKey && !String(window.getSelection())) {
    e.preventDefault();
    copyImage();
  }
});

const btnClear = document.getElementById('btnClear');
if (btnClear) {
  btnClear.addEventListener('click', () => {
    if (!originalState) return;
    if (confirm('Revert to the original image? You can undo this.')) {
      applySnapshot(originalState);
      saveState();
      showStatus('Reverted to the original image');
    }
  });
}

const btnSave = document.getElementById('btnSave');
if (btnSave) {
  btnSave.addEventListener('click', () => saveImage());
}

function hasImage() {
  return canvas.style.display !== 'none';
}

// Save with the format, folder and Save As settings from the options page.
async function saveImage(forceSaveAs = false) {
  if (!hasImage()) return;
  try {
    const settings = await getSettings();
    const blob = await encodeCanvas(canvas, settings.imageFormat, settings.jpegQuality);
    const filename = buildFilename(documentName, extensionForMimeType(blob.type), settings.downloadFolder);
    const downloadId = await downloadBlob(blob, filename, forceSaveAs || settings.saveAs);
    if (downloadId !== null) showStatus(`Saved: ${filename}`);
  } catch (error) {
    console.error('Save failed:', error);
    showStatus(`Save failed: ${error.message}`);
  }
}

async function copyImage() {
  if (!hasImage()) return;
  try {
    await copyImageBlob(await encodeCanvas(canvas, 'png'));
    showStatus('Image copied to the clipboard');
  } catch (error) {
    console.error('Copy failed:', error);
    showStatus(`Copy failed: ${error.message}`);
  }
}

const btnSaveAs = document.getElementById('btnSaveAs');
if (btnSaveAs) btnSaveAs.addEventListener('click', () => saveImage(true));
const btnCopy = document.getElementById('btnCopy');
if (btnCopy) btnCopy.addEventListener('click', copyImage);

// Zoom: null fits the image in the window (never larger than 100%).
const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4];

function fitZoom() {
  const container = canvas.parentElement;
  const style = getComputedStyle(container);
  const availableWidth = container.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const availableHeight = container.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  return Math.min(1, availableWidth / canvas.width, availableHeight / canvas.height);
}

function currentZoom() {
  return zoomLevel === null ? fitZoom() : zoomLevel;
}

function applyZoom() {
  const zoom = currentZoom();
  canvas.style.width = `${Math.max(1, Math.round(canvas.width * zoom))}px`;
  canvas.style.height = `${Math.max(1, Math.round(canvas.height * zoom))}px`;
  const zoomLabel = document.getElementById('zoomLabel');
  if (zoomLabel) zoomLabel.textContent = zoomLevel === null ? `Fit ${Math.round(zoom * 100)}%` : `${Math.round(zoom * 100)}%`;
}

function stepZoom(direction) {
  const zoom = currentZoom();
  const next = direction > 0
    ? ZOOM_STEPS.find(step => step > zoom + 0.001)
    : [...ZOOM_STEPS].reverse().find(step => step < zoom - 0.001);
  if (next) {
    zoomLevel = next;
    applyZoom();
  }
}

document.getElementById('btnZoomIn').addEventListener('click', () => stepZoom(1));
document.getElementById('btnZoomOut').addEventListener('click', () => stepZoom(-1));
document.getElementById('btnZoomFit').addEventListener('click', () => { zoomLevel = null; applyZoom(); });
document.getElementById('btnZoomActual').addEventListener('click', () => { zoomLevel = 1; applyZoom(); });
window.addEventListener('resize', () => { if (zoomLevel === null) applyZoom(); });

function showStatus(message) {
  const status = document.getElementById('status');
  if (status) {
    status.textContent = message;
    status.classList.add('show');
    setTimeout(() => {
      status.classList.remove('show');
    }, 2000);
  }
}

loadCaptureFromUrl();
