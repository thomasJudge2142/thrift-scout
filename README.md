# Thrift Scout

Point your phone camera at thrift store shelves and Thrift Scout flags items worth flipping.

Every few seconds it sends a camera frame to an AI vision model (Google Gemini or OpenAI), which identifies items, reads price tags, and estimates eBay resale value. Items where estimated resale (minus ~15% fees) beats the price by your minimum profit show up as deals, with a vibration/beep and an eBay sold-listings link to double-check.

## Use it
1. Open the hosted app on your phone and add it to your home screen.
2. Tap the gear icon, choose **Google Gemini**, and paste your API key (get a free one at https://aistudio.google.com/apikey). The key is stored only on your device.
3. Tap **Start Scanning** and pause a few seconds at each shelf.

Demo mode works without a key and shows fake results.

## Run locally
It's a static site with no build step:

```sh
python3 -m http.server 8080
```

Camera access requires HTTPS (or localhost).
