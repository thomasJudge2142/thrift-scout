"use strict";

const $ = (id) => document.getElementById(id);
const DEFAULT_MODELS = { gemini: "gemini-flash-lite-latest", openai: "gpt-4o-mini", demo: "" };
const GEMINI_FALLBACKS = ["gemini-flash-lite-latest", "gemini-3.8-flash", "gemini-flash-latest", "gemini-3.5-flash"];
const FEE_RATE = 0.15;
const MIN_CONFIDENCE = 0.5;
const MAX_IN_FLIGHT = 2;
const MAX_QUEUE = 4;
const MAX_PHOTOS = 150;
const SEND_SIDE = 800;
const SAME_SCENE_DIFF = 6;

const settings = Object.assign(
  { provider: "demo", apiKey: "", model: "", minProfit: 15, interval: 1.5, vibrate: true },
  JSON.parse(localStorage.getItem("ts-settings") || "{}")
);
let items = JSON.parse(localStorage.getItem("ts-items") || "[]");

let stream = null;
let scanning = false;
let captureTimer = null;
let wakeLock = null;
let pausedUntil = 0;
let audioCtx = null;
let activeTab = "deals";
let geminiFallbackIdx = 0;
let geminiNoThinking = new Set();
let lastSignature = null;
const queue = [];
let inFlight = 0;
const stats = { photos: 0, skipped: 0, analyzed: 0 };

const PROMPT = `You are an expert thrift store reseller helping someone find items to flip.
This photo was taken while walking through a thrift store. Identify distinct items that are clearly visible and specific enough to price (brand, model, maker, or a notable style). Skip generic, unbranded, or unrecognizable items.
For each item return:
- name: specific name, e.g. "Pyrex Butterprint mixing bowl" or "Patagonia Better Sweater fleece"
- category: e.g. clothing, electronics, kitchenware, books, toys, decor, tools
- condition: your best guess from the photo (e.g. "good", "worn", "like new", "unknown")
- tag_price: price in USD if you can read a price tag/sticker for this item, else null
- est_store_price: what a typical US thrift store would charge for it if there is no readable tag
- resale_low and resale_high: realistic recent eBay SOLD price range in USD
- confidence: 0 to 1, how sure you are of the identification and pricing
- box_2d: [ymin, xmin, ymax, xmax] bounding box of the item in the photo, normalized to 0-1000
- why: one short sentence explaining the value
Respond ONLY with JSON: {"items":[...]}. If nothing is worth noting, respond {"items":[]}.`;

const LABEL_PROMPT = `You are an expert vintage and secondhand clothing reseller.
This is a close-up photo of a clothing label (neck tag, waist tag, or care/content tag) taken in a thrift store, possibly with part of the garment visible.
Read every word on the label: brand, sub-line, size, fiber content, country of manufacture, RN/CA number, union tag, style or lot number.
Use those clues (and anything visible of the garment) to identify the most likely item, its era (e.g. "90s", "vintage 70s", "modern"), and realistic recent eBay SOLD prices for it.
Return exactly one item, or none if no brand can be read:
- name: brand + garment + key details, e.g. "Patagonia Synchilla fleece pullover, Men's L, Made in USA (90s)"
- category: "clothing" (or "shoes"/"accessories")
- condition: best guess or "unknown"
- tag_price: USD if a thrift price tag/sticker is readable, else null
- est_store_price: typical US thrift store price for this garment
- resale_low and resale_high: realistic recent eBay SOLD price range in USD
- confidence: 0 to 1
- box_2d: [ymin, xmin, ymax, xmax] of the label in the photo, normalized to 0-1000
- label_text: the exact text you read on the label
- why: one short sentence on what makes it valuable or not (brand demand, era, origin, material)
Respond ONLY with JSON: {"items":[...]}. If the label is unreadable or has no brand, respond {"items":[]}.`;
const LABEL_SIDE = 1280;

// ---------- Photo storage (IndexedDB) ----------
const dbPromise = new Promise((resolve, reject) => {
  const req = indexedDB.open("thrift-scout", 1);
  req.onupgradeneeded = () => req.result.createObjectStore("photos");
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
async function idb(mode, fn) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction("photos", mode);
    const r = fn(tx.objectStore("photos"));
    tx.oncomplete = () => resolve(r && r.result);
    tx.onerror = () => reject(tx.error);
  });
}
const putPhoto = (id, blob) => idb("readwrite", (s) => s.put(blob, id));
const getPhoto = (id) => idb("readonly", (s) => s.get(id));
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
  const live = settings.provider !== "demo" && settings.apiKey;
  $("modeBadge").textContent = live ? settings.provider : "Demo";
  $("modeBadge").classList.toggle("live", !!live);
}
$("settingsBtn").onclick = () => {
  $("provider").value = settings.provider;
  $("apiKey").value = settings.apiKey;
  $("model").value = settings.model;
  $("model").placeholder = DEFAULT_MODELS[settings.provider] || "auto";
  $("minProfit").value = settings.minProfit;
  $("interval").value = settings.interval;
  $("vibrate").checked = settings.vibrate;
  $("settings").showModal();
};
$("provider").onchange = () => ($("model").placeholder = DEFAULT_MODELS[$("provider").value] || "auto");
$("saveSettings").onclick = () => {
  settings.provider = $("provider").value;
  settings.apiKey = $("apiKey").value.trim();
  settings.model = $("model").value.trim();
  settings.minProfit = Math.max(0, Number($("minProfit").value) || 0);
  settings.interval = Math.min(30, Math.max(0.5, Number($("interval").value) || 1.5));
  settings.vibrate = $("vibrate").checked;
  saveSettings();
  recomputeDeals();
  render();
};

// ---------- Camera ----------
async function startCamera() {
  if (stream) return;
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1440 } },
    audio: false,
  });
  $("video").srcObject = stream;
  await $("video").play();
  $("cameraPlaceholder").hidden = true;
}
function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  $("video").srcObject = null;
  $("cameraPlaceholder").hidden = false;
}

async function start() {
  if (settings.provider !== "demo" && !settings.apiKey) {
    alert("Add your API key in Settings (gear icon), or switch to Demo mode.");
    return;
  }
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
  $("recordBtn").textContent = "Stop Scanning";
  $("recordBtn").classList.add("on");
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
  unlockAudio();
  captureLoop();
  updateStatus();
}
function stop() {
  scanning = false;
  $("labelBtn").textContent = "Label";
  clearTimeout(captureTimer);
  queue.length = 0;
  stopCamera();
  $("recordBtn").textContent = "Start Scanning";
  $("recordBtn").classList.remove("on");
  wakeLock?.release?.();
  wakeLock = null;
  updateStatus();
}
$("recordBtn").onclick = () => (scanning ? stop() : start());

// ---------- Capture → queue → parallel analysis ----------
function captureLoop() {
  if (!scanning) return;
  const frame = captureFrame();
  if (frame || settings.provider === "demo") {
    if (frame && isSameScene(frame.signature)) {
      stats.skipped++;
    } else {
      if (frame) lastSignature = frame.signature;
      stats.photos++;
      queue.push({ id: `p${Date.now()}`, dataUrl: frame?.dataUrl || null, takenAt: Date.now() });
      while (queue.length > MAX_QUEUE) queue.shift();
      pump();
    }
  }
  updateStatus();
  captureTimer = setTimeout(captureLoop, settings.interval * 1000);
}

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
function isSameScene(sig) {
  if (!lastSignature) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff += Math.abs(sig[i] - lastSignature[i]);
  return diff / sig.length < SAME_SCENE_DIFF;
}

function pump() {
  while (inFlight < MAX_IN_FLIGHT && queue.length && Date.now() >= pausedUntil) {
    const job = queue.pop();
    inFlight++;
    analyzeJob(job).finally(() => {
      inFlight--;
      updateStatus();
      pump();
    });
  }
  if (queue.length && Date.now() < pausedUntil) setTimeout(pump, pausedUntil - Date.now() + 50);
}

async function analyzeJob(job) {
  try {
    const found = await analyze(job.dataUrl);
    stats.analyzed++;
    await handleResults(found, job);
  } catch (e) {
    console.error(e);
    if (e.status === 429) {
      pausedUntil = Date.now() + (e.retryAfterMs || 20000);
      queue.push(job);
      while (queue.length > MAX_QUEUE) queue.shift();
    }
    lastError = e.daily ? e.message : e.status === 429 ? "AI rate limit hit" : e.message;
    lastErrorAt = Date.now();
  }
}

// ---------- AI providers ----------
async function analyze(dataUrl, prompt = PROMPT) {
  if (settings.provider === "demo") return demoAnalyze(prompt === LABEL_PROMPT);
  if (!dataUrl) throw new Error("camera not ready");
  const text = settings.provider === "gemini" ? await callGemini(dataUrl.split(",")[1], prompt) : await callOpenAI(dataUrl, prompt);
  return parseItems(text);
}

const geminiOutOfQuota = new Map();

async function callGemini(b64, prompt) {
  const chain = settings.model ? [settings.model] : GEMINI_FALLBACKS;
  let lastErr;
  for (let n = 0; n < chain.length; n++) {
    const idx = (geminiFallbackIdx + n) % chain.length;
    if ((geminiOutOfQuota.get(chain[idx]) || 0) > Date.now()) continue;
    try {
      const text = await callGeminiModel(chain[idx], b64, prompt);
      geminiFallbackIdx = idx;
      return text;
    } catch (e) {
      lastErr = e;
      if (e.daily) {
        geminiOutOfQuota.set(chain[idx], Date.now() + (e.retryAfterMs || 3600000));
        continue;
      }
      if (![404, 500, 503].includes(e.status)) throw e;
    }
  }
  if (!lastErr || lastErr.daily) {
    const until = Math.min(...chain.map((m) => geminiOutOfQuota.get(m) || Date.now() + 600000));
    const err = new Error("Free daily AI limit used up");
    err.status = 429;
    err.daily = true;
    err.retryAfterMs = Math.max(60000, until - Date.now());
    throw err;
  }
  throw lastErr;
}

async function callGeminiModel(model, b64, prompt) {
  const generationConfig = { responseMimeType: "application/json", temperature: 0.2 };
  if (!geminiNoThinking.has(model)) generationConfig.thinkingConfig = { thinkingLevel: "low" };
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": settings.apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: "image/jpeg", data: b64 } }] }],
        generationConfig,
      }),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error?.message || "";
    if (res.status === 400 && /thinking/i.test(msg) && !geminiNoThinking.has(model)) {
      geminiNoThinking.add(model);
      return callGeminiModel(model, b64, prompt);
    }
    const err = httpError(res, msg);
    const retry = data.error?.details?.find((d) => d.retryDelay)?.retryDelay;
    if (retry) err.retryAfterMs = parseFloat(retry) * 1000 + 500;
    err.daily = res.status === 429 && /PerDay/.test(JSON.stringify(data.error?.details || []));
    if (!err.daily && err.retryAfterMs) err.retryAfterMs = Math.min(60000, err.retryAfterMs);
    throw err;
  }
  return data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
}

async function callOpenAI(dataUrl, prompt) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.apiKey}` },
    body: JSON.stringify({
      model: settings.model || DEFAULT_MODELS.openai,
      response_format: { type: "json_object" },
      temperature: 0.2,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
          ],
        },
      ],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = httpError(res, data.error?.message);
    const ra = Number(res.headers.get("retry-after"));
    if (ra) err.retryAfterMs = Math.min(60000, ra * 1000);
    throw err;
  }
  return data.choices?.[0]?.message?.content || "";
}

function httpError(res, msg) {
  const e = new Error(msg || `HTTP ${res.status}`);
  e.status = res.status;
  return e;
}

function parseItems(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return [];
  try {
    const arr = JSON.parse(match[0]).items;
    return Array.isArray(arr) ? arr.filter((i) => i && i.name) : [];
  } catch {
    return [];
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
  const low = num(raw.resale_low) ?? 0;
  const high = num(raw.resale_high) ?? low;
  const cost = tag ?? storeEst ?? 0;
  const resale = (low + high) / 2;
  const profit = resale * (1 - FEE_RATE) - cost;
  return {
    name: String(raw.name).slice(0, 120),
    category: String(raw.category || "").slice(0, 40),
    condition: String(raw.condition || "").slice(0, 40),
    why: String(raw.why || "").slice(0, 200),
    labelText: raw.label_text ? String(raw.label_text).slice(0, 200) : "",
    tagPrice: tag,
    cost,
    priceIsEstimate: tag == null,
    low,
    high,
    profit: Math.round(profit * 100) / 100,
    confidence: num(raw.confidence) ?? 0.5,
    box: parseBox(raw.box_2d),
  };
}
function isDeal(it) {
  return it.profit >= settings.minProfit && it.confidence >= MIN_CONFIDENCE;
}
function recomputeDeals() {
  items.forEach((it) => (it.deal = isDeal(it)));
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
  if (!found.length) return [];
  const img = job.dataUrl ? await loadImage(job.dataUrl).catch(() => null) : null;
  let photoSaved = false;
  const savePhoto = async () => {
    if (photoSaved || !job.dataUrl) return;
    photoSaved = true;
    await putPhoto(job.id, await (await fetch(job.dataUrl)).blob()).catch(() => {});
  };
  const newDeals = [];
  const touched = [];
  for (const raw of found) {
    const ev = evaluate(raw);
    const key = keyOf(ev.name);
    if (!key) continue;
    const sighting = { photoId: job.dataUrl ? job.id : null, seenAt: job.takenAt, box: ev.box, thumb: img ? cropThumb(img, ev.box) : null };
    let it = items.find((i) => i.key === key);
    if (it) {
      const wasDeal = it.deal;
      const better = (ev.tagPrice != null && it.tagPrice == null) || ev.confidence > it.confidence;
      if (better) Object.assign(it, ev);
      Object.assign(it, sighting);
      it.deal = isDeal(it);
      if (it.deal && !wasDeal) newDeals.push(it);
    } else {
      it = { ...ev, key, ...sighting };
      it.deal = isDeal(it);
      items.unshift(it);
      if (it.deal) newDeals.push(it);
    }
    if (job.label) it.fromLabel = true;
    touched.push(it);
    if (it.photoId) await savePhoto();
  }
  items = items.slice(0, MAX_PHOTOS);
  if (newDeals.length && !job.label) alertDeal(newDeals[0]);
  persist();
  render();
  prunePhotos().catch(() => {});
  return touched;
}

// ---------- Label snap ----------
let snapping = false;
async function snapLabel() {
  if (snapping) return;
  if (settings.provider !== "demo" && !settings.apiKey) {
    alert("Add your API key in Settings (gear icon), or switch to Demo mode.");
    return;
  }
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
    const found = (await analyze(job.dataUrl, LABEL_PROMPT)).slice(0, 1);
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
  if (!scanning) return setStatus(stream ? "Label mode · point at a tag, tap Snap Label" : "Idle", !!stream);
  const parts = [`${stats.photos} photos`];
  if (inFlight || queue.length) parts.push(`analyzing ${inFlight + queue.length}`);
  const wait = Math.ceil((pausedUntil - Date.now()) / 1000);
  if (wait > 0) {
    const label = lastError === "Free daily AI limit used up" ? "free daily AI limit used up" : "AI limit";
    parts.push(`${label}, resuming in ${wait > 120 ? Math.ceil(wait / 60) + "m" : wait + "s"}`);
  }
  else if (lastError && Date.now() - lastErrorAt < 8000) parts.push(`error: ${lastError}`);
  setStatus("Scanning · " + parts.join(" · "), true);
}

function pricesHtml(it) {
  const priceLabel = it.priceIsEstimate ? `~${money(it.cost)} (no tag)` : money(it.cost);
  return `<span>Price: ${priceLabel}</span><span>Resells: ${money(it.low)}–${money(it.high)}</span>`;
}
function itemEl(it) {
  const li = document.createElement("li");
  li.className = "item";
  li.onclick = (e) => {
    if (e.target.tagName !== "A") openViewer(it);
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
  meta.textContent = [it.category, it.condition, `${Math.round(it.confidence * 100)}% sure`].filter(Boolean).join(" · ");
  const prices = document.createElement("div");
  prices.className = "prices";
  prices.innerHTML = pricesHtml(it);
  const profit = document.createElement("span");
  profit.className = "profit" + (it.profit < 0 ? " neg" : "");
  profit.textContent = `Profit: ${money(it.profit)}`;
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
  info.append(name, meta, prices, seen, why, link);
  li.appendChild(info);
  return li;
}
const ebayUrl = (it) => `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(it.name)}&LH_Sold=1&LH_Complete=1`;

let viewerUrl = null;
async function openViewer(it) {
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
  $("viewerPrices").innerHTML = pricesHtml(it) + `<span class="profit${it.profit < 0 ? " neg" : ""}">Profit: ${money(it.profit)}</span>`;
  $("viewerLink").href = ebayUrl(it);
  $("viewer").showModal();
}

function render() {
  const deals = items.filter((i) => i.deal).sort((a, b) => b.profit - a.profit);
  $("dealCount").textContent = deals.length;
  $("seenCount").textContent = items.length;
  $("dealsList").replaceChildren(...deals.map(itemEl));
  $("seenList").replaceChildren(...items.map(itemEl));
  $("dealsList").hidden = activeTab !== "deals";
  $("seenList").hidden = activeTab !== "seen";
  const shown = activeTab === "deals" ? deals.length : items.length;
  $("emptyMsg").hidden = shown > 0;
  $("emptyMsg").textContent = activeTab === "deals" ? "No deals yet. Start scanning!" : "Nothing seen yet.";
  $("clearBtn").hidden = items.length === 0;
}
document.querySelectorAll(".tab").forEach((b) => {
  b.onclick = () => {
    activeTab = b.dataset.tab;
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === b));
    render();
  };
});
$("clearBtn").onclick = () => {
  if (!confirm("Clear all scanned items?")) return;
  items = [];
  persist();
  render();
  prunePhotos().catch(() => {});
};

document.addEventListener("visibilitychange", async () => {
  if (scanning && document.visibilityState === "visible") {
    try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
  }
});
setInterval(() => {
  updateStatus();
  if (!scanning) render();
}, 30000);
setInterval(updateStatus, 1000);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
recomputeDeals();
updateBadge();
render();
