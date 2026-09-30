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

The **Background** tab asks **What do you want to keep?** and makes the rest transparent in the GIF. Pick a card: **Anime** (characters and illustrations), **Person** (real people, fast), **Anything** (people, pets and objects), **Something else** (click the thing you want to keep) or **Solid color** (a green screen or flat backdrop); **Off** keeps the whole frame. The preview shows the result right away. **Hold to compare** over the preview (or hold the `\` key) shows the original while held, and **Show mask** tints what is removed in red. GIF transparency is on or off per pixel, so soft edges are not preserved. Transparent GIFs are written with the JavaScript encoder.

**Solid color** picks the most common edge color of the frame; the eyedropper (**Pick**) takes another one from the preview. **Similar colors** (Fewer … More) sets how close a color must be to go, and **Edges only** / **Everywhere** chooses between the backdrop connected to the frame border and every matching pixel.

### AI cutout
The **Anime**, **Person** and **Anything** cards cut the subject out of every frame with a segmentation model that runs in your browser (ISNet anime, MODNet and ISNet). Each card says whether its model is **Ready** or how much it downloads (88 MB, 13 MB, 90 MB, plus about 27 MB for the runtime the first time; kept in the browser's cache afterwards). Choosing a model that is not downloaded yet asks first (**Download 88 MB?**); nothing is downloaded without that. Your frames never leave your device.

Choosing a card starts at once with the frame on screen, so the preview shows a cutout within about a second, then analyzes the rest of the selection (IN to OUT) in the background. The status line under the cards shows the progress with **Cancel** (finished frames are kept), how many frames of the selection are not analyzed yet with **Analyze**, or that everything is done. Each model keeps its own analysis: switching cards restarts with the new model and switching back reuses the frames it already analyzed.

The analysis needs WebGPU to be fast (under a second per frame on a recent GPU). Without WebGPU it can still run on the CPU after you choose **Run on the CPU (very slow)**, at about 14 seconds per frame. The same choice appears when the browser has WebGPU but the chosen model cannot run on it; it concerns that model only.

**Fit** (Tighter … Looser) makes the cutout smaller or bigger: it sets the model's threshold and grows or shrinks the outline together. **Reduce flicker between frames** averages each frame with its neighbours. Both update the preview live while you drag. **Fix-ups**: **Keep** and **Remove** are tools on the preview; click a character to keep only the picked characters, or to remove them; each pick is followed through the whole clip, including the frames before it, and is listed with its time. **Brush** opens the Touch up mode (below) and **Reset** returns the adjustments, picks and brush strokes to the start. The active tool shows on its button, as the cursor over the preview and as a one-line hint on the preview. Frames that are not analyzed yet preview without the cutout; Export analyzes the exported frames that are still missing (with progress) before it encodes.

**Settings → AI models** lists each model by what it is for (General, Anime) with the network behind it, its size, license and state: Not downloaded, Downloading, Downloaded, Loaded (ready in this visit) or Update available (the cached file is an older version). **Download** fetches a model ahead of time (with progress and Cancel; **Download all** fetches every missing one), verified exactly like a download started by an analysis; **Delete** removes it from the browser's cache after a confirmation (not while an analysis uses it). After a download glinfs asks the browser for persistent storage so the models are not cleared when space runs low; the section shows whether it was granted and how much storage the site uses. Files left in that cache by earlier versions (such as the fp32 anime model of the first AI cutout release) are listed as **Old model file** and can be deleted the same way.

### Click to select
**Something else** cuts out whatever you click, with MobileSAM (45 MB, Apache-2.0, asked before it downloads like the other cards). After choosing it, click the thing you want to keep on the preview: the frame on screen shows its mask within about half a second, then it is followed through the selection in the background (**Tracking 12 of 36 frames**, with **Cancel**). **Whole** / **Part** chooses between the whole thing and the part under the click (a click on a face gives the person, or just the face). **Keep** and **Remove** add points that fix the selection on the frame on screen; each change tracks again, reusing the frames already seen. When the object is lost (its outline suddenly changes size a lot), tracking stops there and says **Lost track at 0:02**; **Go there**, click it again and tracking continues from that frame in both directions. Fit, Reduce flicker, the brush, Hold to compare, Show mask and the export work as with the other cards.

With **Prepare downloaded models when the editor opens** (on by default), opening the editor on a clip that uses an AI card prepares its model in the background when it is already downloaded, so **Analyze** starts at once; it never downloads anything by itself. A cached model is verified when it is downloaded, not on every load; a cached copy that fails to load is checked, and replaced by a fresh, verified download if it is damaged.

### Touch up
**Brush** in the **Background** tab fixes what a card got wrong: it opens the Touch up mode (the sidebar shows its tools until **Done** or Escape). Paint on the preview: **Erase** makes the painted pixels transparent, **Restore** brings back the original pixels there. **Size** sets the brush (the circle on the preview shows it). Each stroke applies to **This frame** or to the **Selection** (the frames between IN and OUT when you paint it; on a frame outside IN and OUT it applies to that frame only). A stroke paints only over the frame: dragging off the preview stops it at the edge, and coming back starts a new stroke. Press Escape while painting to cancel the stroke. **Undo last stroke**, **Clear on this frame** and **Clear all** take strokes away again. With an AI card, touch-ups also apply to frames that are not analyzed yet. Touch-ups apply only while background removal is on; turning removal off keeps them for later.

Press Escape to cancel a stroke, then to leave the brush, a pick tool or the eyedropper, then to deselect a caption, then to clear the crop. With a caption selected, Delete removes the caption, not the clip. Your edits stay with the clip when you go back to Capture, export, or switch clips in the queue.

### Open existing GIFs and images
Use **Open GIF or image** on the Capture screen, or drop a file on the preview, to edit an existing GIF, APNG, animated WebP, PNG, JPEG or WebP file with the same trim, crop, text and transparency tools. Frame timing and transparent pixels are kept when you export it again.

### Export
Press **Export** in the editor (or Ctrl/Cmd+E) to open the Export GIF dialog over it. Choose the encoder, quality, frame rate, loop count and output scale; the GIF plays at the editor's playback speed (0.25x to 4x). Set a **Target size** in MB (1 MB = 1,000,000 bytes, as upload limits count) to fit an upload limit: the export lowers the colors, then the frame rate, then the scale until the GIF fits. The finished GIF is shown with its size, dimensions and frame count, ready to download or open in a new tab.

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

The AI cutout runs one of four models in the browser with
[ONNX Runtime Web](https://onnxruntime.ai/) (MIT), inside a Web Worker:

- **General**: [DIS](https://github.com/xuebinqin/DIS) IS-Net general-use
  (`isnet-general-fp16.onnx`, Apache-2.0 code, 90 MB). Its training data
  (DIS5K) has non-commercial terms and upstream states no separate license for
  the weights; Settings says so on its row.
- **Portrait**: [MODNet](https://github.com/ZHKKKe/MODNet) portrait matting
  (`modnet-portrait-fp16.onnx`, Apache-2.0, 13 MB): people only, 512×512
  input, about 75 ms per frame on an M3 with WebGPU
- **Anime**: skytnt's [anime-segmentation](https://github.com/SkyTNT/anime-segmentation)
  model (`isnetis-fp16.onnx`, Apache-2.0, 88 MB; the default)
- **Click to select**: [MobileSAM](https://github.com/ChaoningZhang/MobileSAM)
  (Apache-2.0), two files shipped unchanged from the
  [Acly/MobileSAM](https://huggingface.co/Acly/MobileSAM) ONNX export:
  `mobilesam-image-encoder.onnx` (28 MB, once per frame, about 250 ms on an
  M3 with WebGPU) and `mobilesam-mask-decoder.onnx` (16.5 MB, per click or
  tracked frame, about 35 ms). The worker keeps the last 24 frames' image
  embeddings, so a new click or Whole / Part only reruns the decoder there.
  fp16 is not used: an fp16 encoder computes wrong embeddings on the WebGPU
  backend.

The first three are fp16 conversions of the upstream fp32 files (176, 179 and 26 MB):
half the download, and faster on WebGPU, with the same masks for practical
purposes (see below). They are described once in
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

Both remove every other file in `public/models/` (such as the fp32
`isnetis.onnx` of the first AI cutout release) and list what they removed,
since Vite copies that whole directory into the build.

#### Converting the models to fp16

`scripts/convert-models-fp16.py` makes the release assets from the upstream
files (pinned Hugging Face commits, checked by SHA-256). It keeps only the
output the worker reads (the general model's 11 side outputs go), for MODNet
zero-pads the input channels of the three Convs whose channel count is not a
multiple of 4 (35, 99, 35 → 36, 100, 36: ONNX Runtime Web 1.30's WebGPU backend
computes those Convs wrong, the padded graph computes the same values), and
converts the rest to float16 with `onnxconverter-common`, keeping the input and the
output float32, so the worker code is the same for fp32 and fp16. With the
versions pinned in `scripts/requirements-models.txt` (Python 3.11) the output
is byte-for-byte identical to the release assets:

```bash
python3.11 -m venv .venv-models
.venv-models/bin/pip install -r scripts/requirements-models.txt
.venv-models/bin/python scripts/convert-models-fp16.py --src /path/to/fp32 --out /path/to/fp16
```

`--src` holds `isnetis.onnx`, `isnet-general-use.onnx` and `modnet.onnx`
(downloaded there when missing; `--only portrait` converts one model). The script prints each file's size and SHA-256, which must
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

For Portrait (MODNet), fp16 on WebGPU against the upstream fp32 on WASM with
the same browser preprocessing (the unpatched fp32 is wrong on WebGPU), masks
thresholded at 0.5: 99.9–100% of pixels agree on a person, an anime character,
a cat and a synthetic scene, 99.0% on a coffee cup (not a portrait); about
75 ms per frame at 512×512 (M3).

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
(add `E2E_REAL_MODEL_ID=general` or `E2E_REAL_MODEL_ID=portrait` with a
live-action photo for the general or the portrait model; `E2E_REAL_IMAGE` takes several comma-separated paths).
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the licenses.

### Architecture

Vanilla JavaScript (ES modules) with no UI framework, built with Vite.
Capture, encoding, and scene detection run in Web Workers; all processing
stays client-side. Source is organized as `src/features/*` (capture, editor,
export, scene-detection) over a `src/shared/` core, with workers in
`src/workers/`.
