// Firefox compatible recorder script
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

let mediaRecorder = null;
let recordedChunks = [];
let stream = null;
let startTime = null;
let timerInterval = null;

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const recordingStatus = document.getElementById('recordingStatus');
const optionsPanel = document.getElementById('optionsPanel');
const timerEl = document.getElementById('timer');
const audioCheck = document.getElementById('audioCheck');
const micCheck = document.getElementById('micCheck');

startBtn.addEventListener('click', startRecording);
stopBtn.addEventListener('click', stopRecording);

// Update subtitle - no premium restrictions
const subtitle = document.getElementById('subtitle');
if (subtitle) {
  subtitle.textContent = 'Record your screen with audio - Unlimited recordings';
}

async function startRecording() {
  try {
    const includeSystemAudio = audioCheck.checked;
    const includeMicrophone = micCheck.checked;

    console.log('=== STARTING RECORDING ===');
    console.log('System audio requested:', includeSystemAudio);
    console.log('Microphone requested:', includeMicrophone);
    
    // IMPORTANT: For Firefox, system audio only works when capturing TAB
    // Not screen or window!
    let displayStream;
    
    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: includeSystemAudio ? {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        } : false
      });
    } catch (error) {
      console.error('Failed to get display media:', error);
      throw error;
    }

    console.log('✅ Display stream obtained');
    console.log('   Video tracks:', displayStream.getVideoTracks().length);
    console.log('   Audio tracks:', displayStream.getAudioTracks().length);
    
    // Log audio track details
    displayStream.getAudioTracks().forEach((track, i) => {
      console.log(`   Audio track ${i}:`, track.label, 'enabled:', track.enabled, 'muted:', track.muted);
    });

    let finalStream = displayStream;
    let audioContext = null;

    // If audio was requested but not available, warn user
    if (includeSystemAudio && displayStream.getAudioTracks().length === 0) {
      console.warn('⚠️  System audio was requested but no audio track available');
      console.warn('⚠️  This is common in Firefox when capturing screen or window');
      console.warn('⚠️  Try capturing a TAB instead for audio support');
      
      // Don't show alert, just log - recording will continue without audio
    }

    if (includeMicrophone) {
      try {
        console.log('🎤 Requesting microphone...');
        const micStream = await navigator.mediaDevices.getUserMedia({ 
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });
        
        console.log('✅ Microphone obtained');
        
        // If we have both audio sources, mix them
        if (displayStream.getAudioTracks().length > 0) {
          console.log('🔊 Mixing system audio + microphone...');
          
          audioContext = new AudioContext();
          const destination = audioContext.createMediaStreamDestination();
          
          // Add system audio
          const systemSource = audioContext.createMediaStreamSource(
            new MediaStream(displayStream.getAudioTracks())
          );
          systemSource.connect(destination);
          
          // Add microphone
          const micSource = audioContext.createMediaStreamSource(micStream);
          micSource.connect(destination);
          
          // Create mixed stream
          finalStream = new MediaStream([
            ...displayStream.getVideoTracks(),
            ...destination.stream.getAudioTracks()
          ]);
          
          console.log('✅ Audio streams mixed');
        } else {
          // Only microphone
          console.log('🎤 Using only microphone (no system audio available)');
          finalStream = new MediaStream([
            ...displayStream.getVideoTracks(),
            ...micStream.getAudioTracks()
          ]);
        }
      } catch (error) {
        console.error('❌ Microphone error:', error);
        alert('Could not access microphone.\n\nRecording will continue without microphone audio.');
      }
    }

    stream = finalStream;

    console.log('📊 FINAL STREAM:');
    console.log('   Video tracks:', finalStream.getVideoTracks().length);
    console.log('   Audio tracks:', finalStream.getAudioTracks().length);
    
    finalStream.getAudioTracks().forEach((track, i) => {
      console.log(`   Audio ${i}:`, track.label, 'enabled:', track.enabled, 'readyState:', track.readyState);
    });

    // Test if we have working audio
    const hasAudio = finalStream.getAudioTracks().length > 0;
    const audioEnabled = hasAudio && finalStream.getAudioTracks()[0].enabled;
    
    console.log('🔊 Audio status:', hasAudio ? 'Available' : 'Not available');
    console.log('🔊 Audio enabled:', audioEnabled);

    // Choose codec based on audio availability
    let options;
    if (hasAudio) {
      // Try codecs with audio support
      const codecsWithAudio = [
        'video/webm;codecs=vp8,opus',
        'video/webm;codecs=vp9,opus',
        'video/webm'
      ];
      
      for (const codec of codecsWithAudio) {
        if (MediaRecorder.isTypeSupported(codec)) {
          options = { 
            mimeType: codec,
            audioBitsPerSecond: 128000,
            videoBitsPerSecond: 2500000
          };
          console.log('✅ Using codec:', codec);
          break;
        }
      }
    } else {
      // Video only codecs
      const codecsVideoOnly = [
        'video/webm;codecs=vp8',
        'video/webm;codecs=vp9',
        'video/webm'
      ];
      
      for (const codec of codecsVideoOnly) {
        if (MediaRecorder.isTypeSupported(codec)) {
          options = { 
            mimeType: codec,
            videoBitsPerSecond: 2500000
          };
          console.log('✅ Using codec (video only):', codec);
          break;
        }
      }
    }
    
    if (!options) {
      options = {};
      console.log('⚠️  Using default codec');
    }

    console.log('🎬 Creating MediaRecorder...');
    mediaRecorder = new MediaRecorder(stream, options);
    recordedChunks = [];

    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        recordedChunks.push(event.data);
        console.log(`📦 Chunk ${recordedChunks.length}: ${event.data.size} bytes (Total: ${recordedChunks.reduce((sum, chunk) => sum + chunk.size, 0)} bytes)`);
      }
    };

    mediaRecorder.onstop = () => {
      console.log('⏹️  MediaRecorder stopped');
      console.log('   Total chunks collected:', recordedChunks.length);
      console.log('   Total size:', recordedChunks.reduce((sum, chunk) => sum + chunk.size, 0), 'bytes');
      
      // Clean up audio context
      if (audioContext && audioContext.state !== 'closed') {
        audioContext.close().then(() => {
          console.log('🔇 Audio context closed');
        });
      }
      
      saveRecording();
    };
    
    mediaRecorder.onerror = (event) => {
      console.error('❌ MediaRecorder error:', event);
      alert('Recording error: ' + (event.error?.message || 'Unknown error'));
    };

    mediaRecorder.onstart = () => {
      console.log('▶️  MediaRecorder started');
    };

    mediaRecorder.onpause = () => {
      console.log('⏸️  MediaRecorder paused');
    };

    mediaRecorder.onresume = () => {
      console.log('▶️  MediaRecorder resumed');
    };

    // Handle stream ending
    stream.getVideoTracks()[0].addEventListener('ended', () => {
      console.log('📹 Video track ended (user stopped sharing)');
      stopRecording();
    });

    // Start recording with timeslice to ensure data is captured
    console.log('🎬 Starting recording with 1 second timeslice...');
    mediaRecorder.start(1000); // Request data every second
    
    console.log('✅ Recording state:', mediaRecorder.state);

    // Update UI
    startBtn.style.display = 'none';
    stopBtn.style.display = 'block';
    recordingStatus.classList.add('active');
    optionsPanel.style.display = 'none';
    
    // Start timer
    startTime = Date.now();
    updateTimer();
    timerInterval = setInterval(updateTimer, 1000);
    
    console.log('=== RECORDING STARTED ===');

  } catch (error) {
    console.error('❌ Failed to start recording:', error);
    console.error('   Error name:', error.name);
    console.error('   Error message:', error.message);
    
    // User cancelled
    if (error.name === 'NotAllowedError' || error.name === 'AbortError') {
      console.log('ℹ️  User cancelled screen sharing');
      return;
    }
    
    let errorMsg = 'Could not start recording.\n\n';
    
    if (error.name === 'NotFoundError') {
      errorMsg += 'No recording device found.';
    } else if (error.name === 'NotReadableError') {
      errorMsg += 'Device is already in use.';
    } else {
      errorMsg += error.message;
    }
    
    errorMsg += '\n\nTips:\n';
    errorMsg += '• Make sure you selected a screen/window/tab\n';
    errorMsg += '• Try capturing a TAB for audio support\n';
    errorMsg += '• Check browser permissions';
    
    alert(errorMsg);
  }
}

function stopRecording() {
  console.log('stopRecording called');
  
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    console.log('Stopping MediaRecorder, state:', mediaRecorder.state);
    
    // Request final data
    if (mediaRecorder.state === 'recording') {
      mediaRecorder.requestData();
    }
    
    mediaRecorder.stop();
  } else {
    console.log('MediaRecorder already stopped or not initialized');
  }

  if (stream) {
    console.log('Stopping all stream tracks');
    stream.getTracks().forEach(track => {
      track.stop();
      console.log('Stopped track:', track.kind, track.label);
    });
  }

  clearInterval(timerInterval);

  // Update UI
  startBtn.style.display = 'block';
  stopBtn.style.display = 'none';
  recordingStatus.classList.remove('active');
  optionsPanel.style.display = 'block';
  timerEl.textContent = '00:00';
  
  console.log('UI updated, waiting for onstop event...');
}

function saveRecording() {
  console.log('Saving recording, chunks:', recordedChunks.length);
  
  if (recordedChunks.length === 0) {
    alert('No recording data available');
    return;
  }

  const blob = new Blob(recordedChunks, { type: 'video/webm' });
  console.log('Blob created, size:', blob.size);
  
  const url = URL.createObjectURL(blob);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  
  const a = document.createElement('a');
  a.style.display = 'none';
  a.href = url;
  a.download = `recording-${timestamp}.webm`;
  document.body.appendChild(a);
  
  console.log('Triggering download...');
  a.click();
  
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    console.log('Download cleanup complete');
  }, 100);

  // Save to history
  if (typeof browserAPI !== 'undefined') {
    browserAPI.storage.local.get(['captureHistory']).then((result) => {
      const history = result.captureHistory || [];
      
      history.unshift({
        type: 'recording',
        filename: a.download,
        timestamp: Date.now()
      });
      
      if (history.length > 100) history.pop();
      
      browserAPI.storage.local.set({ captureHistory: history });
    }).catch(err => console.error('History save error:', err));

    // Send notification to background
    browserAPI.runtime.sendMessage({ 
      action: 'recordingStopped' 
    }).catch(err => console.error('Message error:', err));
  }

  alert('✅ Recording saved successfully!');
}

function updateTimer() {
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const minutes = Math.floor(elapsed / 60).toString().padStart(2, '0');
  const seconds = (elapsed % 60).toString().padStart(2, '0');
  timerEl.textContent = `${minutes}:${seconds}`;
}
