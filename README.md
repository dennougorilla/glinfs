# Glinfs

High-performance screen capture to GIF converter.

[![License: GPL 3.0](https://img.shields.io/badge/License-GPL3.0-blue.svg)](LICENSE)
[![GitHub Pages](https://img.shields.io/badge/demo-GitHub%20Pages-brightgreen)](https://dennougorilla.github.io/glinfs/)

<!-- Demo GIF placeholder - add your own demo.gif here -->
<!-- ![Glinfs Demo](./docs/demo.gif) -->

## Features

### Capture
Record your screen with up to 60 FPS. Supports window, tab, or entire screen capture with a rolling buffer of up to 60 seconds.

### Edit
Trim your clip by selecting start and end frames. Crop and zoom to focus on specific areas with preset aspect ratios (1:1, 16:9, 4:3, and more).

### Text and transparent backgrounds
Add captions in the editor's **Text** panel: type the text, pick the font, size, fill and outline colors, an optional background box and the alignment, then drag the caption into place on the preview. **Start** / **End** (with "Set to playhead") choose which frames show it; **Whole clip** resets that. Captions are burned into the exported GIF.

The **Background** panel removes a solid background: turn on **Remove background** (it picks the most common edge color) or use **Pick from preview** and click the background, then adjust the **Tolerance**. **Edges only** removes the matching color connected to the frame border; **All matching** removes it everywhere. Removed pixels become transparent in the GIF. GIF transparency is on or off per pixel, so soft edges are not preserved. Transparent GIFs are written with the JavaScript encoder.

### AI cutout (anime)
In the **Background** panel, set **Method** to **AI cutout (anime)** to cut the characters out of every frame with an anime segmentation model that runs in your browser. **Analyze selection** analyzes the frames between IN and OUT; the first analysis downloads about 200 MB once (the model and its runtime, kept in the browser's cache afterwards). Your frames never leave your device. Progress shows the download, then the frames done and the time left; you can keep editing meanwhile, and **Cancel** keeps the frames already analyzed.

The analysis needs WebGPU to be fast (under a second per frame on a recent GPU). Without WebGPU it can still run on the CPU after you choose **Run without WebGPU (very slow)**, at about 14 seconds per frame.

Once frames are analyzed, adjust **Threshold** (higher keeps less), **Smooth between frames** and **Edge** (grow or shrink the cutout by up to 8 pixels). **Keep** and **Remove** pick tools: click a character in the preview to keep only the picked characters, or to remove them; each pick is followed through the whole clip, including the frames before it. Picks are listed with their time and can be removed one by one or with **Clear picks**. Frames that are not analyzed yet preview without the cutout; Export analyzes the exported frames that are still missing (with progress) before it encodes.

Press Escape to leave a pick tool or the eyedropper, then to deselect a caption, then to clear the crop. With a caption selected, Delete removes the caption, not the clip. Your edits stay with the clip when you go back to Capture, open Export, or switch clips in the queue.

### Open existing GIFs and images
Use **Open GIF or image** on the Capture screen, or drop a file on the preview, to edit an existing GIF, APNG, animated WebP, PNG, JPEG or WebP file with the same trim, crop, text and transparency tools. Frame timing and transparent pixels are kept when you export it again.

### Export
Convert to GIF with customizable quality, playback speed, and frame rate settings. Real-time preview before final export.

## Privacy

All processing happens entirely in your browser. Your screen recordings never leave your device - no uploads, no servers, no tracking. The AI cutout's model is downloaded once from this site and runs locally; frames are never sent anywhere.

## Getting Started

**Try it now:** [https://dennougorilla.github.io/glinfs/](https://dennougorilla.github.io/glinfs/)

### Browser Support
- Chrome 94+
- Edge 94+

(Chromium-based browsers only - Screen Capture API required)

## How to Use

1. **Capture** - Click "Start Capture" and select your screen, window, or tab
   (or click "Open GIF or image" to edit an existing file)
2. **Edit** - Use the timeline to trim, the crop tool to focus on specific areas, and the Text and Background panels to add captions or remove a background
3. **Export** - Adjust quality settings and download your GIF

## Development

Requirements: Node.js 20.19+ or 22.12+ (required by Vite 7)

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Run unit & integration tests (watch mode: npm run test:watch)
npm test

# Run tests with coverage report
npm run test:coverage

# Run E2E tests (Chromium)
npm run test:e2e

# Production build
npm run build
```

### AI cutout model

The AI cutout runs skytnt's
[anime-segmentation](https://github.com/SkyTNT/anime-segmentation) model
(`isnetis.onnx`, Apache-2.0, 176 MB) in the browser with
[ONNX Runtime Web](https://onnxruntime.ai/) (MIT), inside a Web Worker.
The model is not in the repository. Download it once for local development:

```bash
npm run models:fetch            # into public/models/ (git-ignored), verified by SHA-256
npm run models:fetch -- --check # verify an existing copy without downloading
```

The Pages deploy workflow runs the same script before `vite build`, so the
site serves the model from its own origin. The browser downloads it only when
someone starts an analysis, checks its SHA-256 and keeps it in Cache Storage.
`npm run build` and the E2E suite do not need it: E2E serves the tiny stub
model in `tests/fixtures/models/` (regenerate it with
`node scripts/generate-stub-seg-model.mjs`). To check the real model on this
machine's GPU, run
`E2E_REAL_MODEL=1 E2E_REAL_IMAGE=/path/to/anime.jpg npx playwright test tests/e2e/ai-cutout-real-model.spec.js`.
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the licenses.

### Architecture

Vanilla JavaScript (ES modules) with no UI framework, built with Vite.
Capture, encoding, and scene detection run in Web Workers; all processing
stays client-side. Source is organized as `src/features/*` (capture, editor,
export, scene-detection) over a `src/shared/` core, with workers in
`src/workers/`.
