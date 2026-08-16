/* ==========================================================================
   AI AIR DRAW — script.js
   Real webcam input + real MediaPipe Hands landmark detection.
   No simulated/fake hand tracking anywhere in this file.
   ========================================================================== */

(() => {
  'use strict';

  /* ------------------------------------------------------------------
     DOM references
     ------------------------------------------------------------------ */
  const landing        = document.getElementById('landing');
  const startBtn        = document.getElementById('startBtn');
  const loadingOverlay  = document.getElementById('loadingOverlay');
  const loadingText     = document.getElementById('loadingText');
  const errorOverlay    = document.getElementById('errorOverlay');
  const errorTitle      = document.getElementById('errorTitle');
  const errorMessage    = document.getElementById('errorMessage');
  const errorRetryBtn   = document.getElementById('errorRetryBtn');
  const appEl           = document.getElementById('app');

  const stageFrame      = document.getElementById('stageFrame');
  const video           = document.getElementById('webcam');
  const drawCanvas      = document.getElementById('drawCanvas');
  const cursorCanvas    = document.getElementById('cursorCanvas');
  const noHandBanner    = document.getElementById('noHandBanner');
  const multiHandBanner = document.getElementById('multiHandBanner');
  const gestureToast    = document.getElementById('gestureToast');

  const statCamera      = document.getElementById('statCamera');
  const statFps         = document.getElementById('statFps');
  const statHand        = document.getElementById('statHand');
  const statGesture     = document.getElementById('statGesture');

  const webcamBgToggle  = document.getElementById('webcamBgToggle');
  const skeletonToggle  = document.getElementById('skeletonToggle');
  const muteBtn         = document.getElementById('muteBtn');
  const fullscreenBtn   = document.getElementById('fullscreenBtn');

  const colorPicker     = document.getElementById('colorPicker');
  const colorSwatchesEl = document.getElementById('colorSwatches');
  const brushSizeInput  = document.getElementById('brushSize');
  const brushSizeVal    = document.getElementById('brushSizeVal');
  const eraserBtn       = document.getElementById('eraserBtn');
  const undoBtn         = document.getElementById('undoBtn');
  const redoBtn         = document.getElementById('redoBtn');
  const clearBtn        = document.getElementById('clearBtn');
  const saveBtn         = document.getElementById('saveBtn');

  const drawCtx   = drawCanvas.getContext('2d', { willReadFrequently: true });
  const cursorCtx = cursorCanvas.getContext('2d');

  /* ------------------------------------------------------------------
     Configuration
     ------------------------------------------------------------------ */
  const PALETTE = ['#22d3ee', '#a855f7', '#fb7185', '#f5b942', '#34e0a1', '#ffffff'];
  const SMOOTHING          = 0.55;   // higher = smoother but laggier (0-1)
  const PINCH_THRESHOLD    = 0.055;  // normalized distance, scaled by hand size
  const PALM_HOLD_MS       = 1500;   // open-palm hold duration to clear
  const GESTURE_STABLE_MS  = 120;    // debounce before a gesture is "confirmed"
  const HISTORY_LIMIT      = 25;
  const ERASER_SIZE_MULT   = 3.2;
  const MOVE_TICK_MIN_DIST = 22;    // px the fingertip must travel before a "servo step" click plays
  const MOVE_TICK_MIN_GAP  = 55;    // ms minimum gap between movement ticks

  // Standard MediaPipe hand connectivity graph (wrist + 4 joints per finger).
  // Used to draw the "hand rig" stick-figure overlay.
  const HAND_CONNECTIONS = [
    [0, 1], [1, 2], [2, 3], [3, 4],       // thumb
    [0, 5], [5, 6], [6, 7], [7, 8],       // index
    [5, 9], [9, 10], [10, 11], [11, 12],  // middle
    [9, 13], [13, 14], [14, 15], [15, 16],// ring
    [13, 17], [17, 18], [18, 19], [19, 20],// pinky
    [0, 17],                              // palm base
  ];
  const FINGERTIP_IDS = new Set([4, 8, 12, 16, 20]);

  /* ------------------------------------------------------------------
     App state
     ------------------------------------------------------------------ */
  const state = {
    hands: null,
    cameraLoopId: null,
    streaming: false,

    currentColor: PALETTE[0],
    brushSize: 6,
    manualEraser: false,

    // smoothed fingertip position, in canvas pixel space
    smoothedX: null,
    smoothedY: null,
    isDrawingStroke: false,

    lastGesture: 'idle',
    stableGesture: 'idle',
    gestureSince: 0,
    colorCycleArmed: true,

    palmHoldStart: null,

    history: [],       // array of ImageData snapshots
    historyIndex: -1,  // pointer into history

    fpsLastTime: performance.now(),
    fpsFrames: 0,
    fps: 0,

    handednessLabel: null,

    // hand-rig overlay
    showSkeleton: true,

    // sound
    soundEnabled: true,
    palmToneOsc: null,
    palmToneGain: null,
    lastTickPos: null,
    lastTickTime: 0,
  };

  /* ------------------------------------------------------------------
     Utility
     ------------------------------------------------------------------ */
  function lerp(a, b, t) { return a + (b - a) * t; }
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function showToast(text) {
    gestureToast.textContent = text;
    gestureToast.classList.remove('hidden');
  }
  function setStatGesture(label) {
    statGesture.textContent = label;
  }

  /* ------------------------------------------------------------------
     Audio engine — synthesized robotic / mechanical sound effects.
     Everything here is generated with the Web Audio API (oscillators +
     filtered noise bursts). No audio files are loaded, so there's
     nothing extra to host or bundle.
     ------------------------------------------------------------------ */
  let audioCtx = null;
  let masterGain = null;

  function ensureAudio() {
    if (audioCtx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return; // Web Audio unsupported: app still works, just silently
    audioCtx = new Ctx();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = state.soundEnabled ? 0.7 : 0;
    masterGain.connect(audioCtx.destination);
  }
  function resumeAudio() {
    // Browsers suspend AudioContext until it's (re)started from inside a
    // user-gesture call stack. We call this from the Start button handler.
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  }

  // Short synthesized tone with an exponential attack/decay envelope —
  // the basic building block for "beep/blip" style robotic cues.
  function playTone({ freq = 440, freqEnd = null, duration = 0.09, type = 'square', gain = 0.14, delay = 0 } = {}) {
    if (!audioCtx || !state.soundEnabled) return;
    const t0 = audioCtx.currentTime + delay;
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (freqEnd) osc.frequency.exponentialRampToValueAtTime(Math.max(freqEnd, 1), t0 + duration);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(g); g.connect(masterGain);
    osc.start(t0); osc.stop(t0 + duration + 0.02);
  }

  // Filtered noise burst — reads as a mechanical "click/relay/servo" sound
  // rather than a musical tone.
  function playClick({ duration = 0.045, gain = 0.16, freq = 1800, q = 1.2 } = {}) {
    if (!audioCtx || !state.soundEnabled) return;
    const t0 = audioCtx.currentTime;
    const bufferSize = Math.max(1, Math.floor(audioCtx.sampleRate * duration));
    const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    const noise = audioCtx.createBufferSource();
    noise.buffer = buffer;
    const bp = audioCtx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = q;
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    noise.connect(bp); bp.connect(g); g.connect(masterGain);
    noise.start(t0);
  }

  // Named cues, one per gesture event:
  function sfxEngage() {                 // entering DRAW
    playClick({ freq: 2200, duration: 0.03, gain: 0.13 });
    playTone({ freq: 260, freqEnd: 520, duration: 0.09, type: 'square', gain: 0.09, delay: 0.01 });
  }
  function sfxDisengage() {              // entering PEN UP (fist)
    playClick({ freq: 900, duration: 0.035, gain: 0.13 });
    playTone({ freq: 420, freqEnd: 160, duration: 0.11, type: 'square', gain: 0.08, delay: 0.01 });
  }
  function sfxEraser() {                 // entering ERASER (pinch)
    playClick({ freq: 600, duration: 0.09, gain: 0.15 });
    playTone({ freq: 180, freqEnd: 90, duration: 0.12, type: 'sawtooth', gain: 0.05, delay: 0.01 });
  }
  function sfxColorChange(paletteIndex) { // two-finger color cycle
    const base = 480 + paletteIndex * 70;
    playTone({ freq: base, duration: 0.06, type: 'square', gain: 0.1 });
    playTone({ freq: base * 1.5, duration: 0.07, type: 'square', gain: 0.08, delay: 0.06 });
  }
  function sfxMoveTick() {                // subtle "servo step" while actively drawing/erasing
    playClick({ freq: 2600 + Math.random() * 500, duration: 0.016, gain: 0.045, q: 2.2 });
  }
  function sfxClearTrigger() {            // canvas clear
    playClick({ freq: 400, duration: 0.12, gain: 0.18 });
    playTone({ freq: 500, freqEnd: 60, duration: 0.4, type: 'sawtooth', gain: 0.09, delay: 0.02 });
  }

  // A held oscillator that rises in pitch/volume while the open-palm
  // "hold to clear" gesture is charging up — like a servo winding up.
  function startPalmChargeTone() {
    if (!audioCtx || !state.soundEnabled) return;
    stopPalmChargeTone();
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.value = 180;
    g.gain.value = 0.0001;
    g.gain.exponentialRampToValueAtTime(0.045, audioCtx.currentTime + 0.05);
    osc.connect(g); g.connect(masterGain);
    osc.start();
    state.palmToneOsc = osc;
    state.palmToneGain = g;
  }
  function updatePalmChargeTone(progress) {
    if (!state.palmToneOsc || !audioCtx) return;
    const freq = 180 + progress * 620;
    state.palmToneOsc.frequency.setTargetAtTime(freq, audioCtx.currentTime, 0.03);
    state.palmToneGain.gain.setTargetAtTime(0.03 + progress * 0.06, audioCtx.currentTime, 0.05);
  }
  function stopPalmChargeTone() {
    if (!state.palmToneOsc || !audioCtx) return;
    try {
      const g = state.palmToneGain;
      const t0 = audioCtx.currentTime;
      g.gain.cancelScheduledValues(t0);
      g.gain.setValueAtTime(g.gain.value, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.08);
      state.palmToneOsc.stop(t0 + 0.1);
    } catch (e) { /* already stopped, ignore */ }
    state.palmToneOsc = null;
    state.palmToneGain = null;
  }

  // Throttled "movement" click — plays only after the fingertip has
  // travelled a minimum distance and enough time has passed, so it reads
  // like discrete mechanical steps rather than a constant buzz.
  function maybeMoveTick(x, y) {
    const now = performance.now();
    if (state.lastTickPos) {
      const d = Math.hypot(x - state.lastTickPos.x, y - state.lastTickPos.y);
      if (d > MOVE_TICK_MIN_DIST && now - state.lastTickTime > MOVE_TICK_MIN_GAP) {
        sfxMoveTick();
        state.lastTickPos = { x, y };
        state.lastTickTime = now;
      }
    } else {
      state.lastTickPos = { x, y };
      state.lastTickTime = now;
    }
  }

  muteBtn.addEventListener('click', () => {
    state.soundEnabled = !state.soundEnabled;
    muteBtn.classList.toggle('active', !state.soundEnabled);
    if (masterGain) masterGain.gain.value = state.soundEnabled ? 0.7 : 0;
    if (!state.soundEnabled) stopPalmChargeTone();
    document.getElementById('muteBtnIcon').innerHTML = state.soundEnabled
      ? '<path d="M4 9v6h4l5 5V4L8 9H4Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'
      : '<path d="M4 9v6h4l5 5V4L8 9H4Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M17 9l5 5M22 9l-5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>';
  });

  skeletonToggle.addEventListener('change', () => {
    state.showSkeleton = skeletonToggle.checked;
  });

  /* ------------------------------------------------------------------
     Color swatches
     ------------------------------------------------------------------ */
  function buildSwatches() {
    colorSwatchesEl.innerHTML = '';
    PALETTE.forEach((c) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'swatch' + (c === state.currentColor ? ' active' : '');
      el.style.background = c;
      el.setAttribute('aria-label', 'Color ' + c);
      el.addEventListener('click', () => setColor(c));
      colorSwatchesEl.appendChild(el);
    });
  }
  function setColor(hex) {
    state.currentColor = hex;
    state.manualEraser = false;
    eraserBtn.classList.remove('active');
    colorPicker.value = hex;
    [...colorSwatchesEl.children].forEach((el) => {
      el.classList.toggle('active', el.style.background === hexToRgbString(hex));
    });
  }
  function hexToRgbString(hex) {
    // normalize by writing into a throwaway element-independent canvas trick
    const d = document.createElement('canvas').getContext('2d');
    d.fillStyle = hex;
    return d.fillStyle;
  }
  function cycleColor() {
    const idx = PALETTE.indexOf(state.currentColor);
    const next = PALETTE[(idx + 1) % PALETTE.length];
    setColor(next);
    sfxColorChange((idx + 1) % PALETTE.length);
    showToast('COLOR → ' + next.toUpperCase());
  }

  colorPicker.addEventListener('input', (e) => setColor(e.target.value));
  brushSizeInput.addEventListener('input', (e) => {
    state.brushSize = Number(e.target.value);
    brushSizeVal.textContent = state.brushSize;
  });

  /* ------------------------------------------------------------------
     Canvas sizing (keeps existing drawing on resize)
     ------------------------------------------------------------------ */
  function resizeCanvases() {
    const rect = stageFrame.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));

    [drawCanvas, cursorCanvas].forEach((cv) => {
      if (cv.width === w && cv.height === h) return;
      const prev = document.createElement('canvas');
      prev.width = cv.width; prev.height = cv.height;
      if (cv.width && cv.height) prev.getContext('2d').drawImage(cv, 0, 0);

      cv.width = w; cv.height = h;
      const ctx = cv.getContext('2d');
      if (prev.width && prev.height) ctx.drawImage(prev, 0, 0, prev.width, prev.height, 0, 0, w, h);
    });
  }
  window.addEventListener('resize', resizeCanvases);

  /* ------------------------------------------------------------------
     Undo / Redo history (snapshot-based)
     ------------------------------------------------------------------ */
  function pushHistory() {
    // drop redo branch
    state.history = state.history.slice(0, state.historyIndex + 1);
    const snap = drawCtx.getImageData(0, 0, drawCanvas.width, drawCanvas.height);
    state.history.push(snap);
    if (state.history.length > HISTORY_LIMIT) state.history.shift();
    state.historyIndex = state.history.length - 1;
    updateHistoryButtons();
  }
  function undo() {
    if (state.historyIndex <= 0) {
      // nothing before first snapshot -> clear to blank
      if (state.historyIndex === 0) {
        state.historyIndex = -1;
        drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
      }
      updateHistoryButtons();
      return;
    }
    state.historyIndex -= 1;
    drawCtx.putImageData(state.history[state.historyIndex], 0, 0);
    updateHistoryButtons();
  }
  function redo() {
    if (state.historyIndex >= state.history.length - 1) return;
    state.historyIndex += 1;
    drawCtx.putImageData(state.history[state.historyIndex], 0, 0);
    updateHistoryButtons();
  }
  function updateHistoryButtons() {
    undoBtn.disabled = state.historyIndex < 0;
    redoBtn.disabled = state.historyIndex >= state.history.length - 1;
  }

  /* ------------------------------------------------------------------
     Clear canvas (with confirmation flash)
     ------------------------------------------------------------------ */
  function clearCanvas(flash) {
    pushHistory(); // snapshot pre-clear state so undo restores it
    drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
    pushHistory();
    sfxClearTrigger();
    if (flash) {
      cursorCtx.save();
      cursorCtx.fillStyle = 'rgba(255,255,255,0.35)';
      cursorCtx.fillRect(0, 0, cursorCanvas.width, cursorCanvas.height);
      cursorCtx.restore();
      setTimeout(() => cursorCtx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height), 120);
    }
    showToast('CANVAS CLEARED');
  }
  clearBtn.addEventListener('click', () => clearCanvas(true));
  undoBtn.addEventListener('click', undo);
  redoBtn.addEventListener('click', redo);

  eraserBtn.addEventListener('click', () => {
    state.manualEraser = !state.manualEraser;
    eraserBtn.classList.toggle('active', state.manualEraser);
  });

  /* ------------------------------------------------------------------
     Save PNG
     ------------------------------------------------------------------ */
  saveBtn.addEventListener('click', () => {
    const out = document.createElement('canvas');
    out.width = drawCanvas.width;
    out.height = drawCanvas.height;
    const octx = out.getContext('2d');

    if (webcamBgToggle.checked) {
      octx.save();
      octx.translate(out.width, 0);
      octx.scale(-1, 1); // mirror to match what user sees
      octx.drawImage(video, 0, 0, out.width, out.height);
      octx.restore();
    }
    octx.drawImage(drawCanvas, 0, 0);

    const link = document.createElement('a');
    link.download = 'air-draw-' + Date.now() + '.png';
    link.href = out.toDataURL('image/png');
    link.click();
    showToast('DRAWING SAVED');
  });

  /* ------------------------------------------------------------------
     Fullscreen + webcam background toggle
     ------------------------------------------------------------------ */
  fullscreenBtn.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      appEl.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.();
    }
  });
  webcamBgToggle.addEventListener('change', () => {
    video.style.opacity = webcamBgToggle.checked ? '1' : '0';
    stageFrame.style.background = webcamBgToggle.checked ? '#000' : '#05070d';
  });

  /* ------------------------------------------------------------------
     Gesture classification from MediaPipe landmarks
     Landmark indices: 0 wrist, 4 thumb tip, 8 index tip, 12 middle tip,
     16 ring tip, 20 pinky tip. PIP joints: 6,10,14,18. Thumb IP: 3.
     ------------------------------------------------------------------ */
  function classifyFingers(lm, handednessLabel) {
    const fingerUp = (tipIdx, pipIdx) => lm[tipIdx].y < lm[pipIdx].y;

    const indexUp  = fingerUp(8, 6);
    const middleUp = fingerUp(12, 10);
    const ringUp   = fingerUp(16, 14);
    const pinkyUp  = fingerUp(20, 18);

    // Thumb: selfieMode flips handedness label to match the mirrored view,
    // so we compare x-coordinates in the direction appropriate to that hand.
    const thumbUp = handednessLabel === 'Left'
      ? lm[4].x > lm[3].x
      : lm[4].x < lm[3].x;

    return { indexUp, middleUp, ringUp, pinkyUp, thumbUp };
  }

  function classifyGesture(lm, handednessLabel) {
    const handSize = dist(lm[0], lm[9]) || 0.2; // wrist -> middle MCP, used to scale pinch threshold
    const pinchDist = dist(lm[4], lm[8]) / handSize;

    if (pinchDist < PINCH_THRESHOLD * 4.2) return 'pinch'; // scaled threshold (handSize normalizes)

    const f = classifyFingers(lm, handednessLabel);

    if (!f.indexUp && !f.middleUp && !f.ringUp && !f.pinkyUp) return 'fist';
    if (f.indexUp && f.middleUp && f.ringUp && f.pinkyUp) return 'open_palm';
    if (f.indexUp && f.middleUp && !f.ringUp && !f.pinkyUp) return 'two_fingers';
    if (f.indexUp && !f.middleUp && !f.ringUp && !f.pinkyUp) return 'index_only';
    return 'unknown';
  }

  /* ------------------------------------------------------------------
     Drawing engine
     ------------------------------------------------------------------ */
  function toCanvasPoint(landmark) {
    // Hands is configured with selfieMode: true, which makes MediaPipe itself
    // flip landmark.x to already match the mirrored (selfie-style) video the
    // user sees. So we map x directly — do NOT flip it again here, or the
    // two flips cancel out and the cursor moves opposite to the real hand.
    const x = landmark.x * drawCanvas.width;
    const y = landmark.y * drawCanvas.height;
    return { x, y };
  }

  function beginStroke(pt) {
    state.smoothedX = pt.x;
    state.smoothedY = pt.y;
    state.isDrawingStroke = true;
    state.lastTickPos = null;
    pushHistory(); // snapshot BEFORE this stroke, so undo removes exactly this stroke
    drawCtx.beginPath();
    drawCtx.moveTo(pt.x, pt.y);
  }

  function extendStroke(pt, erasing) {
    state.smoothedX = lerp(state.smoothedX, pt.x, 1 - SMOOTHING);
    state.smoothedY = lerp(state.smoothedY, pt.y, 1 - SMOOTHING);
    maybeMoveTick(state.smoothedX, state.smoothedY);

    drawCtx.lineJoin = 'round';
    drawCtx.lineCap = 'round';

    if (erasing) {
      drawCtx.globalCompositeOperation = 'destination-out';
      drawCtx.lineWidth = state.brushSize * ERASER_SIZE_MULT;
      drawCtx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
      drawCtx.globalCompositeOperation = 'source-over';
      drawCtx.lineWidth = state.brushSize;
      drawCtx.strokeStyle = state.currentColor;
      drawCtx.shadowColor = state.currentColor;
      drawCtx.shadowBlur = state.brushSize * 0.9;
    }

    drawCtx.lineTo(state.smoothedX, state.smoothedY);
    drawCtx.stroke();
    drawCtx.shadowBlur = 0;
    drawCtx.beginPath();
    drawCtx.moveTo(state.smoothedX, state.smoothedY);
  }

  function endStroke() {
    if (state.isDrawingStroke) pushHistory();
    state.isDrawingStroke = false;
    state.lastTickPos = null;
  }

  /* ------------------------------------------------------------------
     Hand rig overlay — draws the 21-landmark skeleton as connected
     glowing "sticks" with joint dots, like a HUD readout of the hand.
     ------------------------------------------------------------------ */
  function drawHandRig(lm) {
    if (!state.showSkeleton || !lm) return;

    cursorCtx.save();
    cursorCtx.lineCap = 'round';

    // bones
    cursorCtx.shadowColor = '#22d3ee';
    cursorCtx.shadowBlur = 6;
    cursorCtx.strokeStyle = 'rgba(34, 211, 238, 0.6)';
    cursorCtx.lineWidth = 2;
    HAND_CONNECTIONS.forEach(([a, b]) => {
      const pa = toCanvasPoint(lm[a]);
      const pb = toCanvasPoint(lm[b]);
      cursorCtx.beginPath();
      cursorCtx.moveTo(pa.x, pa.y);
      cursorCtx.lineTo(pb.x, pb.y);
      cursorCtx.stroke();
    });

    // joints
    lm.forEach((point, i) => {
      const p = toCanvasPoint(point);
      const isTip = FINGERTIP_IDS.has(i);
      cursorCtx.beginPath();
      cursorCtx.shadowColor = isTip ? '#ffffff' : '#a855f7';
      cursorCtx.shadowBlur = isTip ? 10 : 5;
      cursorCtx.fillStyle = isTip ? 'rgba(255,255,255,0.95)' : 'rgba(168,85,247,0.85)';
      cursorCtx.arc(p.x, p.y, isTip ? 4 : 2.6, 0, Math.PI * 2);
      cursorCtx.fill();
    });

    cursorCtx.restore();
  }

  /* ------------------------------------------------------------------
     Cursor / HUD rendering (every frame, cleared every frame)
     ------------------------------------------------------------------ */
  const particles = [];
  function spawnParticles(x, y, color) {
    for (let i = 0; i < 2; i++) {
      particles.push({
        x, y,
        vx: (Math.random() - 0.5) * 2.4,
        vy: (Math.random() - 0.5) * 2.4,
        life: 1,
        color,
      });
    }
    if (particles.length > 120) particles.splice(0, particles.length - 120);
  }

  function drawCursorFrame(lm, fingertip, gesture, erasing, palmProgress) {
    cursorCtx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);
    drawHandRig(lm);
    if (!fingertip) return;

    const { x, y } = fingertip;
    const color = erasing ? '#ffffff' : state.currentColor;

    // particles trail while actively drawing/erasing
    if (gesture === 'index_only' || erasing) {
      spawnParticles(x, y, color);
    }
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx; p.y += p.vy; p.life -= 0.035;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      cursorCtx.globalAlpha = p.life * 0.6;
      cursorCtx.fillStyle = p.color;
      cursorCtx.beginPath();
      cursorCtx.arc(p.x, p.y, 2 + (1 - p.life) * 2, 0, Math.PI * 2);
      cursorCtx.fill();
    }
    cursorCtx.globalAlpha = 1;

    // glow ring around fingertip
    const ringRadius = erasing ? state.brushSize * ERASER_SIZE_MULT * 0.5 : Math.max(10, state.brushSize * 1.4);
    cursorCtx.save();
    cursorCtx.shadowColor = color;
    cursorCtx.shadowBlur = 18;
    cursorCtx.strokeStyle = color;
    cursorCtx.lineWidth = gesture === 'index_only' || erasing ? 3 : 1.6;
    cursorCtx.globalAlpha = gesture === 'index_only' || erasing ? 0.95 : 0.55;
    cursorCtx.beginPath();
    cursorCtx.arc(x, y, ringRadius, 0, Math.PI * 2);
    cursorCtx.stroke();
    cursorCtx.restore();

    cursorCtx.beginPath();
    cursorCtx.fillStyle = color;
    cursorCtx.globalAlpha = 0.9;
    cursorCtx.arc(x, y, 3.5, 0, Math.PI * 2);
    cursorCtx.fill();
    cursorCtx.globalAlpha = 1;

    // palm-hold clear progress ring
    if (palmProgress && palmProgress > 0) {
      cursorCtx.save();
      cursorCtx.strokeStyle = '#fb7185';
      cursorCtx.shadowColor = '#fb7185';
      cursorCtx.shadowBlur = 16;
      cursorCtx.lineWidth = 5;
      cursorCtx.beginPath();
      cursorCtx.arc(x, y, 34, -Math.PI / 2, -Math.PI / 2 + palmProgress * Math.PI * 2);
      cursorCtx.stroke();
      cursorCtx.restore();
    }
  }

  /* ------------------------------------------------------------------
     MediaPipe Hands results handler
     ------------------------------------------------------------------ */
  function onResults(results) {
    resizeCanvases();
    updateFps();

    const numHands = results.multiHandLandmarks ? results.multiHandLandmarks.length : 0;
    multiHandBanner.classList.toggle('hidden', numHands <= 1);

    if (numHands === 0) {
      noHandBanner.classList.remove('hidden');
      statHand.textContent = 'searching…';
      setStatGesture('IDLE');
      state.stableGesture = 'idle';
      state.palmHoldStart = null;
      stopPalmChargeTone();
      endStroke();
      drawCursorFrame(null, null);
      return;
    }
    noHandBanner.classList.add('hidden');

    const lm = results.multiHandLandmarks[0];
    const handednessLabel = results.multiHandedness && results.multiHandedness[0]
      ? results.multiHandedness[0].label
      : 'Right';
    statHand.textContent = 'tracking';

    const rawGesture = classifyGesture(lm, handednessLabel);

    // debounce: require gesture to be stable for GESTURE_STABLE_MS before acting,
    // except pinch/index which should feel instant.
    const now = performance.now();
    if (rawGesture !== state.lastGesture) {
      state.gestureSince = now;
      state.lastGesture = rawGesture;
    }
    const heldLongEnough = (now - state.gestureSince) >= GESTURE_STABLE_MS;
    const instantGestures = new Set(['index_only', 'pinch']);
    const gesture = (instantGestures.has(rawGesture) || heldLongEnough) ? rawGesture : state.stableGesture;

    if (gesture !== state.stableGesture) {
      onGestureChange(state.stableGesture, gesture);
      state.stableGesture = gesture;
    }

    setStatGesture(gestureLabel(gesture));

    const fingertip = toCanvasPoint(lm[8]);
    const erasing = gesture === 'pinch' || state.manualEraser;

    // --- act on current gesture ---
    if (gesture === 'index_only' && !state.manualEraser) {
      if (!state.isDrawingStroke) beginStroke(fingertip);
      else extendStroke(fingertip, false);
    } else if (erasing) {
      const pt = state.manualEraser ? fingertip : midpoint(toCanvasPoint(lm[4]), toCanvasPoint(lm[8]));
      if (!state.isDrawingStroke) beginStroke(pt);
      else extendStroke(pt, true);
    } else {
      endStroke();
    }

    // open palm hold -> clear
    let palmProgress = 0;
    if (gesture === 'open_palm') {
      if (state.palmHoldStart === null) {
        state.palmHoldStart = now;
        startPalmChargeTone();
      }
      palmProgress = clamp((now - state.palmHoldStart) / PALM_HOLD_MS, 0, 1);
      updatePalmChargeTone(palmProgress);
      if (palmProgress >= 1) {
        stopPalmChargeTone();
        clearCanvas(true);
        state.palmHoldStart = null;
        palmProgress = 0;
      }
    } else {
      if (state.palmHoldStart !== null) stopPalmChargeTone();
      state.palmHoldStart = null;
    }

    // two-fingers -> cycle color once per gesture entry
    if (gesture === 'two_fingers') {
      if (state.colorCycleArmed) {
        cycleColor();
        state.colorCycleArmed = false;
      }
    } else {
      state.colorCycleArmed = true;
    }

    drawCursorFrame(lm, fingertip, gesture, erasing, palmProgress);
  }

  function midpoint(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

  function onGestureChange(prev, next) {
    if (next === 'fist') { showToast('PEN UP'); sfxDisengage(); }
    else if (next === 'index_only') { showToast('DRAWING'); sfxEngage(); }
    else if (next === 'pinch') { showToast('ERASER'); sfxEraser(); }
    else if (next === 'open_palm') showToast('HOLD TO CLEAR…');
    if (prev === 'index_only' || prev === 'pinch') endStroke();
  }

  function gestureLabel(g) {
    return {
      idle: 'IDLE',
      fist: 'PEN UP',
      index_only: 'DRAWING',
      two_fingers: 'COLOR',
      open_palm: 'HOLD: CLEAR',
      pinch: 'ERASER',
      unknown: 'IDLE',
    }[g] || 'IDLE';
  }

  /* ------------------------------------------------------------------
     FPS
     ------------------------------------------------------------------ */
  function updateFps() {
    state.fpsFrames += 1;
    const now = performance.now();
    const elapsed = now - state.fpsLastTime;
    if (elapsed >= 500) {
      state.fps = Math.round((state.fpsFrames * 1000) / elapsed);
      statFps.textContent = String(state.fps);
      state.fpsFrames = 0;
      state.fpsLastTime = now;
    }
  }

  /* ------------------------------------------------------------------
     Startup sequence: camera -> MediaPipe -> tracking loop
     ------------------------------------------------------------------ */
  async function startApp() {
    ensureAudio();
    resumeAudio();

    landing.classList.add('hidden');
    loadingOverlay.classList.remove('hidden');
    errorOverlay.classList.add('hidden');
    loadingText.textContent = 'Requesting camera access…';

    // 1. Camera
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        audio: false,
      });
    } catch (err) {
      handleCameraError(err);
      return;
    }

    video.srcObject = stream;
    await new Promise((resolve) => {
      video.onloadedmetadata = () => resolve();
    });
    await video.play();
    state.streaming = true;
    statCamera.textContent = '● LIVE';
    statCamera.classList.add('stat__value--ok');

    // 2. MediaPipe Hands model
    loadingText.textContent = 'Loading hand-tracking model…';
    try {
      if (typeof Hands === 'undefined') {
        throw new Error('MODEL_SCRIPT_MISSING');
      }
      state.hands = new Hands({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
      });
      state.hands.setOptions({
        maxNumHands: 1,
        modelComplexity: 1,
        minDetectionConfidence: 0.65,
        minTrackingConfidence: 0.6,
        selfieMode: true,
      });
      state.hands.onResults(onResults);

      // Warm up the model with a small timeout guard in case the WASM
      // assets fail to fetch (e.g. offline / blocked CDN).
      const modelReady = new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) { settled = true; reject(new Error('MODEL_TIMEOUT')); }
        }, 15000);
        state.hands.initialize().then(() => {
          if (!settled) { settled = true; clearTimeout(timer); resolve(); }
        }).catch((e) => {
          if (!settled) { settled = true; clearTimeout(timer); reject(e); }
        });
      });
      await modelReady;
    } catch (err) {
      handleModelError(err);
      return;
    }

    // 3. Go live
    appEl.classList.remove('hidden');
    loadingOverlay.classList.add('hidden');
    resizeCanvases();
    buildSwatches();
    updateHistoryButtons();
    runDetectionLoop();
  }

  function runDetectionLoop() {
    const loop = async () => {
      if (!state.streaming) return;
      try {
        await state.hands.send({ image: video });
      } catch (e) {
        // transient frame errors shouldn't crash the app
        console.warn('Hand tracking frame error:', e);
      }
      state.cameraLoopId = requestAnimationFrame(loop);
    };
    loop();
  }

  /* ------------------------------------------------------------------
     Error handling
     ------------------------------------------------------------------ */
  function showError(title, message) {
    loadingOverlay.classList.add('hidden');
    errorOverlay.classList.remove('hidden');
    errorTitle.textContent = title;
    errorMessage.textContent = message;
    statCamera.textContent = '● OFFLINE';
    statCamera.classList.remove('stat__value--ok');
  }

  function handleCameraError(err) {
    console.error(err);
    if (err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')) {
      showError('Camera permission denied', 'AI Air Draw needs webcam access to track your hand. Please allow camera access in your browser settings and try again.');
    } else if (err && (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError')) {
      showError('No camera found', 'We couldn\'t find a webcam on this device. Connect a camera and try again.');
    } else if (err && err.name === 'NotReadableError') {
      showError('Camera unavailable', 'Your camera may be in use by another application. Close other apps using the camera and try again.');
    } else {
      showError('Camera error', 'Something went wrong while accessing your camera. Please try again.');
    }
  }

  function handleModelError(err) {
    console.error(err);
    const msg = (err && err.message) || '';
    if (msg === 'MODEL_SCRIPT_MISSING') {
      showError('Hand-tracking model failed to load', 'The MediaPipe library could not be loaded from the CDN. Check your internet connection and try again.');
    } else if (msg === 'MODEL_TIMEOUT') {
      showError('Hand-tracking model timed out', 'Loading the hand-tracking model took too long, likely due to a slow or blocked connection. Please try again.');
    } else {
      showError('Hand-tracking failed to initialize', 'Something went wrong loading the hand-tracking model. Please try again.');
    }
    // stop any camera stream we opened
    const s = video.srcObject;
    if (s) s.getTracks().forEach((t) => t.stop());
    state.streaming = false;
  }

  errorRetryBtn.addEventListener('click', () => {
    errorOverlay.classList.add('hidden');
    landing.classList.remove('hidden');
  });

  /* ------------------------------------------------------------------
     Keyboard shortcuts (bonus UX, non-essential)
     ------------------------------------------------------------------ */
  window.addEventListener('keydown', (e) => {
    if (appEl.classList.contains('hidden')) return;
    if (e.key === 'z' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); undo(); }
    if (e.key === 'y' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); redo(); }
    if (e.key === 'c') clearCanvas(true);
    if (e.key === 'e') eraserBtn.click();
    if (e.key === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveBtn.click(); }
    if (e.key === 'm') muteBtn.click();
  });

  /* ------------------------------------------------------------------
     Init
     ------------------------------------------------------------------ */
  startBtn.addEventListener('click', startApp);
  buildSwatches();

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    startBtn.addEventListener('click', () => {}, { once: true });
    startBtn.disabled = false;
  }
})();
