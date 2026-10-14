"use strict";

const $ = (id) => document.getElementById(id);
const DEFAULT_MODELS = { gemini: "gemini-flash-latest", openai: "gpt-4o-mini", demo: "" };
const GEMINI_FALLBACKS = ["gemini-flash-latest", "gemini-3.8-flash", "gemini-3.5-flash", "gemini-flash-lite-latest"];
let geminiFallbackIdx = 0;
const FEE_RATE = 0.15;
const MIN_CONFIDENCE = 0.5;

const settings = Object.assign(
  { provider: "demo", apiKey: "", model: "", minProfit: 15, interval: 3, vibrate: true },
  JSON.parse(localStorage.getItem("ts-settings") || "{}")
);
let items = JSON.parse(localStorage.getItem("ts-items") || "[]");

let stream = null;
let scanning = false;
let busy = false;
let timer = null;
let wakeLock = null;
let backoffUntil = 0;
let audioCtx = null;
let activeTab = "deals";

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
- why: one short sentence explaining the value
Respond ONLY with JSON: {"items":[...]}. If nothing is worth noting, respond {"items":[]}.`;

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
  settings.interval = Math.min(30, Math.max(1, Number($("interval").value) || 3));
  settings.vibrate = $("vibrate").checked;
  saveSettings();
  recomputeDeals();
  render();
};

// ---------- Camera + scan loop ----------
async function startCamera() {
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
  $("recordBtn").textContent = "Stop Scanning";
  $("recordBtn").classList.add("on");
  setStatus("Scanning…", true);
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
  unlockAudio();
  tick();
}
function stop() {
  scanning = false;
  clearTimeout(timer);
  stopCamera();
  $("recordBtn").textContent = "Start Scanning";
  $("recordBtn").classList.remove("on");
  setStatus("Idle");
  wakeLock?.release?.();
  wakeLock = null;
}
$("recordBtn").onclick = () => (scanning ? stop() : start());

async function tick() {
  if (!scanning) return;
  if (!busy && Date.now() >= backoffUntil) {
    busy = true;
    try {
      const frame = captureFrame(1024, 0.7);
      const thumb = captureFrame(160, 0.6);
      setStatus("Analyzing…", true);
      const found = await analyze(frame);
      handleResults(found, thumb);
      setStatus(`Scanning… (${found.length} item${found.length === 1 ? "" : "s"} in view)`, true);
    } catch (e) {
      console.error(e);
      if (e.status === 429 || e.status === 503) backoffUntil = Date.now() + 15000;
      setStatus("Error: " + e.message, true);
    } finally {
      busy = false;
    }
  }
  timer = setTimeout(tick, settings.interval * 1000);
}

function captureFrame(maxSide, quality) {
  const v = $("video");
  if (!stream || !v.videoWidth) return null;
  const scale = Math.min(1, maxSide / Math.max(v.videoWidth, v.videoHeight));
  const c = $("canvas");
  c.width = Math.round(v.videoWidth * scale);
  c.height = Math.round(v.videoHeight * scale);
  c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", quality);
}

// ---------- AI providers ----------
async function analyze(dataUrl) {
  if (settings.provider === "demo") return demoAnalyze();
  if (!dataUrl) throw new Error("camera not ready");
  const b64 = dataUrl.split(",")[1];
  const text = settings.provider === "gemini" ? await callGemini(b64) : await callOpenAI(dataUrl);
  return parseItems(text);
}

async function callGemini(b64) {
  const chain = settings.model ? [settings.model] : GEMINI_FALLBACKS;
  let lastErr;
  for (let n = 0; n < chain.length; n++) {
    const idx = (geminiFallbackIdx + n) % chain.length;
    try {
      const text = await callGeminiModel(chain[idx], b64);
      geminiFallbackIdx = idx;
      return text;
    } catch (e) {
      lastErr = e;
      if (![404, 500, 503].includes(e.status)) throw e;
    }
  }
  throw lastErr;
}

async function callGeminiModel(model, b64) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": settings.apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: "image/jpeg", data: b64 } }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
      }),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res, data.error?.message);
  return data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
}

async function callOpenAI(dataUrl) {
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
            { type: "text", text: PROMPT },
            { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
          ],
        },
      ],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res, data.error?.message);
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
  { name: "Paperback mystery novel", category: "books", condition: "good", tag_price: 1, est_store_price: 1, resale_low: 1, resale_high: 4, confidence: 0.5, why: "Low resale value." },
  { name: "Levi's 501 jeans (Made in USA)", category: "clothing", condition: "good", tag_price: 6.99, est_store_price: 7, resale_low: 40, resale_high: 90, confidence: 0.65, why: "Vintage USA-made 501s are sought after." },
];
async function demoAnalyze() {
  await new Promise((r) => setTimeout(r, 600));
  const n = Math.floor(Math.random() * 3);
  return Array.from({ length: n }, () => ({ ...DEMO_ITEMS[Math.floor(Math.random() * DEMO_ITEMS.length)] }));
}

// ---------- Deal logic ----------
const num = (v) => (typeof v === "number" && isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && isFinite(+v) ? +v : null);
const keyOf = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function evaluate(raw) {
  const tag = num(raw.tag_price);
  const storeEst = num(raw.est_store_price);
  const low = num(raw.resale_low) ?? 0;
  const high = num(raw.resale_high) ?? low;
  const cost = tag ?? storeEst ?? 0;
  const resale = (low + high) / 2;
  const profit = resale * (1 - FEE_RATE) - cost;
  const confidence = num(raw.confidence) ?? 0.5;
  return {
    name: String(raw.name).slice(0, 120),
    category: String(raw.category || "").slice(0, 40),
    condition: String(raw.condition || "").slice(0, 40),
    why: String(raw.why || "").slice(0, 200),
    tagPrice: tag,
    cost,
    priceIsEstimate: tag == null,
    low,
    high,
    profit: Math.round(profit * 100) / 100,
    confidence,
  };
}
function isDeal(it) {
  return it.profit >= settings.minProfit && it.confidence >= MIN_CONFIDENCE;
}
function recomputeDeals() {
  items.forEach((it) => (it.deal = isDeal(it)));
}

function handleResults(found, thumb) {
  let newDeals = [];
  for (const raw of found) {
    const ev = evaluate(raw);
    const key = keyOf(ev.name);
    if (!key) continue;
    const existing = items.find((i) => i.key === key);
    if (existing) {
      const better = (ev.tagPrice != null && existing.tagPrice == null) || ev.confidence > existing.confidence;
      if (better) Object.assign(existing, ev, { thumb: thumb || existing.thumb });
      existing.seenAt = Date.now();
      const wasDeal = existing.deal;
      existing.deal = isDeal(existing);
      if (existing.deal && !wasDeal) newDeals.push(existing);
    } else {
      const it = { ...ev, key, thumb, seenAt: Date.now() };
      it.deal = isDeal(it);
      items.unshift(it);
      if (it.deal) newDeals.push(it);
    }
  }
  if (newDeals.length) alertDeal(newDeals[0]);
  persist();
  render();
}

function persist() {
  try {
    localStorage.setItem("ts-items", JSON.stringify(items.slice(0, 200)));
  } catch {
    localStorage.setItem("ts-items", JSON.stringify(items.slice(0, 200).map(({ thumb, ...r }) => r)));
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
  t.textContent = `Deal: ${it.name} · ~${money(it.profit)} profit`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4000);
  if (settings.vibrate) {
    navigator.vibrate?.([120, 60, 120]);
    beep();
  }
}

// ---------- Rendering ----------
const money = (n) => (n < 0 ? "-$" : "$") + Math.abs(n).toFixed(n % 1 === 0 ? 0 : 2);
function setStatus(text, live) {
  $("status").textContent = text;
  $("status").classList.toggle("scanning", !!live);
}
function itemEl(it) {
  const li = document.createElement("li");
  li.className = "item";
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
  const priceLabel = it.priceIsEstimate ? `~${money(it.cost)} (no tag)` : money(it.cost);
  prices.innerHTML = `<span>Price: ${priceLabel}</span><span>Resells: ${money(it.low)}–${money(it.high)}</span>`;
  const profit = document.createElement("span");
  profit.className = "profit" + (it.profit < 0 ? " neg" : "");
  profit.textContent = `Profit: ${money(it.profit)}`;
  prices.appendChild(profit);
  const why = document.createElement("div");
  why.className = "meta";
  why.textContent = it.why;
  const link = document.createElement("a");
  link.href = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(it.name)}&LH_Sold=1&LH_Complete=1`;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = "Check eBay sold prices →";
  info.append(name, meta, prices, why, link);
  li.appendChild(info);
  return li;
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
};

document.addEventListener("visibilitychange", async () => {
  if (scanning && document.visibilityState === "visible") {
    try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
  }
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
recomputeDeals();
updateBadge();
render();
