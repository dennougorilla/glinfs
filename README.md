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

### AI cutout
In the **Background** panel, set **Method** to **AI cutout** to cut the subject out of every frame with a segmentation model that runs in your browser. Choose the **Model**: **Anime** for anime and illustrated characters, or **General** for people, pets and objects in live-action video. **Analyze selection** analyzes the frames between IN and OUT with the chosen model; the first analysis with a model downloads it once (88 MB for Anime, 90 MB for General, plus about 27 MB for the runtime the first time; kept in the browser's cache afterwards). Your frames never leave your device. Progress shows the download, then the frames done and the time left; you can keep editing meanwhile, and **Cancel** keeps the frames already analyzed.

Each model keeps its own analysis: switching the model shows that model's progress, and switching back reuses the frames it already analyzed. Threshold, smoothing, edge and picks stay as they are across a switch (a pick selects whatever the other model finds at that spot). The model cannot be changed while an analysis runs.

The analysis needs WebGPU to be fast (under a second per frame on a recent GPU). Without WebGPU it can still run on the CPU after you choose **Run without WebGPU (very slow)**, at about 14 seconds per frame. The same choice appears when the browser has WebGPU but the chosen model cannot run on it; it concerns that model only, so the other model still runs on WebGPU.

Once frames are analyzed, adjust **Threshold** (higher keeps less), **Smooth between frames** and **Edge** (grow or shrink the cutout by up to 8 pixels). **Keep** and **Remove** pick tools: click a character in the preview to keep only the picked characters, or to remove them; each pick is followed through the whole clip, including the frames before it. Picks are listed with their time and can be removed one by one or with **Clear picks**. Frames that are not analyzed yet preview without the cutout; Export analyzes the exported frames that are still missing (with progress) before it encodes.

**Settings → Downloaded models** lists each model with its size and license and whether this browser keeps it; **Delete** removes a downloaded model from the browser's cache (not while an analysis uses it). The next analysis with it downloads it again.

Press Escape to leave a pick tool or the eyedropper, then to deselect a caption, then to clear the crop. With a caption selected, Delete removes the caption, not the clip. Your edits stay with the clip when you go back to Capture, export, or switch clips in the queue.

### Open existing GIFs and images
Use **Open GIF or image** on the Capture screen, or drop a file on the preview, to edit an existing GIF, APNG, animated WebP, PNG, JPEG or WebP file with the same trim, crop, text and transparency tools. Frame timing and transparent pixels are kept when you export it again.

### Export
Press **Export** in the editor (or Ctrl/Cmd+E) to open the Export GIF dialog over it. Choose the encoder, quality, frame rate, loop count and output scale; the GIF plays at the editor's playback speed (0.25x to 4x). Set a **Target size** in MB to fit an upload limit: the export lowers the colors, then the frame rate, then the scale until the GIF fits. The finished GIF is shown with its size, dimensions and frame count, ready to download or open in a new tab.

## Privacy

All processing happens entirely in your browser. Your screen recordings never leave your device - no uploads, no servers, no tracking. The AI cutout's models are downloaded once from this site and runs locally; frames are never sent anywhere.

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
3. **Export** - Press Export in the editor, adjust the settings in the dialog and download your GIF

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

The AI cutout runs one of two IS-Net segmentation models in the browser with
[ONNX Runtime Web](https://onnxruntime.ai/) (MIT), inside a Web Worker:

- **Anime**: skytnt's [anime-segmentation](https://github.com/SkyTNT/anime-segmentation)
  model (`isnetis-fp16.onnx`, Apache-2.0, 88 MB)
- **General**: [DIS](https://github.com/xuebinqin/DIS) IS-Net general-use
  (`isnet-general-fp16.onnx`, Apache-2.0, 90 MB)

Both are fp16 conversions of the upstream fp32 files (176 and 179 MB): half
the download, and faster on WebGPU, with the same masks for practical
purposes (see below). Both are described once in
`src/features/ai-cutout/model-registry.js` (the shipped file's size and
SHA-256, the upstream file it was converted from, license and
preprocessing); the worker, the fetch script, Settings and the deploy
workflow read it.
The models are not in the repository; they are assets of the
[`models-v1` release](https://github.com/dennougorilla/glinfs/releases/tag/models-v1).
Download them once for local development:

```bash
npm run models:fetch            # into public/models/ (git-ignored), verified by SHA-256
npm run models:fetch -- --check # verify an existing copy without downloading
```

#### Converting the models to fp16

`scripts/convert-models-fp16.py` makes the release assets from the upstream
files (pinned Hugging Face commits, checked by SHA-256). It keeps only the
output the worker reads (the general model's 11 side outputs go) and converts
the rest to float16 with `onnxconverter-common`, keeping the input and the
output float32, so the worker code is the same for fp32 and fp16. With the
versions pinned in `scripts/requirements-models.txt` (Python 3.11) the output
is byte-for-byte identical to the release assets:

```bash
python3.11 -m venv .venv-models
.venv-models/bin/pip install -r scripts/requirements-models.txt
.venv-models/bin/python scripts/convert-models-fp16.py --src /path/to/fp32 --out /path/to/fp16
```

`--src` holds `isnetis.onnx` and `isnet-general-use.onnx` (downloaded there
when missing). The script prints each file's size and SHA-256, which must
equal the registry's pins. To publish new conversions, upload them to a new
release, then update the release URL, sizes and SHA-256s in the registry, the
deploy workflow's cache key and checks, and `THIRD_PARTY_NOTICES.md` (the
unit tests check that these agree).

Measured through the app's own worker on WebGPU (headless Chromium, Apple
Metal 3 adapter), fp16 against fp32, masks thresholded at 0.5:

| Model | Test images | Mean abs. difference | Max abs. difference | Pixels that agree | Median per frame (fp32 → fp16) |
| --- | --- | --- | --- | --- | --- |
| Anime | 6 CC0 anime-style illustrations | 0.00005–0.00016 | 0.051 | ≥ 99.99% | 469 → 356 ms |
| General | 4 CC0 photos | 0.00001–0.00117 | 0.075 | ≥ 99.55% | 705 → 515 ms |

(Mask values are the app's 8-bit masks, 0–1; 12 frames per image, 3 of them
compared. fp16 was faster on every image in two runs; absolute times vary with
the machine's load.)

The Pages deploy workflow runs the same script before `vite build`, so the
site serves the models from its own origin. The browser downloads a model only
when someone starts an analysis with it, checks its SHA-256 and keeps it in Cache Storage.
`npm run build` and the E2E suite do not need it: E2E serves the tiny stub
models in `tests/fixtures/models/` (regenerate them with
`node scripts/generate-stub-seg-model.mjs`). To check a real model on this
machine's GPU, run
`E2E_REAL_MODEL=1 E2E_REAL_IMAGE=/path/to/anime.jpg npx playwright test tests/e2e/ai-cutout-real-model.spec.js`
(add `E2E_REAL_MODEL_ID=general` with a live-action photo for the general
model; `E2E_REAL_IMAGE` takes several comma-separated paths).
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the licenses.

### Architecture

Vanilla JavaScript (ES modules) with no UI framework, built with Vite.
Capture, encoding, and scene detection run in Web Workers; all processing
stays client-side. Source is organized as `src/features/*` (capture, editor,
export, scene-detection) over a `src/shared/` core, with workers in
`src/workers/`.
