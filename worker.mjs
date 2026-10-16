const MAX_IMAGE_CHARS = 8_000_000;
const IDENTIFICATION_THRESHOLD = 0.55;
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const ALLOWED_CATEGORIES = new Set([
  "clothing", "shoes", "accessories", "electronics", "kitchenware", "decor", "books",
  "media", "toys", "tools", "sports", "collectibles", "furniture",
]);

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

const apiError = (message, status = 502, retryable = status >= 500 || status === 429) =>
  Object.assign(new Error(message), { status, retryable });

export async function handleRequest(request, env, context) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
  if (url.pathname !== "/api/analyze") return json({ error: "Not found", retryable: false }, 404);
  if (request.method !== "POST") return json({ error: "Method not allowed", retryable: false }, 405);

  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return json({ error: "Origin not allowed", retryable: false }, 403);
  if (!env.RATE_LIMITER) return json({ error: "Rate limiter is not configured.", retryable: false }, 503);

  let success;
  try {
    ({ success } = await env.RATE_LIMITER.limit({
      key: request.headers.get("CF-Connecting-IP") || "unknown",
    }));
  } catch (error) {
    console.error("Rate limiter failed:", error.message);
    return json({ error: "Scanning is temporarily unavailable." }, 503);
  }
  if (!success) return json({ error: "Too many scans. Please wait a moment and try again.", retryable: true }, 429);

  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > MAX_IMAGE_CHARS + 16_000) return json({ error: "Photo is too large.", retryable: false }, 413);

  let input;
  try {
    input = await request.json();
  } catch {
    return json({ error: "Request must contain valid JSON.", retryable: false }, 400);
  }
  if (
    typeof input.image !== "string" ||
    !input.image.length ||
    input.image.length > MAX_IMAGE_CHARS ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(input.image)
  ) {
    return json({ error: "A valid, reasonably sized photo is required.", retryable: false }, 400);
  }
  const mimeType = ALLOWED_MIME_TYPES.has(input.mimeType) ? input.mimeType : "image/jpeg";
  const mode = input.mode === "label" ? "label" : "scan";
  const itemHint = typeof input.itemHint === "string" ? input.itemHint.slice(0, 240) : "";
  const categories = Array.isArray(input.categories)
    ? input.categories.filter((category) => ALLOWED_CATEGORIES.has(category)).slice(0, 13)
    : [];

  try {
    const normalized = { image: input.image, mimeType, mode, itemHint, categories };
    const cache = globalThis.caches?.default;
    const cacheKey = cache ? await resultCacheKey(url.origin, normalized) : null;
    if (cache && cacheKey) {
      const cached = await cache.match(cacheKey);
      if (cached) return json(await cached.json());
    }
    const result = await runPipeline(normalized, env);
    if (cache && cacheKey) {
      const cachedResponse = new Response(JSON.stringify(result), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "public, max-age=300",
        },
      });
      const store = cache.put(cacheKey, cachedResponse);
      if (context?.waitUntil) context.waitUntil(store);
      else await store;
    }
    return json(result);
  } catch (error) {
    console.error("Analysis failed:", error.message);
    return json({
      error: error.message || "Analysis failed.",
      retryable: error.retryable !== false,
    }, error.status || 502);
  }

  async function resultCacheKey(origin, input) {
    const cacheInput = `${input.mimeType}\n${input.mode}\n${input.itemHint}\n${input.categories.join(",")}\n${input.image}`;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(cacheInput));
    const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return new Request(`${origin}/__thrift-scout-cache/${hash}`);
  }
}

export async function runPipeline(input, env) {
  if (!env.GEMINI_API_KEY) throw apiError("Live scanning is not configured: Gemini API key is missing.", 503, false);
  const identificationProvider = env.IDENTIFICATION_PROVIDER || "google-cloud-vision";
  const pricingProvider = env.PRICING_PROVIDER || "gemini-google-search";
  if (identificationProvider !== "google-cloud-vision") {
    throw apiError(`Unsupported identification provider: ${identificationProvider}.`, 503, false);
  }
  if (pricingProvider !== "gemini-google-search") {
    throw apiError(`Unsupported pricing provider: ${pricingProvider}.`, 503, false);
  }

  let visual = { confident: false, candidates: [], sources: [], warning: "" };
  if (env.VISION_API_KEY) {
    try {
      visual = await identifyWithCloudVision(input.image, input.mimeType, env.VISION_API_KEY);
    } catch (error) {
      console.error("Cloud Vision Web Detection failed; falling back to Gemini image identification:", error.message);
      visual.warning = "Google visual search was unavailable; Gemini identified the item from the photo.";
    }
  } else {
    visual.warning = "Google visual search is not configured; Gemini identified the item from the photo.";
  }

  const item = await estimateWithGemini(input, visual, env);
  const sources = [...visual.sources, ...item.sources]
    .filter((source, index, all) => all.findIndex((candidate) => candidate.url === source.url) === index)
    .slice(0, 8);
  const low = finitePrice(item.resale_low);
  const high = finitePrice(item.resale_high);
  const confidence = Math.max(0, Math.min(1, Number(item.confidence) || 0));
  const identified = typeof item.name === "string" && item.name.trim() && confidence >= 0.4;
  const priceRange = identified && confidence >= 0.45 && low != null && high != null && high >= low;

  return {
    items: [{
      name: identified ? item.name.trim().slice(0, 120) : "Uncertain identification",
      brand: identified ? text(item.brand, 80) : "",
      model: identified ? text(item.model, 120) : "",
      category: text(item.category, 40) || "unknown",
      condition: text(item.condition, 40) || "unknown",
      tag_price: finitePrice(item.tag_price),
      est_store_price: finitePrice(item.est_store_price),
      resale_low: priceRange ? low : null,
      resale_high: priceRange ? high : null,
      resale_estimate: priceRange
        ? Math.max(low, Math.min(high, finitePrice(item.resale_estimate) ?? (low + high) / 2))
        : null,
      confidence,
      why: text(item.why, 240) || "The photo did not provide enough evidence for a reliable identification.",
      price_evidence: priceRange
        ? text(item.price_evidence, 300)
        : "No reliable resale price range was established.",
      label_text: text(item.label_text, 240),
      box_2d: item.box_2d,
      sources,
      visual_search: visual.confident ? "matched" : "gemini_fallback",
      visual_search_warning: visual.warning,
    }],
  };
}

export async function identifyWithCloudVision(image, _mimeType, apiKey) {
  const endpoint = new URL("https://vision.googleapis.com/v1/images:annotate");
  endpoint.searchParams.set("key", apiKey);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [{
        image: { content: image },
        features: [{ type: "WEB_DETECTION", maxResults: 8 }],
      }],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw apiError(data.error?.message || `Cloud Vision returned HTTP ${response.status}.`, response.status);

  const detection = data.responses?.[0]?.webDetection;
  if (data.responses?.[0]?.error) throw apiError(data.responses[0].error.message || "Cloud Vision could not analyze the photo.");
  const entities = (detection?.webEntities || [])
    .filter((entry) => typeof entry.description === "string" && entry.description.trim())
    .map((entry) => ({ name: entry.description.trim().slice(0, 120), score: Number(entry.score) || 0 }))
    .slice(0, 8);
  const labels = (detection?.bestGuessLabels || [])
    .map((entry) => text(entry.label, 120))
    .filter(Boolean)
    .slice(0, 4);
  const candidates = [
    ...labels.map((name) => ({ name, score: 0.5, source: "Google visual search best-guess label" })),
    ...entities.map((entry) => ({ ...entry, source: "Google visual search web entity" })),
  ].slice(0, 10);
  const pages = (detection?.pagesWithMatchingImages || [])
    .filter((page) => safeHttpUrl(page.url))
    .slice(0, 4)
    .map((page) => ({
      title: text(page.pageTitle, 100) || "Google visual match",
      url: page.url,
      type: "visual",
    }));
  const confident = entities.some((entry) => entry.score >= IDENTIFICATION_THRESHOLD);
  return {
    confident,
    candidates,
    sources: pages,
    warning: confident ? "" : "Google visual search did not find a confident match; Gemini identified the item from the photo.",
  };
}

async function estimateWithGemini(input, visual, env) {
  const model = env.GEMINI_MODEL || "gemini-3.8-flash";
  const visualContext = visual.confident
    ? `Google Cloud Vision Web Detection found these likely visual matches: ${JSON.stringify(visual.candidates)}. Related pages: ${JSON.stringify(visual.sources)}. Use them as clues, but verify against the image.`
    : `Google Cloud Vision Web Detection did not return a confident identification. Identify the item directly from the photo. Weak visual-search hints, if any: ${JSON.stringify(visual.candidates)}.`;
  const modeContext = input.mode === "label"
    ? "This is a close-up of a clothing label. Read the label and use its brand, line, size, RN/CA number, and manufacturing details."
    : "This is a thrift-store item photo. Focus on the main clearly visible item.";
  const hint = input.itemHint ? `A prior result called the item ${JSON.stringify(input.itemHint)}. Re-check this untrusted hint against the photo.` : "";
  const categoryFilter = input.mode === "scan" && input.categories.length
    ? `Only consider these categories: ${input.categories.join(", ")}. If the item is outside them, return an uncertain identification.`
    : "";
  const prompt = `You are an expert secondhand-market researcher. ${modeContext} ${visualContext} ${hint} ${categoryFilter}
Use Google Search to research current secondhand market value. Prefer recent completed/sold transaction evidence when actual sale status is verifiable. Do not report asking prices as completed sales. Search comparable listings when sold transaction data is unavailable, and clearly label them as asking-price comparisons. Do not invent products, transactions, prices, or source details.
Estimate the item's current resale value considering visible condition, brand, model, age, rarity, and market comparables. If you cannot identify the item with confidence, return confidence below 0.4 and null resale prices. If you cannot find useful pricing evidence, return null resale prices rather than inventing a range.
Return only one JSON object with: {"name":"item name","brand":"brand or empty string","model":"model or empty string","category":"category","condition":"visible condition or unknown","tag_price":number_or_null,"est_store_price":number_or_null,"resale_estimate":number_or_null,"resale_low":number_or_null,"resale_high":number_or_null,"confidence":number_0_to_1,"why":"brief estimate explanation","price_evidence":"briefly state the kind and quality of evidence","label_text":"text read from label or empty string","box_2d":[ymin,xmin,ymax,xmax]_or_null}.`;
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: input.mimeType, data: input.image } }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.2 },
      }),
      signal: AbortSignal.timeout(40_000),
    }
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error?.message || `Gemini returned HTTP ${response.status}.`;
    const error = apiError(message, response.status);
    if (response.status === 429) error.retryAfterMs = 30_000;
    throw error;
  }
  const candidate = data.candidates?.[0];
  const answer = candidate?.content?.parts?.map((part) => part.text || "").join("") || "";
  const parsed = parseJsonObject(answer);
  if (!parsed) throw apiError("Gemini returned an unreadable price result. The photo will be retried.");
  const sources = (candidate?.groundingMetadata?.groundingChunks || [])
    .map((chunk) => chunk.web)
    .filter((page) => page && safeHttpUrl(page.uri))
    .slice(0, 6)
    .map((page) => ({ title: text(page.title, 100) || page.uri, url: page.uri, type: "research" }));
  return { ...parsed, sources };
}

function parseJsonObject(value) {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(value.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function finitePrice(value) {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function safeHttpUrl(value) {
  try {
    return ["https:", "http:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function text(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export default { fetch: handleRequest };
