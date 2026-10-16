import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest, identifyWithCloudVision, runPipeline } from "./worker.mjs";

const validInput = { image: "aGVsbG8=", mimeType: "image/jpeg", mode: "scan" };
const allowed = { limit: async () => ({ success: true }) };

test("rejects non-POST analysis requests", async () => {
  const response = await handleRequest(new Request("https://scout.example/api/analyze"), { RATE_LIMITER: allowed });
  assert.equal(response.status, 405);
});

test("rejects cross-origin calls", async () => {
  const response = await handleRequest(new Request("https://scout.example/api/analyze", {
    method: "POST",
    headers: { Origin: "https://attacker.example" },
    body: JSON.stringify(validInput),
  }), { RATE_LIMITER: allowed });
  assert.equal(response.status, 403);
});

test("rejects oversized images", async () => {
  const response = await handleRequest(new Request("https://scout.example/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...validInput, image: "a".repeat(8_000_001) }),
  }), { RATE_LIMITER: allowed });
  assert.equal(response.status, 400);
});

test("stops requests when the caller is rate limited", async () => {
  const response = await handleRequest(new Request("https://scout.example/api/analyze", {
    method: "POST",
    body: JSON.stringify(validInput),
  }), { RATE_LIMITER: { limit: async () => ({ success: false }) } });
  assert.equal(response.status, 429);
});

test("reports missing backend credentials as a non-retryable configuration error", async () => {
  const response = await handleRequest(new Request("https://scout.example/api/analyze", {
    method: "POST",
    body: JSON.stringify(validInput),
  }), { RATE_LIMITER: allowed });
  const result = await response.json();
  assert.equal(response.status, 503);
  assert.equal(result.retryable, false);
  assert.match(result.error, /Gemini API key is missing/);
});

test("returns confident Google visual matches and only safe source links", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({
    responses: [{
      webDetection: {
        webEntities: [{ description: "Vintage Pyrex Butterprint", score: 0.91 }],
        bestGuessLabels: [],
        pagesWithMatchingImages: [
          { pageTitle: "Match", url: "https://example.com/item" },
          { pageTitle: "Unsafe", url: "javascript:alert(1)" },
        ],
      },
    }],
  }));
  const result = await identifyWithCloudVision("aGVsbG8=", "image/jpeg", "server-key");
  assert.equal(result.confident, true);
  assert.equal(result.candidates[0].name, "Vintage Pyrex Butterprint");
  assert.deepEqual(result.sources.map((source) => source.url), ["https://example.com/item"]);
});

test("falls back to Gemini image research when visual search finds no match", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith("https://vision.googleapis.com/")) {
      return new Response(JSON.stringify({ responses: [{ webDetection: {} }] }));
    }
    return new Response(JSON.stringify({
      candidates: [{
        content: { parts: [{ text: JSON.stringify({
          name: "Vintage Pyrex Butterprint bowl",
          brand: "Pyrex",
          model: "Butterprint",
          resale_low: 32,
          resale_high: 54,
          confidence: 0.91,
          price_evidence: "Comparable completed sales were found.",
          why: "Collectible pattern with visible good condition.",
        }) }] },
        groundingMetadata: { groundingChunks: [{ web: { title: "Comparable sale", uri: "https://example.com/sale" } }] },
      }],
    }));
  };
  const result = await runPipeline(
    { image: "aGVsbG8=", mimeType: "image/jpeg", mode: "scan", itemHint: "", categories: [] },
    { GEMINI_API_KEY: "server-key", VISION_API_KEY: "vision-key" }
  );
  assert.equal(calls.length, 2);
  assert.equal(result.items[0].visual_search, "gemini_fallback");
  assert.equal(result.items[0].name, "Vintage Pyrex Butterprint bowl");
  assert.deepEqual(result.items[0].sources.map((source) => source.type), ["research"]);
  assert.equal(result.items[0].resale_low, 32);
  assert.match(result.items[0].visual_search_warning, /Gemini identified/);
});

test("caches completed research by image and options without caching the image", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const values = new Map();
  const pending = [];
  globalThis.caches = {
    default: {
      match: async (request) => values.get(request.url)?.clone(),
      put: async (request, response) => { values.set(request.url, response.clone()); },
    },
  };
  let upstreamCalls = 0;
  globalThis.fetch = async (url) => {
    upstreamCalls++;
    if (String(url).startsWith("https://vision.googleapis.com/")) {
      return new Response(JSON.stringify({ responses: [{ webDetection: {} }] }));
    }
    return new Response(JSON.stringify({
      candidates: [{
        content: { parts: [{ text: JSON.stringify({
          name: "Item",
          confidence: 0.8,
          resale_low: 10,
          resale_high: 20,
          price_evidence: "Comparable sales found.",
        }) }] },
        groundingMetadata: { groundingChunks: [] },
      }],
    }));
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  });
  const request = () => new Request("https://scout.example/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(validInput),
  });
  const context = { waitUntil: (promise) => pending.push(promise) };
  const env = { RATE_LIMITER: allowed, GEMINI_API_KEY: "server-key", VISION_API_KEY: "vision-key" };
  const first = await handleRequest(request(), env, context);
  await Promise.all(pending);
  const second = await handleRequest(request(), env, context);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(upstreamCalls, 2);
  assert.equal(values.size, 1);
});

test("does not return a price or confident identity when Gemini is unsure", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({
    candidates: [{
      content: { parts: [{ text: JSON.stringify({
        name: "Possibly a vintage radio",
        confidence: 0.2,
        resale_low: 40,
        resale_high: 90,
        why: "The label and model are unreadable.",
      }) }] },
      groundingMetadata: { groundingChunks: [] },
    }],
  }));
  const result = await runPipeline(
    { image: "aGVsbG8=", mimeType: "image/jpeg", mode: "scan", itemHint: "", categories: [] },
    { GEMINI_API_KEY: "server-key" }
  );
  assert.equal(result.items[0].name, "Uncertain identification");
  assert.equal(result.items[0].confidence, 0.2);
  assert.equal(result.items[0].resale_low, null);
  assert.equal(result.items[0].resale_high, null);
});

test("static assets are forwarded to the Cloudflare assets binding", async () => {
  const request = new Request("https://scout.example/");
  const expected = new Response("asset");
  const result = await handleRequest(request, { ASSETS: { fetch: async (received) => {
    assert.equal(received, request);
    return expected;
  } } });
  assert.equal(result, expected);
});
