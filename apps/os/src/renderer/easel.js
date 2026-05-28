/* easel.js — the "easel" app: project a screen or window over NDI.
 *
 * Pick a capture source → "go live" → we draw each captured frame to a canvas
 * at the source's native resolution (capped by the quality toggle: 1080p / 720p)
 * and ship the RGBA pixels to the main process (apps/os/easel-ndi.js),
 * which broadcasts them as an NDI source on the LAN. Any NDI receiver — the
 * projector tonight, OBS, easel itself — can then pull the stream.
 *
 * macOS for now: screen capture needs Screen Recording permission granted to
 * the app in System Settings → Privacy & Security.
 *
 * Lifecycle mirrors atlas.js: mount(stage) / setActive(bool) / notifyDataChanged().
 */

import { getIdentity } from "./identity.js";

const FPS = 30;
// Output resolution adapts to the captured source, capped by the chosen
// quality (even dimensions, downscale-only). "high" = up to 1080p (crisp on a
// projector), "fast" = up to 720p (lighter IPC if 1080p janks).
const QUALITY_CAP = { high: { w: 1920, h: 1080 }, fast: { w: 1280, h: 720 } };
const PREFS_KEY = "srwk:easel:prefs";
// macOS deep-link straight to the Screen Recording permission pane.
const SCREEN_RECORDING_SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
function loadEaselPrefs() { try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; } }
function saveEaselPrefs(p) { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch {} }

let _stage = null;
let _publishedName = "";
let _active = false;
let _live = false;
let _ndiAvailable = true;
let _sources = [];
let _selectedId = null;
let _stream = null;
let _video = null;
let _canvas = null;
let _ctx = null;
let _pumpTimer = null;
let _statsTimer = null;
let _quality = "high";
let _outW = 1280;
let _outH = 720;

// "Watching the LAN" — receive side.
let _watchCanvas = null;
let _watchCtx = null;
let _watchOverlay = null;
let _watchSources = [];
let _watchSelected = null;     // name of the source we're currently receiving
let _watchFrameUnsub = null;   // detach function from window.api.easel.onRxFrame
let _watchFrames = 0;
let _watchStartMs = 0;
let _liveStartMs = 0;
let _infoTick = null;          // 1s ticker that updates the viewer's duration

// ─── twitch-y helpers ─────────────────────────────────────────────────
// Deterministic hue from a source name so each "channel" gets a distinct
// but stable color across renders + clients.
function hashHue(str) {
  let h = 0;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) h = ((h * 31) + s.charCodeAt(i)) | 0;
  return ((h % 360) + 360) % 360;
}
// First letter (or • fallback) — used in the avatar circle.
function initialOf(name) {
  const m = String(name || "").trim().match(/[A-Za-z0-9]/);
  return m ? m[0].toUpperCase() : "•";
}
// mm:ss / h:mm:ss for the live-duration ticker.
function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "00:00";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}
// Strip the daemon's "HOSTNAME.LAN (foo)" prefix to the friendly inner name.
function shortName(full) {
  const m = String(full || "").match(/\(([^)]+)\)\s*$/);
  return m ? m[1] : String(full || "");
}

// Output dims = source size scaled down to fit the quality cap, aspect kept,
// rounded to even (some NDI receivers dislike odd dimensions).
function computeOutputDims() {
  const cap = QUALITY_CAP[_quality] || QUALITY_CAP.high;
  const vw = _video && _video.videoWidth ? _video.videoWidth : cap.w;
  const vh = _video && _video.videoHeight ? _video.videoHeight : cap.h;
  const scale = Math.min(1, cap.w / vw, cap.h / vh);
  return { w: Math.max(2, Math.round(vw * scale / 2) * 2), h: Math.max(2, Math.round(vh * scale / 2) * 2) };
}
function applyOutputDims() {
  const d = computeOutputDims();
  _outW = d.w; _outH = d.h;
  if (_canvas) { _canvas.width = _outW; _canvas.height = _outH; }
}

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export async function mount(stage) {
  if (!stage) return;
  // Idempotent: re-entering the view must not rebuild (and clobber a live
  // broadcast). applyActiveTab can call mount repeatedly.
  if (_stage === stage && stage.querySelector(".easel-app")) return;
  _stage = stage;
  _ndiAvailable = await safe(() => window.api.easel.available(), false);
  renderShell();
  if (_ndiAvailable) await loadSources();
}

export function setActive(on) {
  _active = !!on;
  // Intentionally DO NOT stop the broadcast when leaving the easel view. A
  // projection is meant to keep running while you use the rest of the OS (or
  // switch to another app) — tearing it down on navigate-away was killing the
  // NDI stream the moment you clicked elsewhere. The capture pump + NDI sender
  // stay live until you explicitly stop or quit; returning re-attaches to the
  // still-running stream (mount() is idempotent, so the live preview persists).
}

export function notifyDataChanged() { /* nothing data-driven here */ }

async function safe(fn, fallback) { try { return await fn(); } catch { return fallback; } }

function renderShell() {
  // Prefill the NDI name from a saved value or the claimed identity, so each
  // person's source is distinguishable on the network (not a wall of "Easel").
  const prefs = loadEaselPrefs();
  const id = getIdentity();
  const defaultName = esc(prefs.name || (id && id.display_name) || "Easel");
  _quality = prefs.quality === "fast" ? "fast" : "high";
  _stage.innerHTML = `
    <div class="easel-app easel-app--twocol">
      <header class="easel-head easel-head--compact">
        <div class="easel-head-text">
          <p class="easel-eyebrow">apps · projection</p>
          <h1 class="easel-title">easel</h1>
          <p class="easel-sub">broadcast over <strong>NDI</strong> + watch other cohort streams on the LAN.</p>
        </div>
      </header>
      ${_ndiAvailable ? "" : `<div class="easel-banner easel-banner-warn">NDI runtime not available — the native sender failed to load. (Install NDI Tools, then reopen easel.)</div>`}

      <div class="easel-grid">
        <aside class="easel-side">
          <section class="easel-panel">
            <header class="easel-panel-head">
              <span class="easel-panel-eyebrow">broadcast</span>
              <span class="easel-status" data-easel-status></span>
            </header>
            <div class="easel-sources" data-easel-sources></div>
            <label class="easel-namefield">
              <span>NDI name</span>
              <input type="text" data-easel-name value="${defaultName}" maxlength="48" spellcheck="false" />
            </label>
            <div class="easel-control-row">
              <div class="easel-quality" role="group" aria-label="output quality">
                <button class="easel-q-btn" type="button" data-quality="high" aria-selected="${_quality === "high"}">1080p</button>
                <button class="easel-q-btn" type="button" data-quality="fast" aria-selected="${_quality === "fast"}">720p</button>
              </div>
              <button class="easel-go" type="button" data-easel-go disabled>go live</button>
            </div>
            <div class="easel-err" data-easel-err hidden></div>
          </section>

          ${_ndiAvailable ? `
          <section class="easel-panel">
            <header class="easel-panel-head">
              <span class="easel-panel-eyebrow">watching the LAN</span>
              <span class="easel-watch-status" data-watch-status>—</span>
              <button class="easel-watch-refresh" type="button" data-watch-refresh aria-label="refresh">↻</button>
            </header>
            <ul class="easel-watch-list" data-watch-list role="list">
              <li class="easel-watch-loading">scanning…</li>
            </ul>
          </section>` : ""}
        </aside>

        <main class="easel-viewer" data-viewer-mode="empty">
          <div class="easel-viewer-tabs" role="tablist">
            <button class="easel-viewer-tab is-active" type="button" data-viewer-tab="preview" role="tab">preview</button>
            ${_ndiAvailable ? `<button class="easel-viewer-tab" type="button" data-viewer-tab="watch" role="tab">watching</button>` : ""}
            <span class="easel-viewer-meta" data-viewer-meta></span>
          </div>
          <div class="easel-viewer-stage">
            <canvas class="easel-canvas" width="1280" height="720" data-easel-canvas></canvas>
            ${_ndiAvailable ? `<canvas class="easel-watch-canvas" width="640" height="360" data-watch-canvas></canvas>` : ""}
            <div class="easel-viewer-overlay" data-easel-overlay>pick a screen below to preview, then go live</div>
            ${_ndiAvailable ? `<div class="easel-viewer-overlay" data-watch-overlay hidden>pick a stream from the LAN list to watch</div>` : ""}
          </div>
          <footer class="easel-viewer-info" data-viewer-info hidden>
            <span class="evi-avatar" data-evi-avatar>•</span>
            <div class="evi-text">
              <div class="evi-title-row">
                <span class="evi-title" data-evi-title>—</span>
                <span class="evi-live" data-evi-live hidden><span class="evi-live-dot"></span>LIVE</span>
              </div>
              <div class="evi-meta-row">
                <span class="evi-kind" data-evi-kind></span>
                <span class="evi-sep">·</span>
                <span class="evi-duration" data-evi-duration>00:00</span>
              </div>
            </div>
          </footer>
        </main>
      </div>
    </div>`;

  _canvas = _stage.querySelector("[data-easel-canvas]");
  _ctx = _canvas.getContext("2d", { willReadFrequently: true });
  _video = document.createElement("video");
  _video.muted = true; _video.playsInline = true;

  _stage.querySelector("[data-easel-go]").addEventListener("click", () => (_live ? stopLive() : goLive()));
  _stage.querySelectorAll(".easel-q-btn").forEach((b) => b.addEventListener("click", () => setQuality(b.getAttribute("data-quality"))));

  // Wire the "watching the LAN" surface (present only when NDI is available).
  _watchCanvas = _stage.querySelector("[data-watch-canvas]");
  _watchCtx = _watchCanvas ? _watchCanvas.getContext("2d") : null;
  _watchOverlay = _stage.querySelector("[data-watch-overlay]");
  if (_watchCanvas) {
    _stage.querySelector("[data-watch-refresh]").addEventListener("click", () => loadWatchSources());
    loadWatchSources();
  }

  // Viewer mode tabs — preview (your broadcast) vs watching (a LAN stream).
  _stage.querySelectorAll("[data-viewer-tab]").forEach((btn) => {
    btn.addEventListener("click", () => setViewerMode(btn.getAttribute("data-viewer-tab"), { user: true }));
  });

  refreshStatus(null);
}

// Drive what the right-pane viewer shows. Modes:
//   empty   — neither side has content yet
//   preview — your broadcast preview canvas
//   watch   — a LAN stream's receive canvas
// Auto-switches on selectSource / watchSelect; manual tab clicks pass {user:true}.
function setViewerMode(mode, { user = false } = {}) {
  if (mode !== "preview" && mode !== "watch" && mode !== "empty") return;
  const viewer = _stage && _stage.querySelector(".easel-viewer");
  if (!viewer) return;
  // If the user explicitly clicks a tab whose side has no content, fall back
  // to the empty state for that tab (we still flip the tab so they see it).
  viewer.dataset.viewerMode = mode;
  for (const t of _stage.querySelectorAll("[data-viewer-tab]")) {
    t.classList.toggle("is-active", t.getAttribute("data-viewer-tab") === mode);
  }
  const meta = _stage.querySelector("[data-viewer-meta]");
  if (meta) {
    meta.textContent = mode === "watch" && _watchSelected
      ? `watching · ${_watchSelected}`
      : mode === "preview" && _live
        ? `live · ${_publishedName || ""}`
        : "";
  }
  void user; // marker kept for future hooks
  syncViewerInfo();
}

async function loadWatchSources() {
  const list = _stage.querySelector("[data-watch-list]");
  const statusEl = _stage.querySelector("[data-watch-status]");
  if (!list) return;
  list.innerHTML = `<li class="easel-watch-loading">scanning…</li>`;
  if (statusEl) statusEl.textContent = "scanning…";
  const sources = await safe(() => window.api.easel.findNdi({ timeoutMs: 3000 }), []);
  _watchSources = Array.isArray(sources) ? sources : [];
  if (statusEl) statusEl.textContent = `${_watchSources.length} found`;
  if (!_watchSources.length) {
    list.innerHTML = `<li class="easel-watch-empty">no NDI sources on the LAN yet — when a cohort peer goes live, they'll show up here.</li>`;
    return;
  }
  list.innerHTML = _watchSources.map((s) => {
    const active = _watchSelected === s.name;
    const hue = hashHue(s.name);
    const initial = initialOf(shortName(s.name));
    const friendly = esc(shortName(s.name));
    return `<li><button type="button" class="ews-card${active ? " is-watching" : ""}" data-watch-src="${esc(s.name)}">
      <span class="ews-thumb" style="--ews-h:${hue}">
        <span class="ews-avatar" style="--ews-h:${hue}">${esc(initial)}</span>
        ${active ? `<span class="ews-live"><span class="ews-live-dot"></span>LIVE</span>` : ""}
      </span>
      <span class="ews-meta">
        <span class="ews-name">${friendly}</span>
        <span class="ews-sub">${esc(s.name)}</span>
      </span>
    </button></li>`;
  }).join("");
  list.querySelectorAll("[data-watch-src]").forEach((btn) => {
    btn.addEventListener("click", () => watchSelect(btn.getAttribute("data-watch-src")));
  });
}

// Update the viewer's info bar (avatar + title + LIVE + duration) to match
// the current mode. Called from setViewerMode, on go/stop, and by the 1s tick.
function syncViewerInfo() {
  const info = _stage && _stage.querySelector("[data-viewer-info]");
  if (!info) return;
  const mode = _stage.querySelector(".easel-viewer")?.dataset.viewerMode;
  const avatarEl = _stage.querySelector("[data-evi-avatar]");
  const titleEl = _stage.querySelector("[data-evi-title]");
  const kindEl = _stage.querySelector("[data-evi-kind]");
  const liveEl = _stage.querySelector("[data-evi-live]");
  const durEl = _stage.querySelector("[data-evi-duration]");
  let name = "", kind = "", liveNow = false, startMs = 0, hue = 0;
  if (mode === "preview" && (_live || _selectedId)) {
    name = _live ? (shortName(_publishedName) || "Easel") : (_sources.find(s => s.id === _selectedId)?.name || "preview");
    kind = "your broadcast";
    liveNow = _live;
    startMs = _liveStartMs;
    hue = hashHue(name);
  } else if (mode === "watch" && _watchSelected) {
    name = shortName(_watchSelected);
    kind = "LAN · NDI";
    liveNow = true;
    startMs = _watchStartMs;
    hue = hashHue(_watchSelected);
  } else {
    info.hidden = true;
    if (_infoTick) { clearInterval(_infoTick); _infoTick = null; }
    return;
  }
  info.hidden = false;
  if (avatarEl) {
    avatarEl.textContent = initialOf(name);
    avatarEl.style.setProperty("--ews-h", hue);
  }
  if (titleEl) titleEl.textContent = name;
  if (kindEl) kindEl.textContent = kind;
  if (liveEl) liveEl.hidden = !liveNow;
  if (durEl) durEl.textContent = liveNow && startMs ? fmtDuration(Date.now() - startMs) : "—";
  // Keep the duration ticking while a stream is live.
  if (liveNow && !_infoTick) {
    _infoTick = setInterval(syncViewerInfo, 1000);
  } else if (!liveNow && _infoTick) {
    clearInterval(_infoTick); _infoTick = null;
  }
}

async function watchSelect(sourceName) {
  if (!sourceName) return;
  // Toggle off if clicking the active source.
  if (_watchSelected === sourceName) { await watchStop(); return; }
  // Tear down any previous stream first.
  await watchStop();
  _watchSelected = sourceName;
  if (_watchOverlay) { _watchOverlay.textContent = `connecting to ${sourceName}…`; _watchOverlay.hidden = false; }
  // Attach the frame listener BEFORE asking main to start, so we don't drop
  // the first frame.
  _watchFrameUnsub = window.api.easel.onRxFrame((frame) => onRxFrame(frame));
  const res = await safe(() => window.api.easel.rxStart(sourceName), { ok: false, error: "rx failed" });
  if (!res || res.ok === false) {
    if (_watchOverlay) { _watchOverlay.textContent = (res && res.error) || "couldn't open that stream"; _watchOverlay.hidden = false; }
    if (_watchFrameUnsub) { _watchFrameUnsub(); _watchFrameUnsub = null; }
    _watchSelected = null;
    await loadWatchSources();    // re-render to clear selection
    return;
  }
  _watchFrames = 0;
  _watchStartMs = Date.now();
  // Re-render the list to mark the selected source.
  await loadWatchSources();
  setViewerMode("watch");
}

async function watchStop() {
  if (_watchFrameUnsub) { try { _watchFrameUnsub(); } catch {} _watchFrameUnsub = null; }
  await safe(() => window.api.easel.rxStop());
  _watchSelected = null;
  _watchFrames = 0;
  if (_watchCtx && _watchCanvas) _watchCtx.clearRect(0, 0, _watchCanvas.width, _watchCanvas.height);
  if (_watchOverlay) { _watchOverlay.textContent = "pick a stream from the LAN list to watch"; _watchOverlay.hidden = false; }
  // Fall back to the broadcast preview if there is one, else go empty.
  setViewerMode((_selectedId || _live) ? "preview" : "empty");
}

function onRxFrame(frame) {
  if (!_watchCtx || !frame || !frame.data) return;
  const { width, height, lineStride, data } = frame;
  if (!width || !height) return;
  if (_watchCanvas.width !== width || _watchCanvas.height !== height) {
    _watchCanvas.width = width;
    _watchCanvas.height = height;
  }
  const expected = width * 4;
  let buf;
  if (lineStride === expected) {
    // Tight RGBA — view directly without copy.
    buf = new Uint8ClampedArray(data.buffer, data.byteOffset, width * height * 4);
  } else {
    // Padded stride — copy row-by-row into a tight buffer for ImageData.
    buf = new Uint8ClampedArray(width * height * 4);
    const src = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    for (let y = 0; y < height; y++) {
      buf.set(src.subarray(y * lineStride, y * lineStride + expected), y * expected);
    }
  }
  // RGBX (no-alpha source) leaves the 4th byte undefined → force opaque so
  // putImageData renders rather than blending to transparent.
  for (let i = 3; i < buf.length; i += 4) buf[i] = 255;
  _watchCtx.putImageData(new ImageData(buf, width, height), 0, 0);
  _watchFrames += 1;
  if (_watchOverlay && !_watchOverlay.hidden) _watchOverlay.hidden = true;
  // Lightweight status update — every ~30 frames so we don't thrash the DOM.
  if ((_watchFrames % 30) === 0) {
    const statusEl = _stage && _stage.querySelector("[data-watch-status]");
    if (statusEl) statusEl.textContent = `${_watchSelected || ""} · ${_watchFrames}f`;
  }
}

function setQuality(q) {
  if (q !== "high" && q !== "fast") return;
  _quality = q;
  saveEaselPrefs({ ...loadEaselPrefs(), quality: q });
  _stage.querySelectorAll(".easel-q-btn").forEach((b) => b.setAttribute("aria-selected", String(b.getAttribute("data-quality") === q)));
  if (_live) applyOutputDims(); // re-size the live stream on the fly
}

async function loadSources() {
  const grid = _stage.querySelector("[data-easel-sources]");
  if (!grid) return;
  grid.innerHTML = `<p class="easel-loading">finding screens & windows…</p>`;
  _sources = await safe(() => window.api.easel.listSources(), []);
  if (!_sources.length) {
    grid.innerHTML = `<p class="easel-loading">no capture sources found (Screen Recording permission may be needed).</p>`;
    return;
  }
  // Screens first, then windows.
  _sources.sort((a, b) => (a.type === b.type ? 0 : a.type === "screen" ? -1 : 1));
  grid.innerHTML = _sources.map((s) => `
    <button class="easel-src${s.id === _selectedId ? " is-sel" : ""}" type="button" data-src-id="${esc(s.id)}" title="${esc(s.name)}">
      ${s.thumbnail ? `<img class="easel-src-thumb" src="${esc(s.thumbnail)}" alt="" />` : `<span class="easel-src-thumb easel-src-thumb-blank"></span>`}
      <span class="easel-src-meta"><span class="easel-src-kind">${esc(s.type)}</span><span class="easel-src-name">${esc(s.name)}</span></span>
    </button>`).join("");
  grid.querySelectorAll("[data-src-id]").forEach((btn) => {
    btn.addEventListener("click", () => selectSource(btn.getAttribute("data-src-id")));
  });
  // Restore the last-used source, else default to the primary screen so
  // going live is one click.
  const prefs = loadEaselPrefs();
  const restore = (prefs.sourceId && _sources.some((s) => s.id === prefs.sourceId))
    ? prefs.sourceId
    : (_sources.find((s) => s.type === "screen") || _sources[0]).id;
  if (restore) selectSource(restore);
}

function selectSource(id) {
  if (_live) return; // can't switch mid-broadcast; stop first
  _selectedId = id;
  _stage.querySelectorAll(".easel-src").forEach((b) => b.classList.toggle("is-sel", b.getAttribute("data-src-id") === id));
  const go = _stage.querySelector("[data-easel-go]");
  if (go) go.disabled = !_ndiAvailable || !id;
  const ov = _stage.querySelector("[data-easel-overlay]");
  const src = _sources.find((s) => s.id === id);
  if (ov) { ov.textContent = src ? `ready · ${src.name} — hit go live to broadcast` : "select a source to preview"; ov.hidden = false; }
  // Show the chosen source's thumbnail as a static preview until live.
  if (src && src.thumbnail && _ctx) {
    const img = new Image();
    img.onload = () => { if (!_live) drawContain(img, img.naturalWidth, img.naturalHeight); };
    img.src = src.thumbnail;
  }
  setViewerMode("preview");
}

// Preview only (pre-live): letterbox a thumbnail into the current canvas.
function drawContain(source, sw, sh) {
  const W = _canvas.width, H = _canvas.height;
  _ctx.fillStyle = "#0c0b10";
  _ctx.fillRect(0, 0, W, H);
  if (!sw || !sh) return;
  const scale = Math.min(W / sw, H / sh);
  const dw = sw * scale, dh = sh * scale;
  _ctx.drawImage(source, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

async function goLive() {
  if (!_selectedId) return;
  hideError();
  const name = (_stage.querySelector("[data-easel-name]").value || "Easel").trim() || "Easel";
  const res = await safe(() => window.api.easel.start({ name }), { ok: false, error: "sender failed to start" });
  if (!res || res.ok === false) { showError(res && res.error ? res.error : "couldn't start the NDI sender."); return; }
  _publishedName = (res && res.name) || name; // the name receivers actually see (hostname-prefixed)

  try {
    _stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: _selectedId,
        maxWidth: 1920, maxHeight: 1080, maxFrameRate: FPS,
      } },
    });
  } catch (e) {
    await safe(() => window.api.easel.stop());
    showError("screen capture was blocked. Grant Screen Recording permission to the app, then fully quit & reopen easel. (" + e.message + ")", true);
    return;
  }

  _video.srcObject = _stream;
  await _video.play().catch(() => {});
  // If the user stops sharing via the OS, tear down cleanly.
  const track = _stream.getVideoTracks()[0];
  if (track) track.addEventListener("ended", () => stopLive());

  // Size the output to the source's native resolution (capped by quality) so
  // the projection is crisp, instead of a fixed 720p downscale.
  if (!_video.videoWidth) {
    await new Promise((r) => { _video.addEventListener("loadedmetadata", r, { once: true }); setTimeout(r, 1500); });
  }
  applyOutputDims();

  _live = true;
  _liveStartMs = Date.now();
  saveEaselPrefs({ ...loadEaselPrefs(), name, sourceId: _selectedId });
  const ov = _stage.querySelector("[data-easel-overlay]");
  if (ov) ov.hidden = true;
  syncGoButton();
  pump();
  _statsTimer = setInterval(refreshStats, 1000);
  refreshStats();
  syncViewerInfo();
}

async function stopLive() {
  _live = false;
  _liveStartMs = 0;
  if (_pumpTimer) { clearTimeout(_pumpTimer); _pumpTimer = null; }
  if (_statsTimer) { clearInterval(_statsTimer); _statsTimer = null; }
  if (_stream) { _stream.getTracks().forEach((t) => t.stop()); _stream = null; }
  if (_video) _video.srcObject = null;
  await safe(() => window.api.easel.stop());
  const ov = _stage.querySelector("[data-easel-overlay]");
  if (ov) { ov.hidden = false; ov.textContent = "stopped"; }
  syncGoButton();
  refreshStatus(null);
}

async function pump() {
  if (!_live || !_ctx || !_video) return;
  const t0 = performance.now();
  // Canvas matches the source aspect, so draw the full frame (no letterbox).
  if (_video.videoWidth) _ctx.drawImage(_video, 0, 0, _outW, _outH);
  let img = null;
  try { img = _ctx.getImageData(0, 0, _outW, _outH); } catch { /* shouldn't taint on local capture */ }
  if (img) await safe(() => window.api.easel.frame({ width: _outW, height: _outH, data: img.data }));
  if (!_live) return;
  const elapsed = performance.now() - t0;
  _pumpTimer = setTimeout(pump, Math.max(0, 1000 / FPS - elapsed));
}

async function refreshStats() {
  const s = await safe(() => window.api.easel.stats(), null);
  refreshStatus(s);
}

function refreshStatus(s) {
  const el = _stage && _stage.querySelector("[data-easel-status]");
  if (!el) return;
  if (!s || !s.live) {
    el.innerHTML = `<span class="easel-dot easel-dot-off"></span><span>idle</span>`;
    return;
  }
  const conns = s.connections || 0;
  el.innerHTML =
    `<span class="easel-dot easel-dot-on"></span>` +
    `<span class="easel-live-tag">LIVE</span>` +
    `<span class="easel-stat-name">${esc(_publishedName || s.name)}</span>` +
    `<span class="easel-stat-sep">·</span>` +
    `<span class="easel-watching">${conns} watching</span>` +
    `<span class="easel-stat-sep">·</span>` +
    `<span class="easel-stat-frames">${s.frames} frames</span>`;
}

function syncGoButton() {
  const go = _stage.querySelector("[data-easel-go]");
  if (!go) return;
  go.textContent = _live ? "stop" : "go live";
  go.classList.toggle("is-live", _live);
  go.disabled = !_ndiAvailable || (!_live && !_selectedId);
  // Lock source switching + name while live.
  _stage.querySelectorAll(".easel-src").forEach((b) => (b.disabled = _live));
  const nameI = _stage.querySelector("[data-easel-name]");
  if (nameI) nameI.disabled = _live;
}

function showError(msg, withSettings) {
  const el = _stage.querySelector("[data-easel-err]");
  if (!el) return;
  el.innerHTML = `<span>${esc(msg)}</span>` +
    (withSettings ? ` <button type="button" class="easel-err-btn" data-easel-open-settings>open Screen Recording settings</button>` : "");
  el.hidden = false;
  const b = el.querySelector("[data-easel-open-settings]");
  if (b) b.addEventListener("click", () => { try { window.api.openExternal(SCREEN_RECORDING_SETTINGS); } catch {} });
}
function hideError() {
  const el = _stage.querySelector("[data-easel-err]");
  if (el) el.hidden = true;
}
