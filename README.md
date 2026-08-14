# AI AIR DRAW

Draw in the air. Create on screen.

A browser-only, no-backend "air drawing" app. It uses your webcam and
[MediaPipe Hands](https://developers.google.com/mediapipe/solutions/vision/hand_landmarker)
to track your index fingertip in real time and turns it into a glowing
drawing pen — controlled entirely by hand gestures.

Everything runs **locally in your browser**. Your webcam video is never
uploaded anywhere; the hand-tracking model itself is fetched from a CDN the
first time you load the page, then runs on-device.

---

## 1. How the hand tracking works

- `script.js` requests your webcam via `navigator.mediaDevices.getUserMedia()`.
- Every animation frame, the raw (unmirrored) video frame is handed to
  **MediaPipe Hands** (`hands.send({ image: video })`).
- MediaPipe returns 21 normalized landmarks per detected hand (wrist,
  finger joints, fingertips), each as `{x, y, z}` in the 0–1 range, plus a
  `handedness` label (Left/Right).
- Landmark **8** is the index fingertip. Its `(x, y)` is converted into
  canvas pixel coordinates:

  ```js
  const x = (1 - landmark.x) * canvas.width; // flipped because the
  const y = landmark.y * canvas.height;      // video is mirrored on screen
  ```

  The video element is displayed mirrored (`transform: scaleX(-1)`) so
  movement feels natural (move your hand right, the cursor moves right).
  Since MediaPipe processes the *raw, unmirrored* camera frame, we flip the
  X coordinate ourselves when mapping to canvas space.
- The fingertip position is smoothed with an exponential moving average
  (`SMOOTHING = 0.55` in `script.js`) so the line doesn't look shaky from
  natural hand tremor or per-frame jitter.
- The drawing itself lives on its own transparent `<canvas>` layer
  (`#drawCanvas`), stacked above the mirrored `<video>` element and below a
  `#cursorCanvas` layer used only for the glow cursor/particles/HUD, which
  is cleared and redrawn every frame.

## 2. How to run the project

No build step, no server required for local use — but browsers require a
**secure context** to grant camera access, so you generally can't just
double-click `index.html` from `file://` in every browser. Two easy options:

**Option A — quick local server (recommended)**
```bash
cd air-drawing
python3 -m http.server 8080
# then open http://localhost:8080 in your browser
```

**Option B — VS Code Live Server** (or any static file server) pointed at
the `air-drawing/` folder.

Then click **"Enable Camera & Start"**, grant camera permission, and wait a
moment for the hand-tracking model to load.

> Chrome, Edge, and Firefox (recent versions) all work well. Safari works
> but can be pickier about camera permissions and WASM performance.

## 3. How gestures are detected

Gestures are computed every frame from the 21 hand landmarks, in
`classifyGesture()` inside `script.js`:

| Gesture | Rule | Action |
|---|---|---|
| ☝️ Index only | index tip above its knuckle; middle/ring/pinky curled | **Draw** |
| ✊ Fist | all four fingers curled | **Pen up** |
| ✌️ Two fingers | index + middle up, ring + pinky curled | **Change color** (cycles the palette, once per gesture) |
| 🤏 Pinch | distance between thumb tip and index tip is small (scaled by hand size) | **Eraser**, active at the midpoint of thumb & index |
| 🖐️ Open palm | all four fingers up, held ~1.5s | **Clear canvas** (shows a radial progress ring, then a flash) |

Two extra details worth knowing:

- **A finger counts as "up"** when its fingertip landmark's `y` is above
  (smaller than) its PIP-joint landmark's `y` — a standard, lightweight
  heuristic that works well when the hand roughly faces the camera. The
  thumb uses an `x`-comparison instead, since it doesn't fold vertically.
- **Debouncing:** every raw gesture must hold steady for
  `GESTURE_STABLE_MS` (120ms) before it's treated as "confirmed", except
  drawing and erasing, which are made instant for responsiveness. This
  avoids flicker between similar hand shapes.

The current gesture is always shown in the top status bar and as a toast
over the canvas when it changes.

## 4. How to change the gesture rules

All gesture logic is isolated in two functions near the top of
`script.js`:

- `classifyFingers(lm, handednessLabel)` — returns which fingers are up.
- `classifyGesture(lm, handednessLabel)` — turns finger states + pinch
  distance into one of: `'index_only'`, `'fist'`, `'open_palm'`,
  `'two_fingers'`, `'pinch'`, `'unknown'`.

To tune sensitivity, adjust the constants near the top of the file:

```js
const PINCH_THRESHOLD    = 0.055; // smaller = pinch must be tighter
const PALM_HOLD_MS       = 1500;  // how long to hold open palm to clear
const GESTURE_STABLE_MS  = 120;   // debounce time before a gesture "locks in"
const SMOOTHING          = 0.55;  // 0 = no smoothing, closer to 1 = very smooth/laggy
```

## 5. How to add additional hand gestures later

1. Add a new case to `classifyGesture()` that returns a new string, e.g.
   `'rock_on'` for pinky + index up with middle/ring down:
   ```js
   if (f.indexUp && !f.middleUp && !f.ringUp && f.pinkyUp) return 'rock_on';
   ```
   (Add this check *before* the more general `two_fingers` / `index_only`
   checks so it isn't shadowed.)
2. Give it a label in `gestureLabel()` so it shows in the status bar.
3. Wire up its behavior in `onResults()` (where `index_only`, `pinch`,
   `open_palm`, and `two_fingers` are handled) or in `onGestureChange()` if
   it's a one-shot action (like color-cycling) rather than a held state.
4. If it needs a "held for N seconds" confirmation like open-palm-to-clear,
   copy the `palmHoldStart` / `palmProgress` pattern.

## 6. How to deploy to GitHub Pages

1. Push the `air-drawing/` folder to a GitHub repository (it can be the
   whole repo root, or a subfolder — GitHub Pages just needs `index.html`
   at the published root).
2. In the repo, go to **Settings → Pages**.
3. Under **Build and deployment → Source**, choose **Deploy from a
   branch**.
4. Pick your branch (e.g. `main`) and the folder (`/root` if
   `index.html` is at the repo root, or `/docs` if you've placed the app
   there).
5. Save. GitHub will publish to `https://<username>.github.io/<repo>/`
   (or `https://<org>.github.io/<repo>/` for an organization) within a
   minute or two.
6. Because camera access requires a secure context, `https://` GitHub
   Pages URLs work out of the box — no extra configuration needed.

---

## Project structure

```
air-drawing/
├── index.html   # markup: landing screen, HUD/status bar, canvas stage, control dock
├── style.css    # dark glassmorphism / HUD visual design, responsive layout
├── script.js    # webcam capture, MediaPipe Hands integration, gesture logic,
│                # drawing engine, undo/redo, save, error handling
└── README.md    # this file
```

## Controls reference

- **Color picker / swatches** — pick a color, or use the ✌️ two-finger
  gesture to cycle through the palette.
- **Brush size slider** — 2–40px.
- **Eraser button** — manual toggle (in addition to the 🤏 pinch gesture).
- **Undo / Redo** — also `Ctrl/Cmd+Z` / `Ctrl/Cmd+Y`.
- **Clear** — also the `C` key or the 🖐️ held-open-palm gesture.
- **Save PNG** — also `Ctrl/Cmd+S`. Includes the mirrored webcam frame as a
  background if "Webcam BG" is on, otherwise saves a transparent-background
  PNG of just your drawing.
- **Webcam BG toggle** — show/hide the camera feed behind your drawing.
- **Fullscreen button** — expands the app to fullscreen.

## Troubleshooting

- **"Camera permission denied"** — check your browser's site settings and
  allow camera access, then retry.
- **"No camera found" / "Camera unavailable"** — make sure a webcam is
  connected and not in use by another app (e.g. a video call).
- **"Hand-tracking model failed to load"** — this app loads MediaPipe from
  a CDN (`cdn.jsdelivr.net`) on first run; check your internet connection
  or any ad-blocker/firewall that might be blocking CDN scripts.
- **Drawing feels laggy or jumpy** — lower `SMOOTHING` slightly, ensure
  good, even lighting, and make sure no other heavy tabs/apps are
  competing for CPU/GPU.
