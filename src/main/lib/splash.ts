import { BrowserWindow, nativeTheme } from 'electron'
import { MARK, MARK_FROM, MARK_TO } from '@shared/mark'

/**
 * The window that stands in for the app while there is nothing to show.
 *
 * Opening Neo is not instant and cannot be: the database is PostgreSQL compiled to
 * WebAssembly, and `initDb()` boots it, applies the schema, checks the catalogue for
 * damage and sweeps orphaned files before there is anything a window could draw. All
 * of that happens before `createWindow()` is even called, so the whole of it used to
 * be a bouncing dock icon and nothing else — and then a blank pane, because the
 * renderer's first paint is `Gate` waiting on its own first query.
 *
 * So the splash covers *both* gaps, and the second one is why it waits for the
 * renderer rather than for the database: it is dismissed by `window:ready`, which the
 * app sends on the first render that has real data. Between those two moments there
 * is exactly one thing on screen, and it is deliberate.
 *
 * It is a window and not a screen inside the app because the app does not exist yet.
 * Everything it needs is in the document below — no file to find, no dev server to be
 * up, no stylesheet, no script — so it paints on the first frame after `whenReady`.
 */

/**
 * How long it stays up at the very least. A splash that flashes for 120ms on a warm
 * cache reads as a glitch, not as an opening; this is the floor that makes it look
 * like a decision. It is not a delay added to startup — the real window is shown at
 * the *start* of the fade, so the app is already there behind the mark.
 */
const MINIMUM_MS = 520

/** The dissolve. Long enough to read as a hand-off, short enough not to be a wait. */
const FADE_MS = 260

/**
 * The backstop. A renderer that throws before its first render never sends
 * `window:ready`, and the one thing worse than a blank window is a splash screen over
 * a blank window forever.
 */
const GIVE_UP_MS = 15_000

let splash: BrowserWindow | null = null
let shownAt = 0
let main: BrowserWindow | null = null
let handedOver = false
let giveUp: NodeJS.Timeout | null = null

/**
 * `transparent: true` here and nowhere else.
 *
 * The main window must never be transparent — Chromium cannot run a `backdrop-filter`
 * in a transparent window and fails silently, which costs the Liquid Glass theme every
 * blurred menu and dialog it has. Nothing in this document filters its backdrop; it
 * draws a mark on nothing at all, which is exactly what a transparent window is for.
 */
function open(): BrowserWindow {
  const window = new BrowserWindow({
    width: 300,
    height: 300,
    center: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Above the real window, which is shown underneath it while it is dissolving.
    alwaysOnTop: true,
    title: 'Neo',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  const html = splashDocument(nativeTheme.shouldUseDarkColors)
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) window.showInactive()
  })
  return window
}

/** Put it on screen. Called first thing on startup, before anything is opened. */
export function openSplash(): void {
  if (splash) return
  splash = open()
  shownAt = Date.now()
  giveUp = setTimeout(handOver, GIVE_UP_MS)
}

/** Is one up? Decides whether the real window shows itself or waits to be shown. */
export function splashOpen(): boolean {
  return splash !== null
}

/** The window the splash is standing in for, so the hand-off has something to reveal. */
export function splashFor(window: BrowserWindow): void {
  main = window
}

/**
 * There is something real to show.
 *
 * Idempotent, and called from three places that can all be first: the renderer saying
 * it has drawn, the backstop above, and a failed startup that has an error box to put
 * on screen instead. The real window is revealed *before* the fade begins rather than
 * after it ends, so what happens is a dissolve onto the app and not a gap followed by
 * a window appearing.
 */
export function handOver(): void {
  if (handedOver) return
  handedOver = true
  if (giveUp) clearTimeout(giveUp)
  giveUp = null

  if (main && !main.isDestroyed()) {
    main.show()
    main.focus()
  }

  const window = splash
  splash = null
  if (!window || window.isDestroyed()) return

  const wait = Math.max(0, MINIMUM_MS - (Date.now() - shownAt))
  setTimeout(() => {
    if (window.isDestroyed()) return
    /*
     * Inserted CSS rather than `executeJavaScript`, and a transition rather than an
     * animation. The first because a stylesheet is not script and cannot be refused
     * by a content policy; the second because the mark may still be arriving when
     * this lands — a transition takes over from wherever it has got to, where an
     * animation would snap it to its final frame and then fade that.
     */
    void window.webContents
      .insertCSS('.stage { opacity: 0 !important; transform: scale(1.06) !important; filter: blur(3px) !important; }')
      .catch(() => {})
    setTimeout(() => {
      if (!window.isDestroyed()) window.destroy()
    }, FADE_MS)
  }, wait)
}

/** Take it away now, with no ceremony — for a startup that failed and has to say so. */
export function abandonSplash(): void {
  handedOver = true
  if (giveUp) clearTimeout(giveUp)
  giveUp = null
  if (splash && !splash.isDestroyed()) splash.destroy()
  splash = null
}

const rect = (x: number, y: number, size: number, r: number, extra = ''): string =>
  `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${r}"${extra ? ` ${extra}` : ''}/>`

/**
 * The whole splash, as one string.
 *
 * Self-contained on purpose: no external stylesheet, no image, no font file and no
 * script. It is loaded as a `data:` URL, so anything it referenced would be resolved
 * against nothing and quietly not appear — and it has to paint on the first frame,
 * which is the entire point of it.
 *
 * The theme comes from the operating system rather than from settings, because
 * settings live in the database and the database is what we are waiting for. The
 * cost of being wrong is small and bounded: someone running the app in Light on a
 * dark desktop gets a wordmark in the other ink for half a second. The mark itself
 * is the mark in either.
 */
export function splashDocument(dark: boolean): string {
  const ink = dark ? 'rgba(255,255,255,0.92)' : 'rgba(24,24,27,0.72)'
  const shadow = dark ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.65)'
  // The face is inset in the 1024 grid, and the squircle's radius is a fraction of
  // the face — both worked out here so the sheen is clipped to the shape exactly.
  const inset = `${(MARK.face.x / 1024) * 100}%`
  const radius = `${(MARK.face.r / MARK.face.size) * 100}%`

  const steps = MARK.steps
    .map((s, i) => rect(s.x, s.y, MARK.step.size, MARK.step.r, `class="step" style="animation-delay:${120 + i * 90}ms"`))
    .join('')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>Neo</title>
<style>
  html, body { height: 100%; margin: 0; background: transparent; overflow: hidden; }
  body {
    display: grid;
    place-items: center;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    cursor: default;
    user-select: none;
  }

  /*
   * The one element the hand-off touches. It carries no entrance animation of its
   * own — everything inside it does — so the exit transition below can interrupt an
   * arrival that is still in progress instead of fighting it.
   */
  .stage {
    position: relative;
    display: grid;
    justify-items: center;
    gap: 20px;
    transition:
      opacity ${FADE_MS}ms ease,
      transform ${FADE_MS}ms cubic-bezier(0.4, 0, 0.7, 0.2),
      filter ${FADE_MS}ms ease;
  }

  /* The mark's own light, breathing, so a slow start looks alive rather than stuck. */
  .glow {
    position: absolute;
    /* Centred on the mark: (200 - 104) / 2 out on every side. */
    top: -48px;
    left: -48px;
    width: 200px;
    height: 200px;
    border-radius: 50%;
    background: radial-gradient(closest-side, ${MARK_FROM}66, ${MARK_TO}33 58%, transparent);
    filter: blur(22px);
    animation: glow-in 700ms ease-out both, breathe 3200ms ease-in-out 700ms infinite;
  }

  .mark {
    position: relative;
    width: 104px;
    height: 104px;
    animation: mark-in 460ms cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  /* Positioned, so it paints over the glow rather than under it. */
  .mark svg {
    position: relative;
    z-index: 1;
    display: block;
    width: 100%;
    height: 100%;
    filter: drop-shadow(0 14px 26px ${MARK_FROM}47);
  }

  /* Bottom-left first, reading up the diagonal, each arriving from below and behind. */
  .step {
    opacity: 0;
    transform-box: fill-box;
    transform-origin: center;
    animation: step-in 420ms cubic-bezier(0.2, 0.85, 0.3, 1) both;
  }

  /* A single pass of light across the face, clipped to the squircle. */
  .sheen {
    position: absolute;
    z-index: 2;
    inset: ${inset};
    border-radius: ${radius};
    overflow: hidden;
    pointer-events: none;
  }
  .sheen::after {
    content: '';
    position: absolute;
    top: -50%;
    bottom: -50%;
    left: -60%;
    width: 34%;
    background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.5), transparent);
    animation: sheen 2400ms cubic-bezier(0.45, 0, 0.3, 1) 460ms infinite;
  }

  .word {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    color: ${ink};
    text-shadow: 0 1px 2px ${shadow};
    /* The indent is the trailing letter-space given back, so it stays optically centred. */
    letter-spacing: 0.36em;
    text-indent: 0.36em;
    animation: word-in 620ms cubic-bezier(0.16, 1, 0.3, 1) 260ms both;
  }

  @keyframes mark-in {
    from { opacity: 0; transform: scale(0.84) translateY(6px); }
    to   { opacity: 1; transform: none; }
  }
  @keyframes step-in {
    from { opacity: 0; transform: translate(-70px, 70px) scale(0.6); }
    to   { opacity: 1; transform: none; }
  }
  @keyframes glow-in {
    from { opacity: 0; transform: scale(0.7); }
    to   { opacity: 1; transform: none; }
  }
  @keyframes breathe {
    0%, 100% { opacity: 0.75; transform: scale(0.96); }
    50%      { opacity: 1;    transform: scale(1.06); }
  }
  @keyframes sheen {
    0%        { transform: translateX(0) rotate(16deg); }
    45%, 100% { transform: translateX(880%) rotate(16deg); }
  }
  @keyframes word-in {
    from { opacity: 0; letter-spacing: 0.62em; text-indent: 0.62em; }
    to   { opacity: 0.62; letter-spacing: 0.36em; text-indent: 0.36em; }
  }

  /*
   * Asked not to move, it does not move — but it still has to be *there*, because it
   * is the only thing on screen while the app opens. So everything arrives at once,
   * by fading, and nothing travels, scales, breathes or sweeps.
   */
  @media (prefers-reduced-motion: reduce) {
    .glow { animation: glow-in 300ms ease-out both; }
    .mark { animation: glow-in 300ms ease-out both; }
    .step { opacity: 1; animation: none; }
    .sheen { display: none; }
    .word { opacity: 0.62; animation: none; }
  }
</style>
</head>
<body>
  <div class="stage">
    <div class="mark">
      <div class="glow"></div>
      <svg viewBox="0 0 1024 1024" aria-hidden="true">
        <defs>
          <linearGradient id="face" gradientUnits="userSpaceOnUse"
            x1="${MARK.face.x}" y1="${MARK.face.y}"
            x2="${MARK.face.x + MARK.face.size}" y2="${MARK.face.y + MARK.face.size}">
            <stop offset="0" stop-color="${MARK_FROM}"/>
            <stop offset="1" stop-color="${MARK_TO}"/>
          </linearGradient>
        </defs>
        ${rect(MARK.face.x, MARK.face.y, MARK.face.size, MARK.face.r, 'fill="url(#face)"')}
        <g fill="#fff">${steps}</g>
      </svg>
      <div class="sheen"></div>
    </div>
    <div class="word">Neo</div>
  </div>
</body>
</html>`
}
