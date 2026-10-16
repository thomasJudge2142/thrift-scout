"use strict";

const $ = (id) => document.getElementById(id);
const FEE_RATE = 0.15;
const MIN_CONFIDENCE = 0.5;
const MAX_IN_FLIGHT = 2;
const MAX_PHOTOS = 150;
const SEND_SIDE = 800;
const WATCH_MS = 200;
const MIN_GAP_MS = 1200;
const SHARP_MIN = 3;
const SENSITIVITY = {
  low: { steadyMs: 900, still: 3, newScene: 9 },
  normal: { steadyMs: 600, still: 5, newScene: 6 },
  high: { steadyMs: 400, still: 8, newScene: 4 },
};

const storedSettings = JSON.parse(localStorage.getItem("ts-settings") || "{}");
if ("apiKey" in storedSettings || "model" in storedSettings || storedSettings.provider === "openai") {
  delete storedSettings.apiKey;
  delete storedSettings.model;
  if (storedSettings.provider === "openai") storedSettings.provider = "gemini";
  localStorage.setItem("ts-settings", JSON.stringify(storedSettings));
}
const settings = Object.assign(
  { provider: "demo", minProfit: 15, sensitivity: "normal", vibrate: true, categories: [] },
  storedSettings
);
if (!["demo", "gemini"].includes(settings.provider)) settings.provider = "demo";
let items = JSON.parse(localStorage.getItem("ts-items") || "[]");

let stream = null;
let cameraStartPromise = null;
let scanning = false;
let watchTimer = null;
let prevSig = null;
let steadyFor = 0;
let sharpHistory = [];
let lastShotAt = 0;
let aiming = false;
const scoutDebug = (window.scoutDebug = { motion: 0, sharp: 0, steadyFor: 0, isNew: false });
let wakeLock = null;
let pausedUntil = 0;
let audioCtx = null;
let activeTab = "deals";
let lastSignature = null;
const queue = [];
let inFlight = 0;
const stats = { photos: 0, skipped: 0, analyzed: 0 };

const CATEGORIES = ["clothing", "shoes", "accessories", "electronics", "kitchenware", "decor", "books", "media", "toys", "tools", "sports", "collectibles", "furniture"];
const LABEL_SIDE = 1280;

// ---------- Photo storage (IndexedDB) ----------
const dbPromise = new Promise((resolve, reject) => {
  const req = indexedDB.open("thrift-scout", 2);
  req.onupgradeneeded = () => {
    for (const name of ["photos", "pending"]) {
      if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
    }
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
async function idb(mode, fn, store = "photos") {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const r = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(r && r.result);
    tx.onerror = () => reject(tx.error);
  });
}
const putPhoto = (id, blob) => idb("readwrite", (s) => s.put(blob, id));
const getPhoto = (id) => idb("readonly", (s) => s.get(id));
const deletePhoto = (id) => idb("readwrite", (s) => s.delete(id));
async function deleteQueuedPhoto(id) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["photos", "pending"], "readwrite");
    tx.objectStore("photos").delete(id);
    tx.objectStore("pending").delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
// Photos waiting for analysis are saved until they're analyzed, so they survive app closes and dropped connections.
const savePending = (job) =>
  idb("readwrite", (s) => s.put({ id: job.id, dataUrl: job.dataUrl, takenAt: job.takenAt, manual: job.manual, label: job.label }, job.id), "pending");
const dropPending = (id) => idb("readwrite", (s) => s.delete(id), "pending").catch(() => {});
async function resumePending() {
  const saved = (await idb("readonly", (s) => s.getAll(), "pending").catch(() => [])) || [];
  saved.sort((a, b) => a.takenAt - b.takenAt).forEach((j) => {
    const job = { ...j, tries: 0, ready: true };
    queue.push(job);
    queue.sort((a, b) => a.takenAt - b.takenAt);
    if (!items.some((item) => item.key === pendingItemKey(job.id))) items.unshift(makePendingItem(job));
  });
  if (saved.length) {
    persist();
    render();
    updateStatus();
    pump();
  }
}

const pendingItemKey = (id) => `pending-${id}`;
function makePendingItem(job) {
  return {
    key: pendingItemKey(job.id),
    name: "Analyzing captured item…",
    category: "pending",
    condition: "unknown",
    why: "Waiting for Google visual search and Gemini price research.",
    confidence: 0,
    cost: 0,
    low: 0,
    high: 0,
    profit: null,
    priceKnown: false,
    priceIsEstimate: true,
    seenAt: job.takenAt,
    photoId: job.dataUrl ? job.id : null,
    fromLabel: !!job.label,
    pipelineState: "queued",
  };
}

function setPipelineState(job, state, message = "") {
  const item = items.find((entry) => entry.key === pendingItemKey(job.id));
  if (!item) return;
  item.pipelineState = state;
  if (state === "failed") {
    item.name = "Could not analyze captured photo";
    item.why = message || "Analysis failed. You can retry from this item's details.";
    item.lookupError = message || "Analysis failed. You can retry from this item's details.";
  } else {
    item.name = state === "retrying" ? "Retrying item research…" : "Identifying and pricing item…";
    item.why = message || "Google visual search and Gemini price research are running.";
    item.lookupError = "";
  }
  persist();
  render();
}
async function prunePhotos() {
  const keep = new Set(items.map((i) => i.photoId).filter(Boolean));
  const keys = await idb("readonly", (s) => s.getAllKeys());
  const drop = (keys || []).filter((k) => !keep.has(k));
  if (drop.length) await idb("readwrite", (s) => drop.forEach((k) => s.delete(k)));
}

// ---------- Settings ----------
function saveSettings() {
  localStorage.setItem("ts-settings", JSON.stringify(settings));
  updateBadge();
}
function updateBadge() {
  const live = settings.provider !== "demo";
  $("modeBadge").textContent = live ? "Live AI" : "Demo";
  $("modeBadge").classList.toggle("live", !!live);
}
$("settingsBtn").onclick = () => {
  $("provider").value = settings.provider;
  $("minProfit").value = settings.minProfit;
  $("sensitivity").value = settings.sensitivity in SENSITIVITY ? settings.sensitivity : "normal";
  $("vibrate").checked = settings.vibrate;
  $("catList").replaceChildren(
    ...CATEGORIES.map((c) => {
      const l = document.createElement("label");
      l.className = "cat";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = c;
      cb.checked = (settings.categories || []).includes(c);
      l.append(cb, " " + c);
      return l;
    })
  );
  $("settings").showModal();
};
$("saveSettings").onclick = () => {
  settings.provider = $("provider").value;
  setTimeout(pump);
  settings.minProfit = Math.max(0, Number($("minProfit").value) || 0);
  settings.sensitivity = $("sensitivity").value;
  settings.vibrate = $("vibrate").checked;
  settings.categories = [...$("catList").querySelectorAll("input:checked")].map((cb) => cb.value);
  saveSettings();
  recomputeDeals();
  render();
};

// ---------- Camera ----------
async function startCamera() {
  if (stream) return;
  if (cameraStartPromise) return cameraStartPromise;
  cameraStartPromise = (async () => {
    const nextStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1440 } },
      audio: false,
    });
    $("video").srcObject = nextStream;
    try {
      await $("video").play();
      stream = nextStream;
      $("cameraPlaceholder").hidden = true;
    } catch (error) {
      nextStream.getTracks().forEach((track) => track.stop());
      $("video").srcObject = null;
      throw error;
    }
  })();
  try {
    await cameraStartPromise;
  } finally {
    cameraStartPromise = null;
  }
}
function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  $("video").srcObject = null;
  $("cameraPlaceholder").hidden = false;
}

async function start() {
  try {
    await startCamera();
  } catch (e) {
    if (settings.provider !== "demo") {
      setStatus("Camera blocked: " + e.message);
      return;
    }
    $("cameraPlaceholder").textContent = "No camera available. Demo mode is running with fake results.";
  }
  scanning = true;
  lastSignature = null;
  prevSig = null;
  steadyFor = 0;
  sharpHistory = [];
  $("recordBtn").textContent = "Stop Scanning";
  $("recordBtn").classList.add("on");
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
  unlockAudio();
  watchLoop();
  updateStatus();
}
function stop() {
  scanning = false;
  $("labelBtn").textContent = "Label";
  clearTimeout(watchTimer);
  aiming = false;
  stopCamera();
  $("recordBtn").textContent = "Start Scanning";
  $("recordBtn").classList.remove("on");
  wakeLock?.release?.();
  wakeLock = null;
  updateStatus();
}
$("recordBtn").onclick = () => (scanning ? stop() : start());

// ---------- Capture → queue → parallel analysis ----------
// Watches the camera on-device and only takes a photo when the view is steady, sharp, and new.
function watchLoop() {
  if (!scanning) return;
  if (document.visibilityState !== "visible") return;
  watchTimer = setTimeout(watchLoop, WATCH_MS);
  if (!stream) {
    if (settings.provider === "demo" && Date.now() - lastShotAt > 3000) {
      lastShotAt = Date.now();
      enqueue(null);
    }
    return;
  }
  const look = lookAtFrame();
  if (!look) return;
  const cfg = SENSITIVITY[settings.sensitivity] || SENSITIVITY.normal;
  const motion = prevSig ? meanDiff(look.sig, prevSig) : 255;
  prevSig = look.sig;
  steadyFor = motion < cfg.still ? steadyFor + WATCH_MS : 0;
  sharpHistory.push(look.sharp);
  if (sharpHistory.length > 6) sharpHistory.shift();
  const sharpEnough = look.sharp >= SHARP_MIN && look.sharp >= 0.75 * Math.max(...sharpHistory);
  const isNew = !lastSignature || meanDiff(look.sig, lastSignature) >= cfg.newScene;
  aiming = steadyFor > 0 && isNew;
  Object.assign(scoutDebug, { motion, sharp: look.sharp, steadyFor, isNew });
  if (steadyFor >= cfg.steadyMs && sharpEnough && isNew && Date.now() - lastShotAt >= MIN_GAP_MS) {
    const frame = captureFrame();
    if (!frame) return;
    lastSignature = look.sig;
    lastShotAt = Date.now();
    steadyFor = 0;
    aiming = false;
    enqueue(frame.dataUrl);
    snapFlash();
  }
}

function enqueue(dataUrl) {
  stats.photos++;
  const job = {
    id: `p${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    dataUrl,
    takenAt: Date.now(),
    tries: 0,
    ready: !dataUrl,
  };
  items.unshift(makePendingItem(job));
  persist();
  render();
  queue.push(job);
  if (dataUrl) {
    savePending(job)
      .then(async () => {
        if (job.cancelled) {
          await dropPending(job.id);
          return;
        }
        await putPhoto(job.id, await (await fetch(dataUrl)).blob());
        if (job.cancelled) {
          await dropPending(job.id);
          await deletePhoto(job.id);
          return;
        }
        job.ready = true;
        pump();
      })
      .catch((error) => {
        if (job.cancelled) return;
        console.error("Could not save the captured photo for research:", error);
        queue.splice(queue.indexOf(job), 1);
        setPipelineState(job, "failed", `Photo could not be saved locally: ${error.message}`);
        dropPending(job.id);
        pump();
      });
  } else {
    pump();
  }
  updateStatus();
}

async function cancelQueuedJob(job, button) {
  const index = queue.indexOf(job);
  if (index === -1) return;
  button.disabled = true;
  button.textContent = "Cancelling…";
  job.cancelled = true;
  queue.splice(index, 1);
  try {
    await deleteQueuedPhoto(job.id);
  } catch (error) {
    console.error("Could not cancel the queued photo:", error);
    job.cancelled = false;
    queue.push(job);
    queue.sort((a, b) => a.takenAt - b.takenAt);
    button.disabled = false;
    button.textContent = "Cancel analysis";
    flash(`Could not cancel queued photo: ${error.message}`);
    pump();
    return;
  }
  items = items.filter((item) => item.key !== pendingItemKey(job.id));
  persist();
  render();
  pump();
  updateStatus();
}

function snapFlash() {
  const w = $("cameraWrap");
  w.classList.add("snap");
  setTimeout(() => w.classList.remove("snap"), 250);
}

const lookCanvas = document.createElement("canvas");
function lookAtFrame() {
  const v = $("video");
  if (!v.videoWidth) return null;
  const W = 160, H = Math.max(1, Math.round((160 * v.videoHeight) / v.videoWidth));
  lookCanvas.width = W;
  lookCanvas.height = H;
  const ctx = lookCanvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(v, 0, 0, W, H);
  const px = ctx.getImageData(0, 0, W, H).data;
  const g = new Float32Array(W * H);
  for (let i = 0; i < g.length; i++) g[i] = (px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2]) / 3;
  let lap = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      lap += Math.abs(4 * g[i] - g[i - 1] - g[i + 1] - g[i - W] - g[i + W]);
    }
  }
  return { sig: sceneSignature(lookCanvas), sharp: lap / ((W - 2) * (H - 2)) };
}
const meanDiff = (a, b) => {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d / a.length;
};

function captureFrame(side = SEND_SIDE, quality = 0.75) {
  const v = $("video");
  if (!stream || !v.videoWidth) return null;
  const scale = Math.min(1, side / Math.max(v.videoWidth, v.videoHeight));
  const c = $("canvas");
  c.width = Math.round(v.videoWidth * scale);
  c.height = Math.round(v.videoHeight * scale);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(v, 0, 0, c.width, c.height);
  return { dataUrl: c.toDataURL("image/jpeg", quality), signature: sceneSignature(c) };
}

function sceneSignature(canvas) {
  const s = document.createElement("canvas");
  s.width = s.height = 16;
  const ctx = s.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, 16, 16);
  const px = ctx.getImageData(0, 0, 16, 16).data;
  const sig = new Uint8Array(256);
  for (let i = 0; i < 256; i++) sig[i] = (px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2]) / 3;
  return sig;
}
let pumpTimer = null;
function pump() {
  while (inFlight < MAX_IN_FLIGHT && queue.length && queue[0].ready !== false && Date.now() >= pausedUntil) {
    const job = queue.shift();
    inFlight++;
    analyzeJob(job).finally(() => {
      inFlight--;
      updateStatus();
      pump();
    });
  }
  clearTimeout(pumpTimer);
  if (queue.length && Date.now() < pausedUntil) pumpTimer = setTimeout(pump, pausedUntil - Date.now() + 50);
}

const isNetworkError = (e) =>
  !navigator.onLine || (e instanceof TypeError && /fetch|network|load failed/i.test(e.message));

async function analyzeJob(job) {
  try {
    setPipelineState(job, "analyzing");
    const found = await analyze(job.dataUrl);
    stats.analyzed++;
    await handleResults(found, job);
    dropPending(job.id);
  } catch (e) {
    console.error(e);
    job.tries = (job.tries || 0) + 1;
    const offline = isNetworkError(e);
    const limited = e.status === 429 || e.daily;
    if (job.dataUrl && e.retryable !== false && (offline || limited || e.status >= 500 || job.tries < 5)) {
      queue.push(job);
      const wait = limited ? e.retryAfterMs || 20000 : Math.min(60000, 2000 * 2 ** Math.min(job.tries, 5));
      pausedUntil = Math.max(pausedUntil, Date.now() + wait);
      setPipelineState(job, "retrying", `Research will retry automatically: ${e.message}`);
    } else {
      dropPending(job.id);
      setPipelineState(job, "failed", e.message);
    }
    lastError = offline ? "No connection" : e.daily ? e.message : e.status === 429 ? "AI rate limit hit" : e.message;
    lastErrorAt = Date.now();
  }
}

// ---------- Backend visual search and pricing ----------
function normCategory(cat) {
  const k = String(cat || "").toLowerCase();
  return CATEGORIES.find((x) => k.includes(x) || x.includes(k)) || k;
}
function categoryAllowed(it) {
  const c = settings.categories || [];
  return !!it.pipelineState || !c.length || it.fromLabel || !!it.status || c.includes(normCategory(it.category));
}

async function analyze(dataUrl, mode = "scan", itemHint = "") {
  if (settings.provider === "demo") return demoAnalyze(mode === "label");
  if (!dataUrl) throw new Error("camera not ready");
  const [metadata, image] = dataUrl.split(",");
  if (!image) throw new Error("The captured photo could not be read.");
  const mimeType = metadata.match(/^data:(image\/(?:jpeg|png|webp));base64$/)?.[1] || "image/jpeg";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 70_000);
  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image,
        mimeType,
        mode,
        itemHint,
        categories: settings.categories || [],
      }),
      signal: controller.signal,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(result.error || `Analysis failed (HTTP ${response.status}).`);
      error.status = response.status;
      error.retryable = result.retryable !== false;
      const retryAfter = Number(response.headers.get("retry-after"));
      if (retryAfter > 0) error.retryAfterMs = retryAfter * 1000;
      throw error;
    }
    if (!Array.isArray(result.items)) throw new Error("The analysis service returned an invalid result.");
    return result.items.filter((item) => item && typeof item.name === "string" && item.name);
  } finally {
    clearTimeout(timeout);
  }
}

const DEMO_ITEMS = [
  { name: "Pyrex Butterprint mixing bowl", category: "kitchenware", condition: "good", tag_price: 4.99, est_store_price: 5, resale_low: 30, resale_high: 55, confidence: 0.85, why: "Vintage Pyrex patterns are highly collectible." },
  { name: "Patagonia Better Sweater fleece", category: "clothing", condition: "good", tag_price: 7.99, est_store_price: 8, resale_low: 35, resale_high: 60, confidence: 0.8, why: "Patagonia fleece resells fast." },
  { name: "Generic ceramic mug", category: "kitchenware", condition: "good", tag_price: 1.49, est_store_price: 1.5, resale_low: 2, resale_high: 5, confidence: 0.6, why: "Common, low demand." },
  { name: "Nintendo GameCube controller", category: "electronics", condition: "worn", tag_price: null, est_store_price: 6, resale_low: 20, resale_high: 35, confidence: 0.75, why: "Retro gaming accessories are in demand." },
  { name: "Le Creuset enameled Dutch oven", category: "kitchenware", condition: "good", tag_price: 24.99, est_store_price: 25, resale_low: 120, resale_high: 200, confidence: 0.7, why: "Premium cookware, holds value." },
  { name: "Levi's 501 jeans (Made in USA)", category: "clothing", condition: "good", tag_price: 6.99, est_store_price: 7, resale_low: 40, resale_high: 90, confidence: 0.65, why: "Vintage USA-made 501s are sought after." },
];
async function demoAnalyze(label = false) {
  await new Promise((r) => setTimeout(r, 600));
  if (label) {
    const clothes = DEMO_ITEMS.filter((i) => i.category === "clothing");
    return [{ ...clothes[Math.floor(Math.random() * clothes.length)], box_2d: [300, 250, 700, 750], label_text: "(demo label)" }];
  }
  const n = Math.floor(Math.random() * 3);
  return Array.from({ length: n }, () => {
    const y = Math.floor(Math.random() * 600), x = Math.floor(Math.random() * 600);
    return { ...DEMO_ITEMS[Math.floor(Math.random() * DEMO_ITEMS.length)], box_2d: [y, x, y + 300, x + 300] };
  });
}

// ---------- Deal logic ----------
const num = (v) => (typeof v === "number" && isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && isFinite(+v) ? +v : null);
const keyOf = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function parseBox(b) {
  if (!Array.isArray(b) || b.length !== 4) return null;
  const [y0, x0, y1, x1] = b.map((v) => Math.min(1000, Math.max(0, num(v) ?? -1)));
  if ([y0, x0, y1, x1].some((v) => v < 0) || y1 <= y0 || x1 <= x0) return null;
  return [y0, x0, y1, x1];
}

function evaluate(raw) {
  const tag = num(raw.tag_price);
  const storeEst = num(raw.est_store_price);
  const low = num(raw.resale_low);
  const high = num(raw.resale_high);
  const priceKnown = low != null && high != null && high >= low;
  const cost = tag ?? storeEst ?? 0;
  const resale = priceKnown ? (low + high) / 2 : null;
  const profit = resale == null ? null : Math.round((resale * (1 - FEE_RATE) - cost) * 100) / 100;
  const sources = Array.isArray(raw.sources)
    ? raw.sources.filter((source) => source && typeof (source.url || source.uri) === "string").slice(0, 8)
    : [];
  const priceEvidence = String(raw.price_evidence || "").slice(0, 300);
  return {
    name: String(raw.name).slice(0, 120),
    brand: String(raw.brand || "").slice(0, 80),
    model: String(raw.model || "").slice(0, 120),
    category: String(raw.category || "").slice(0, 40),
    condition: String(raw.condition || "").slice(0, 40),
    why: String(raw.why || "").slice(0, 200),
    priceEvidence,
    lookup: {
      low: priceKnown ? low : null,
      high: priceKnown ? high : null,
      evidence: priceEvidence,
      sources,
      at: Date.now(),
    },
    priceKnown,
    estimatedResale: priceKnown
      ? Math.max(low, Math.min(high, num(raw.resale_estimate) ?? (low + high) / 2))
      : null,
    labelText: raw.label_text ? String(raw.label_text).slice(0, 200) : "",
    tagPrice: tag,
    cost,
    priceIsEstimate: tag == null,
    low: low ?? 0,
    high: high ?? low ?? 0,
    profit,
    confidence: num(raw.confidence) ?? 0.5,
    box: parseBox(raw.box_2d),
    visualSearch: String(raw.visual_search || ""),
    visualSearchWarning: String(raw.visual_search_warning || "").slice(0, 200),
  };
}
function isDeal(it) {
  return it.priceKnown && it.profit >= settings.minProfit && it.confidence >= MIN_CONFIDENCE && categoryAllowed(it);
}
function recomputeDeals() {
  items.forEach((it) => {
    if (it.priceKnown == null) it.priceKnown = num(it.low) != null && num(it.high) != null;
    if (it.profit == null && it.priceKnown) {
      it.profit = Math.round(((it.low + it.high) / 2 * (1 - FEE_RATE) - it.cost) * 100) / 100;
    }
    it.deal = isDeal(it);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
function cropThumb(img, box) {
  const c = document.createElement("canvas");
  c.width = c.height = 144;
  const ctx = c.getContext("2d");
  let sx = 0, sy = 0, sw = img.width, sh = img.height;
  if (box) {
    const [y0, x0, y1, x1] = box;
    const padX = ((x1 - x0) / 1000) * img.width * 0.1, padY = ((y1 - y0) / 1000) * img.height * 0.1;
    sx = Math.max(0, (x0 / 1000) * img.width - padX);
    sy = Math.max(0, (y0 / 1000) * img.height - padY);
    sw = Math.min(img.width - sx, ((x1 - x0) / 1000) * img.width + padX * 2);
    sh = Math.min(img.height - sy, ((y1 - y0) / 1000) * img.height + padY * 2);
  }
  const side = Math.max(sw, sh);
  const cx = sx + sw / 2, cy = sy + sh / 2;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, 144, 144);
  ctx.drawImage(img, cx - side / 2, cy - side / 2, side, side, 0, 0, 144, 144);
  return c.toDataURL("image/jpeg", 0.7);
}

async function handleResults(found, job) {
  items = items.filter((item) => item.key !== pendingItemKey(job.id));
  if (!found.length) {
    persist();
    render();
    return [];
  }
  const img = job.dataUrl ? await loadImage(job.dataUrl).catch(() => null) : null;
  const wasDeal = new Set(items.filter((it) => it.deal && !it.status).map((it) => it.key));
  let photoSaved = false;
  const savePhoto = async () => {
    if (photoSaved || !job.dataUrl) return;
    photoSaved = true;
    await putPhoto(job.id, await (await fetch(job.dataUrl)).blob()).catch(() => {});
  };
  const touched = [];
  for (const raw of found) {
    const ev = evaluate(raw);
    const key = keyOf(ev.name) + (ev.confidence < MIN_CONFIDENCE ? ` ${job.id}` : "");
    if (!key) continue;
    const sighting = { photoId: job.dataUrl ? job.id : null, seenAt: job.takenAt, box: ev.box, thumb: img ? cropThumb(img, ev.box) : null };
    let it = items.find((i) => i.key === key);
    if (it) {
      const better = (ev.tagPrice != null && it.tagPrice == null) || ev.confidence > it.confidence;
      if (better) Object.assign(it, ev);
      Object.assign(it, sighting);
    } else {
      it = { ...ev, key, ...sighting };
      items.unshift(it);
    }
    if (job.label) it.fromLabel = true;
    touched.push(it);
    if (it.photoId) await savePhoto();
  }
  touched.forEach((it) => (it.deal = isDeal(it)));
  let kept = 0;
  items = items.filter((i) => i.status || i.pipelineState || kept++ < MAX_PHOTOS);
  const newDeal = touched.find((it) => it.deal && !it.status && !wasDeal.has(it.key));
  if (newDeal && !job.label) alertDeal(newDeal);
  persist();
  render();
  prunePhotos().catch(() => {});
  return touched;
}

// ---------- Label snap ----------
let snapping = false;
async function snapLabel() {
  if (snapping) return;

  const btn = $("labelBtn");
  if (!stream) {
    try {
      await startCamera();
    } catch (e) {
      if (settings.provider !== "demo") return setStatus("Camera blocked: " + e.message);
    }
    unlockAudio();
    if (!scanning) {
      btn.textContent = "Snap Label";
      flash("Point at the clothing label so it fills the screen, then tap Snap Label");
      return;
    }
  }
  snapping = true;
  btn.disabled = true;
  btn.textContent = "Reading label…";
  const frame = captureFrame(LABEL_SIDE, 0.85);
  const job = { id: `p${Date.now()}`, dataUrl: frame?.dataUrl || null, takenAt: Date.now(), label: true };
  try {
    const found = (await analyze(job.dataUrl, "label")).slice(0, 1);
    const [it] = await handleResults(found, job);
    if (it) {
      if (it.deal && settings.vibrate) {
        navigator.vibrate?.([120, 60, 120]);
        beep();
      }
      openViewer(it);
    } else {
      flash("Couldn't read a brand. Get closer so the label fills the screen.");
    }
  } catch (e) {
    console.error(e);
    flash("Label read failed: " + (e.message || "error"), 8000);
  } finally {
    snapping = false;
    btn.disabled = false;
    btn.textContent = "Snap Label";
  }
}
$("labelBtn").onclick = snapLabel;

function persist() {
  try {
    localStorage.setItem("ts-items", JSON.stringify(items));
  } catch {
    localStorage.setItem("ts-items", JSON.stringify(items.map(({ thumb, ...r }) => r)));
  }
}

// ---------- Alerts ----------
function unlockAudio() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
  }
  audioCtx?.resume?.();
}
function beep() {
  if (!audioCtx) return;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.frequency.value = 880;
  g.gain.setValueAtTime(0.2, audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.35);
  o.connect(g).connect(audioCtx.destination);
  o.start();
  o.stop(audioCtx.currentTime + 0.35);
}
let toastTimer;
function alertDeal(it) {
  const t = $("toast");
  t.textContent = `Deal: ${it.name} · ~${money(it.profit)} profit (tap to see where)`;
  t.onclick = () => openViewer(it);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 5000);
  if (settings.vibrate) {
    navigator.vibrate?.([120, 60, 120]);
    beep();
  }
}

// ---------- Rendering ----------
const money = (n) => (n < 0 ? "-$" : "$") + Math.abs(n).toFixed(n % 1 === 0 ? 0 : 2);
function ago(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hr ago`;
  return new Date(t).toLocaleDateString();
}

let lastError = "";
let lastErrorAt = 0;
function setStatus(text, live) {
  $("status").textContent = text;
  $("status").classList.toggle("scanning", !!live);
}
let noteUntil = 0;
function flash(text, ms = 6000) {
  noteUntil = Date.now() + ms;
  setStatus(text, true);
}
function updateStatus() {
  if (Date.now() < noteUntil) return;
  const pending = inFlight + queue.length;
  const wait = Math.ceil((pausedUntil - Date.now()) / 1000);
  let waitText = "";
  if (wait > 0 && queue.length) {
    const label =
      lastError === "No connection" ? "no connection" :
      lastError === "Free daily AI limit used up" ? "free daily AI limit used up" :
      lastError === "AI rate limit hit" ? "AI limit" : "AI error";
    waitText = `${label}, retrying in ${wait > 120 ? Math.ceil(wait / 60) + "m" : wait + "s"}`;
  }
  if (!scanning && pending) {
    return setStatus(`Finishing ${pending} saved photo${pending > 1 ? "s" : ""}…${waitText ? " · " + waitText : ""}`, true);
  }
  if (!scanning) return setStatus(stream ? "Label mode · point at a tag, tap Snap Label" : "Idle", !!stream);
  const parts = [`${stats.photos} photos`];
  if (aiming) parts.push("hold steady to snap");
  if (pending) parts.push(`analyzing ${pending}`);
  if (waitText) parts.push(waitText);
  else if (lastError && Date.now() - lastErrorAt < 8000) parts.push(`error: ${lastError}`);
  setStatus("Scanning · " + parts.join(" · "), true);
}

function pricesHtml(it) {
  const priceLabel = it.priceIsEstimate ? `~${money(it.cost)} (no tag)` : money(it.cost);
  const resaleLabel = it.priceKnown
    ? `Resale: ~${money(it.estimatedResale ?? (it.low + it.high) / 2)} (${money(it.low)}–${money(it.high)})`
    : "Resale: no reliable estimate";
  return `<span>Price: ${priceLabel}</span><span>${resaleLabel}</span>`;
}
function itemEl(it) {
  const li = document.createElement("li");
  li.className = "item";
  li.onclick = (e) => {
    if (!(e.target instanceof Element) || !e.target.closest("a, button")) openViewer(it);
  };
  if (it.thumb) {
    const img = document.createElement("img");
    img.src = it.thumb;
    img.alt = "";
    li.appendChild(img);
  }
  const info = document.createElement("div");
  info.className = "info";
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = it.name;
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = it.pipelineState
    ? (it.pipelineState === "failed" ? "Analysis failed" : "Automatic research")
    : [it.brand, it.model, it.category, it.condition, `${Math.round(it.confidence * 100)}% sure`].filter(Boolean).join(" · ");
  const prices = document.createElement("div");
  prices.className = "prices";
  prices.innerHTML = pricesHtml(it);
  const research = document.createElement("div");
  research.className = "meta";
  if (it.lookupPending) research.textContent = "Searching Google for recent sold prices…";
  else if (it.lookupError) research.textContent = it.lookupError;
  const profit = document.createElement("span");
  profit.className = "profit" + (it.profit != null && it.profit < 0 ? " neg" : "");
  profit.textContent = it.profit == null ? "Profit: unavailable" : `Profit: ${money(it.profit)}`;
  prices.appendChild(profit);
  const seen = document.createElement("div");
  seen.className = "seen";
  seen.textContent = `Seen ${ago(it.seenAt)}${it.photoId ? " · tap to see where" : ""}`;
  const why = document.createElement("div");
  why.className = "meta";
  why.textContent = it.why;
  const link = document.createElement("a");
  link.href = ebayUrl(it);
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = "Check eBay sold prices →";
  info.append(name, meta, prices);
  if (it.pipelineState) {
    const pipeline = document.createElement("div");
    pipeline.className = `pipeline-status ${it.pipelineState}`;
    pipeline.setAttribute("role", "status");
    pipeline.setAttribute("aria-live", "polite");
    pipeline.textContent = {
      queued: "Queued for automatic identification and pricing",
      analyzing: "Searching for visual matches and researching resale prices…",
      retrying: it.why,
      failed: "Analysis failed. Open this item to retry.",
    }[it.pipelineState] || "Processing captured photo…";
    info.append(pipeline);
  }
  if (it.pipelineState === "queued" || it.pipelineState === "retrying") {
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "cancel-analysis";
    cancel.textContent = "Cancel analysis";
    cancel.setAttribute("aria-label", "Cancel analysis of this photo");
    cancel.onclick = (event) => {
      event.stopPropagation();
      const job = queue.find((queued) => pendingItemKey(queued.id) === it.key);
      if (job) cancelQueuedJob(job, cancel);
    };
    info.append(cancel);
  }
  if (research.textContent) info.append(research);
  if (it.status) {
    const st = document.createElement("div");
    st.className = "haul-status " + it.status;
    st.textContent = statusText(it);
    info.append(st);
  }
  info.append(seen, why, link);
  li.appendChild(info);
  return li;
}
const ebayUrl = (it) => `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(it.name)}&LH_Sold=1&LH_Complete=1`;

let viewerUrl = null;
let viewerItem = null;
async function openViewer(it) {
  viewerItem = it;
  const blob = it.photoId ? await getPhoto(it.photoId).catch(() => null) : null;
  if (viewerUrl) URL.revokeObjectURL(viewerUrl);
  viewerUrl = blob ? URL.createObjectURL(blob) : null;
  $("viewerImg").src = viewerUrl || it.thumb || "";
  const box = $("viewerBox");
  if (blob && it.box) {
    const [y0, x0, y1, x1] = it.box;
    Object.assign(box.style, { top: `${y0 / 10}%`, left: `${x0 / 10}%`, height: `${(y1 - y0) / 10}%`, width: `${(x1 - x0) / 10}%` });
    box.hidden = false;
  } else {
    box.hidden = true;
  }
  $("viewerName").textContent = it.name;
  $("viewerMeta").textContent = `Seen ${ago(it.seenAt)} · ${it.why}` + (it.labelText ? ` · Label: "${it.labelText}"` : "");
  const profitText = it.profit == null ? "Profit: unavailable" : `Profit: ${money(it.profit)}`;
  $("viewerPrices").innerHTML = pricesHtml(it) + `<span class="profit${it.profit != null && it.profit < 0 ? " neg" : ""}">${profitText}</span>`;
  $("viewerLink").href = ebayUrl(it);
  $("viewerLink").hidden = !!it.pipelineState;
  renderLookup(it);
  renderViewerActions(it);
  if (!$("viewer").open) $("viewer").showModal();
}

// ---------- Automatic price research ----------
let lookupError = null;

const blobToDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

async function lookupItem(it) {
  if (settings.provider === "demo") {
    await new Promise((resolve) => setTimeout(resolve, 600));
    const mid = Math.max(10, Math.round((it.low + it.high) / 2));
    return { name: it.name, low: Math.round(mid * 0.8), high: Math.round(mid * 1.3), evidence: "Demo mode: simulated price, not a real web lookup.", sources: [], confidence: it.confidence };
  }
  const blob = it.photoId ? await getPhoto(it.photoId) : null;
  if (!blob) throw new Error("The original photo is no longer available on this device.");
  const [result] = await analyze(
    await blobToDataUrl(blob),
    it.fromLabel ? "label" : "scan",
    it.pipelineState ? "" : it.name
  );
  if (!result) throw new Error("The service could not identify the item from its photo.");
  const evaluated = evaluate(result);
  return {
    name: evaluated.name,
    brand: evaluated.brand,
    model: evaluated.model,
    low: evaluated.priceKnown ? evaluated.low : null,
    high: evaluated.priceKnown ? evaluated.high : null,
    estimatedResale: evaluated.estimatedResale,
    evidence: evaluated.priceEvidence || evaluated.why,
    sources: result.sources || [],
    confidence: evaluated.confidence,
    visualSearchWarning: evaluated.visualSearchWarning,
    analysis: evaluated,
  };
}

function applyLookup(it, result) {
  const wasPipelineFailure = it.pipelineState === "failed";
  if (result.analysis) {
    const preserved = {
      key: it.key,
      photoId: it.photoId,
      thumb: it.thumb,
      seenAt: it.seenAt,
      status: it.status,
      paid: it.paid,
      boughtAt: it.boughtAt,
      soldFor: it.soldFor,
      soldAt: it.soldAt,
      fromLabel: it.fromLabel,
    };
    Object.assign(it, result.analysis, preserved);
    it.key = keyOf(it.name);
  }
  const low = num(result.low);
  const high = num(result.high);
  it.lookup = { ...result, low, high, at: Date.now() };
  it.lookupError = "";
  if (result.name) it.name = result.name;
  if (result.brand) it.brand = result.brand;
  if (result.model) it.model = result.model;
  it.priceKnown = low != null && high != null && high >= low;
  it.low = low ?? 0;
  it.high = high ?? low ?? 0;
  it.estimatedResale = it.priceKnown
    ? Math.max(low, Math.min(high, num(result.estimatedResale) ?? (low + high) / 2))
    : null;
  it.priceEvidence = String(result.evidence || "").slice(0, 300);
  it.profit = it.priceKnown ? Math.round(((it.low + it.high) / 2 * (1 - FEE_RATE) - it.cost) * 100) / 100 : null;
  if (num(result.confidence) != null) it.confidence = num(result.confidence);
  if (result.visualSearchWarning) it.visualSearchWarning = result.visualSearchWarning;
  if (wasPipelineFailure && !result.analysis) it.key = keyOf(it.name);
  delete it.pipelineState;
  it.deal = isDeal(it);
}

function lookupFailureMessage(error) {
  return `Automatic price research failed: ${error.message}`;
}

async function runLookup(it, button) {
  button.disabled = true;
  button.textContent = "Searching the web?";
  lookupError = null;
  it.lookupError = "";
  it.lookupPending = true;
  renderLookup(it);
  try {
    applyLookup(it, await lookupItem(it));
  } catch (error) {
    console.error(error);
    it.lookupError = lookupFailureMessage(error);
    lookupError = { item: it, message: it.lookupError };
  } finally {
    it.lookupPending = false;
    persist();
    render();
    if (viewerItem === it && $("viewer").open) openViewer(it);
  }
}

function renderLookup(it) {
  const box = $("viewerLookup");
  const parts = [];
  if (it.pipelineState && it.pipelineState !== "failed") {
    const pending = document.createElement("div");
    pending.className = "head";
    pending.textContent = it.why;
    parts.push(pending);
  } else if (it.lookupPending) {
    const pending = document.createElement("div");
    pending.className = "head";
    pending.textContent = "Searching Google for current resale prices?";
    parts.push(pending);
  } else if ((lookupError && lookupError.item === it) || it.lookupError) {
    const error = document.createElement("div");
    error.className = "err";
    error.textContent = it.lookupError || lookupError.message;
    parts.push(error);
  }
  if (it.visualSearchWarning) {
    const warning = document.createElement("div");
    warning.textContent = it.visualSearchWarning;
    parts.push(warning);
  }
  if (it.lookup) {
    const result = it.lookup;
    const head = document.createElement("div");
    head.className = "head";
    head.textContent = result.low != null
      ? `Web estimate: ${money(result.low)}?${money(result.high ?? result.low)}`
      : "Web estimate: no reliable price range found";
    const evidence = document.createElement("div");
    evidence.textContent = result.evidence || "No pricing evidence was returned.";
    parts.push(head, evidence);
    for (const source of result.sources || []) {
      const url = source.url || source.uri;
      if (typeof url !== "string" || !/^https?:/i.test(url)) continue;
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = `${source.type === "visual" ? "Visual match: " : "Price research: "}${source.title || url}`;
      parts.push(link);
    }
  }
  box.replaceChildren(...parts);
  box.hidden = !parts.length;
}

// ---------- Haul tracker ----------
const realProfit = (it) => Math.round(((it.soldFor ?? 0) * (1 - FEE_RATE) - (it.paid ?? 0)) * 100) / 100;
function statusText(it) {
  if (it.status === "sold") return `Sold for ${money(it.soldFor)} · paid ${money(it.paid)} · real profit ${money(realProfit(it))}`;
  if (it.status === "bought") return `Bought for ${money(it.paid)} · not sold yet`;
  return "";
}
function askPrice(question, fallback) {
  const v = prompt(question, fallback != null ? String(fallback) : "");
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[^0-9.]/g, ""));
  return isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}
function setHaul(it, change) {
  Object.assign(it, change);
  it.deal = isDeal(it);
  persist();
  render();
  openViewer(it);
}
function renderViewerActions(it) {
  const box = $("viewerActions");
  const btn = (label, fn, cls = "") => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = label;
    b.onclick = fn;
    return b;
  };
  const buttons = [];
  const retry = it.pipelineState === "failed";
  const look = btn(
    retry ? "Retry identification and pricing" : it.lookup ? "Research again" : "Look it up",
    () => runLookup(it, look)
  );
  look.hidden = !!it.pipelineState && !retry;
  if (it.lookupPending) {
    look.disabled = true;
    look.textContent = "Searching web...";
  }
  buttons.push(look);
  if (!it.pipelineState && !it.status) {
    buttons.push(btn("I bought it", () => {
      const paid = askPrice("How much did you pay?", it.cost);
      if (paid != null) setHaul(it, { status: "bought", paid, boughtAt: Date.now() });
    }));
  } else if (!it.pipelineState && it.status === "bought") {
    buttons.push(btn("Mark sold", () => {
      const fallback = it.priceKnown ? Math.round((it.low + it.high) / 2) : null;
      const soldFor = askPrice("What did it sell for (before fees)?", fallback);
      if (soldFor != null) setHaul(it, { status: "sold", soldFor, soldAt: Date.now() });
    }));
    buttons.push(btn("Not bought", () => setHaul(it, { status: undefined, paid: undefined, boughtAt: undefined }), "secondary"));
  } else if (!it.pipelineState && it.status === "sold") {
    buttons.push(btn("Undo sale", () => setHaul(it, { status: "bought", soldFor: undefined, soldAt: undefined }), "secondary"));
  }
  box.replaceChildren(...buttons);
  $("viewerStatus").textContent = statusText(it);
  $("viewerStatus").hidden = !it.status;
}

function renderHaul(haul) {
  const sold = haul.filter((i) => i.status === "sold");
  const unsold = haul.filter((i) => i.status === "bought");
  const spent = haul.reduce((a, i) => a + (i.paid || 0), 0);
  const earned = sold.reduce((a, i) => a + realProfit(i), 0);
  const potential = unsold.reduce((a, i) => a + (i.profit || 0) + i.cost - (i.paid || 0), 0);
  $("haulSummary").innerHTML =
    `<div><b>${money(spent)}</b><span>spent</span></div>` +
    `<div><b class="${earned < 0 ? "neg" : "pos"}">${money(earned)}</b><span>real profit (${sold.length} sold)</span></div>` +
    `<div><b>${money(potential)}</b><span>est. profit left (${unsold.length} unsold)</span></div>`;
  const trips = new Map();
  [...haul].sort((a, b) => (b.boughtAt || 0) - (a.boughtAt || 0)).forEach((i) => {
    const day = new Date(i.boughtAt || Date.now()).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
    if (!trips.has(day)) trips.set(day, []);
    trips.get(day).push(i);
  });
  const els = [];
  for (const [day, list] of trips) {
    const head = document.createElement("li");
    head.className = "trip";
    const tSpent = list.reduce((a, i) => a + (i.paid || 0), 0);
    const tProfit = list.filter((i) => i.status === "sold").reduce((a, i) => a + realProfit(i), 0);
    head.textContent = `${day} · ${list.length} item${list.length === 1 ? "" : "s"} · spent ${money(tSpent)} · profit so far ${money(tProfit)}`;
    els.push(head, ...list.map(itemEl));
  }
  $("haulList").replaceChildren(...els);
}

function render() {
  const visible = items.filter(categoryAllowed);
  const deals = visible.filter((i) => i.deal && !i.status).sort((a, b) => b.profit - a.profit);
  const haul = items.filter((i) => i.status);
  $("dealCount").textContent = deals.length;
  $("seenCount").textContent = visible.length;
  $("haulCount").textContent = haul.length;
  $("dealsList").replaceChildren(...deals.map(itemEl));
  $("seenList").replaceChildren(...visible.map(itemEl));
  renderHaul(haul);
  $("dealsList").hidden = activeTab !== "deals";
  $("seenList").hidden = activeTab !== "seen";
  $("haulView").hidden = activeTab !== "haul";
  const shown = { deals: deals.length, seen: visible.length, haul: haul.length }[activeTab];
  $("emptyMsg").hidden = shown > 0;
  $("emptyMsg").textContent = {
    deals: "No deals yet. Start scanning!",
    seen: "Nothing seen yet.",
    haul: "Nothing in your haul yet. Tap a find, then \"I bought it\".",
  }[activeTab];
  $("haulSummary").hidden = haul.length === 0;
  $("clearBtn").hidden = activeTab === "haul" || !items.some((i) => !i.status);
}
document.querySelectorAll(".tab").forEach((b) => {
  b.onclick = () => {
    activeTab = b.dataset.tab;
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === b));
    render();
  };
});
$("clearBtn").onclick = () => {
  if (!confirm("Clear scanned items? Your haul is kept.")) return;
  items = items.filter((i) => i.status);
  persist();
  render();
  prunePhotos().catch(() => {});
};

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible") {
    if (scanning) {
      clearTimeout(watchTimer);
      stopCamera();
      prevSig = null;
      steadyFor = 0;
      aiming = false;
      wakeLock?.release?.();
      wakeLock = null;
      setStatus("Paused while app is in the background", false);
    }
    return;
  }
  pump();
  if (scanning) {
    try {
      await startCamera();
      prevSig = null;
      steadyFor = 0;
      sharpHistory = [];
      lastSignature = null;
      wakeLock = await navigator.wakeLock?.request("screen");
      watchLoop();
    } catch (error) {
      setStatus("Camera blocked: " + error.message);
    }
  }
});
setInterval(() => {
  updateStatus();
  if (!scanning) render();
}, 30000);
setInterval(updateStatus, 1000);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
window.addEventListener("online", () => {
  pausedUntil = 0;
  pump();
});
navigator.storage?.persist?.().catch(() => {});
recomputeDeals();
updateBadge();
render();
resumePending();
