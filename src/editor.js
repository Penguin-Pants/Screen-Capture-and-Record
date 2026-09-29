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
let history = [];
let historyStep = -1;
let currentImage = null;
let tempCanvas = null;
let layers = [];
let selectedLayer = null;
let isDraggingLayer = false;
let dragStartX = 0;
let dragStartY = 0;

// All tools are now unlocked - remove premium checks
function updatePremiumButtons() {
  // Remove all premium locks
  document.querySelectorAll('.tool-btn.premium').forEach(btn => {
    btn.classList.remove('premium', 'locked');
    btn.title = '';
  });
}

// Initialize - unlock all tools
updatePremiumButtons();

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
  
  uploadArea.style.display = 'none';
  canvas.style.display = 'block';
  
  currentImage = null;
  history = [];
  historyStep = -1;
  layers = [];
  saveState();
  showStatus(`New ${w}×${h}px canvas created`);
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
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      currentImage = img;
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      
      uploadArea.style.display = 'none';
      canvas.style.display = 'block';
      
      history = [];
      historyStep = -1;
      layers = [];
      saveState();
      showStatus('Image loaded successfully!');
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function addImageLayer(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      const x = (canvas.width - img.width) / 2;
      const y = (canvas.height - img.height) / 2;
      
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

function redrawCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (currentImage) {
    ctx.drawImage(currentImage, 0, 0);
  } else {
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  
  layers.forEach(layer => {
    ctx.drawImage(layer.image, layer.x, layer.y, layer.width, layer.height);
  });
}

function getCanvasCoordinates(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY
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

  isDrawing = true;

  if (currentTool === 'text') {
    showTextModal(startX, startY);
    isDrawing = false;
  } else if (currentTool === 'draw') {
    ctx.beginPath();
    ctx.moveTo(startX, startY);
  } else if (currentTool === 'highlight') {
    ctx.globalAlpha = 0.3;
    ctx.strokeStyle = currentColor;
    ctx.lineWidth = currentSize * 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(startX, startY);
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
    ctx.strokeStyle = currentColor;
    ctx.lineWidth = currentSize * 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineTo(currentX, currentY);
    ctx.stroke();
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
    ctx.lineTo(endX, endY);
    ctx.stroke();
    ctx.globalAlpha = 1.0;
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
      ctx.globalAlpha = 1.0;
    }
    if (currentTool === 'draw' || currentTool === 'eraser' || currentTool === 'highlight') {
      saveState();
    }
  }
  isDrawing = false;
  isDraggingLayer = false;
  if (sizeIndicator) sizeIndicator.style.display = 'none';
});

// Drawing functions (same as before - keeping them for brevity)
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

function drawBlur(x1, y1, x2, y2) {
  const width = Math.round(Math.abs(x2 - x1));
  const height = Math.round(Math.abs(y2 - y1));
  const startX = Math.round(Math.min(x1, x2));
  const startY = Math.round(Math.min(y1, y2));
  if (width < 1 || height < 1) return;
  try {
    const imageData = ctx.getImageData(startX, startY, width, height);
    const pixels = imageData.data;
    const pixelSize = 10;
    for (let y = 0; y < height; y += pixelSize) {
      for (let x = 0; x < width; x += pixelSize) {
        let r = 0, g = 0, b = 0, count = 0;
        for (let py = 0; py < pixelSize && y + py < height; py++) {
          for (let px = 0; px < pixelSize && x + px < width; px++) {
            const i = ((y + py) * width + (x + px)) * 4;
            r += pixels[i];
            g += pixels[i + 1];
            b += pixels[i + 2];
            count++;
          }
        }
        r = Math.floor(r / count);
        g = Math.floor(g / count);
        b = Math.floor(b / count);
        for (let py = 0; py < pixelSize && y + py < height; py++) {
          for (let px = 0; px < pixelSize && x + px < width; px++) {
            const i = ((y + py) * width + (x + px)) * 4;
            pixels[i] = r;
            pixels[i + 1] = g;
            pixels[i + 2] = b;
          }
        }
      }
    }
    ctx.putImageData(imageData, startX, startY);
  } catch (error) {
    console.error('Blur error:', error);
    showStatus('Blur failed - area too large');
  }
}

function drawPixelate(x1, y1, x2, y2) {
  const width = Math.round(Math.abs(x2 - x1));
  const height = Math.round(Math.abs(y2 - y1));
  const startX = Math.round(Math.min(x1, x2));
  const startY = Math.round(Math.min(y1, y2));
  if (width < 1 || height < 1) return;
  try {
    const imageData = ctx.getImageData(startX, startY, width, height);
    const pixels = imageData.data;
    const pixelSize = 20;
    for (let y = 0; y < height; y += pixelSize) {
      for (let x = 0; x < width; x += pixelSize) {
        const pixelIndex = (y * width + x) * 4;
        const r = pixels[pixelIndex];
        const g = pixels[pixelIndex + 1];
        const b = pixels[pixelIndex + 2];
        for (let py = 0; py < pixelSize && y + py < height; py++) {
          for (let px = 0; px < pixelSize && x + px < width; px++) {
            const i = ((y + py) * width + (x + px)) * 4;
            pixels[i] = r;
            pixels[i + 1] = g;
            pixels[i + 2] = b;
          }
        }
      }
    }
    ctx.putImageData(imageData, startX, startY);
  } catch (error) {
    console.error('Pixelate error:', error);
    showStatus('Pixelate failed');
  }
}

function cropImage(x1, y1, x2, y2) {
  const left = Math.round(Math.min(x1, x2));
  const top = Math.round(Math.min(y1, y2));
  const width = Math.round(Math.abs(x2 - x1));
  const height = Math.round(Math.abs(y2 - y1));
  if (width < 10 || height < 10) return;
  try {
    const imageData = ctx.getImageData(left, top, width, height);
    canvas.width = width;
    canvas.height = height;
    ctx.putImageData(imageData, 0, 0);
    const croppedImg = new Image();
    croppedImg.onload = () => {
      currentImage = croppedImg;
      layers = [];
      saveState();
      showStatus('Image cropped');
    };
    croppedImg.src = canvas.toDataURL();
  } catch (error) {
    console.error('Crop error:', error);
    showStatus('Crop failed');
  }
}

// Premium tools - now all unlocked
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

function rotateCanvas(degrees) {
  const temp = document.createElement('canvas');
  temp.width = canvas.width;
  temp.height = canvas.height;
  temp.getContext('2d').drawImage(canvas, 0, 0);
  
  const radians = (degrees * Math.PI) / 180;
  
  if (degrees === 90 || degrees === 270) {
    canvas.width = temp.height;
    canvas.height = temp.width;
  }
  
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  
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
  const temp = document.createElement('canvas');
  temp.width = canvas.width;
  temp.height = canvas.height;
  temp.getContext('2d').drawImage(canvas, 0, 0);
  
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
    
    const toProcess = [];
    const processed = new Set();
    
    for (let x = 0; x < canvas.width; x++) {
      toProcess.push([x, 0]);
      toProcess.push([x, canvas.height - 1]);
    }
    for (let y = 0; y < canvas.height; y++) {
      toProcess.push([0, y]);
      toProcess.push([canvas.width - 1, y]);
    }
    
    while (toProcess.length > 0) {
      const [x, y] = toProcess.pop();
      const key = `${x},${y}`;
      
      if (processed.has(key) || x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) {
        continue;
      }
      
      processed.add(key);
      
      const i = (y * canvas.width + x) * 4;
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      
      const diff = Math.sqrt(
        Math.pow(r - bgR, 2) + 
        Math.pow(g - bgG, 2) + 
        Math.pow(b - bgB, 2)
      );
      
      if (diff < tolerance) {
        pixels[i + 3] = 0;
        
        toProcess.push([x + 1, y]);
        toProcess.push([x - 1, y]);
        toProcess.push([x, y + 1]);
        toProcess.push([x, y - 1]);
      }
    }
    
    const smoothData = new Uint8ClampedArray(pixels);
    for (let y = 1; y < canvas.height - 1; y++) {
      for (let x = 1; x < canvas.width - 1; x++) {
        const i = (y * canvas.width + x) * 4;
        
        if (pixels[i + 3] > 0 && pixels[i + 3] < 255) {
          let alphaSum = 0;
          let count = 0;
          
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const ni = ((y + dy) * canvas.width + (x + dx)) * 4;
              alphaSum += pixels[ni + 3];
              count++;
            }
          }
          
          smoothData[i + 3] = Math.floor(alphaSum / count);
        }
      }
    }
    
    for (let i = 3; i < pixels.length; i += 4) {
      pixels[i] = smoothData[i];
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
  const btnAddText = document.getElementById('btnAddText');
  
  if (!backdrop || !modal || !textInput || !btnAddText) return;
  
  backdrop.classList.add('active');
  modal.classList.add('active');
  textInput.value = '';
  textInput.focus();

  const addTextHandler = () => {
    const text = textInput.value;
    if (text) {
      ctx.font = `${currentSize * 4}px Arial`;
      ctx.fillStyle = currentColor;
      ctx.fillText(text, x, y);
      saveState();
    }
    closeTextModal();
    btnAddText.removeEventListener('click', addTextHandler);
  };

  btnAddText.addEventListener('click', addTextHandler);
}

function closeTextModal() {
  const backdrop = document.getElementById('modalBackdrop');
  const modal = document.getElementById('textModal');
  if (backdrop) backdrop.classList.remove('active');
  if (modal) modal.classList.remove('active');
}

const modalBackdrop = document.getElementById('modalBackdrop');
if (modalBackdrop) {
  modalBackdrop.addEventListener('click', closeTextModal);
}

const textInput = document.getElementById('textInput');
if (textInput) {
  textInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      const btnAddText = document.getElementById('btnAddText');
      if (btnAddText) btnAddText.click();
    }
  });
}

function saveState() {
  historyStep++;
  if (historyStep < history.length) {
    history.length = historyStep;
  }
  history.push(canvas.toDataURL());
  if (history.length > 50) {
    history.shift();
    historyStep--;
  }
}

function undo() {
  if (historyStep > 0) {
    historyStep--;
    restoreState(history[historyStep]);
    showStatus('Undo');
  }
}

function redo() {
  if (historyStep < history.length - 1) {
    historyStep++;
    restoreState(history[historyStep]);
    showStatus('Redo');
  }
}

function restoreState(dataUrl) {
  const img = new Image();
  img.onload = () => {
    canvas.width = img.width;
    canvas.height = img.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
  };
  img.src = dataUrl;
}

const btnUndo = document.getElementById('btnUndo');
const btnRedo = document.getElementById('btnRedo');
if (btnUndo) btnUndo.addEventListener('click', undo);
if (btnRedo) btnRedo.addEventListener('click', redo);

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'z') {
      e.preventDefault();
      undo();
    } else if (e.key === 'y') {
      e.preventDefault();
      redo();
    } else if (e.key === 's') {
      e.preventDefault();
      saveImage();
    }
  }
});

const btnClear = document.getElementById('btnClear');
if (btnClear) {
  btnClear.addEventListener('click', () => {
    if (confirm('Clear all edits?')) {
      layers = [];
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      
      if (currentImage) {
        ctx.drawImage(currentImage, 0, 0);
      }
      
      saveState();
      showStatus('Canvas cleared');
    }
  });
}

const btnSave = document.getElementById('btnSave');
if (btnSave) {
  btnSave.addEventListener('click', saveImage);
}

function saveImage() {
  canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const a = document.createElement('a');
    a.href = url;
    a.download = `edited-${timestamp}.png`;
    a.click();
    URL.revokeObjectURL(url);
    showStatus('Image saved!');
  });
}

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
