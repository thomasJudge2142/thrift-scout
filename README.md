# Thrift Scout

Thrift Scout automatically scans thrift-store shelves, captures a photo when the view is steady, sharp, and new, and researches the likely item's resale value in the background.

## Automatic identification and pricing

In live mode, each accepted photo follows this pipeline:

1. Google Cloud Vision **Web Detection** searches for visual matches and related pages. This is Google's supported visual-search API; it is not the Google Lens app or a Lens API.
2. Gemini receives the photo and any useful visual matches, identifies the item, and uses Google Search grounding to estimate current secondhand value.
3. The result, confidence, price evidence, and available source links are stored locally and shown in the app. If visual search fails or finds no confident match, Gemini identifies the item directly from the photo.

Search grounding may find asking prices rather than verified completed sales. Estimates and source pages are not guarantees of a completed sale or actual transaction value; check the cited pages before buying.

## Deploy the secure backend

Live mode uses a Cloudflare Worker so Google credentials are not included in the browser app.

1. In a Google Cloud project, enable the **Cloud Vision API** and create an API key restricted to that API. Create a Gemini API key in [Google AI Studio](https://aistudio.google.com/apikey). Google Search grounding can require billing to be enabled for the Gemini key.
2. Install or run Wrangler from the project directory and add the keys as Worker secrets:

   ```sh
   npx wrangler secret put GEMINI_API_KEY
   npx wrangler secret put VISION_API_KEY
   ```

   The keys are entered at the prompts and stored by Cloudflare. Never put them in `app.js`, `index.html`, or browser settings.
3. For local live testing, create an untracked `.dev.vars` file (already git-ignored) with `GEMINI_API_KEY=...` and `VISION_API_KEY=...`. Run `npx wrangler dev`, then deploy with `npx wrangler deploy`.

The Worker exposes only the same-origin `/api/analyze` endpoint, applies a Cloudflare rate limit, limits request size, and sets upstream request timeouts. Provider adapters are isolated in `worker.mjs`; `IDENTIFICATION_PROVIDER` defaults to `google-cloud-vision`, and `PRICING_PROVIDER` defaults to `gemini-google-search`. In live mode, each accepted camera frame is sent to Google Cloud Vision and Gemini for processing; the Worker caches only the result for five minutes, not the image. Results and item photos are stored in the user's browser.

## Use the app

1. Open the deployed app on a phone and allow camera access.
2. Choose **Live (Google visual search + Gemini)** in Settings.
3. Tap **Start Scanning** and slowly walk the aisles. The app captures accepted frames automatically and continues scanning until stopped or paused.
4. Tap a result to inspect the saved photo, estimate, evidence, and source links. The optional **Label** control takes a close-up of a clothing label.

Demo mode works without network access to the AI services and returns simulated results; it does not perform visual or web searches.

## Local demo without Cloudflare

```sh
python3 -m http.server 8080
```

Camera access requires HTTPS (or localhost). Live analysis requires the Worker, its rate-limit binding, and the backend secrets configured above.
