/**
 * AI cutout model registry
 * @module features/ai-cutout/model-registry
 *
 * Every segmentation model the app can run, with everything the worker,
 * the manager, Settings ("AI models"), scripts/fetch-models.mjs and
 * the Pages deploy workflow need to know about it. Plain data with no
 * browser or Vite imports, so the Node fetch script imports it directly
 * (the pins exist once; tests/unit/ai-cutout/model-config.test.js checks
 * that deploy.yml uses the same hashes and file names).
 *
 * The `id` is what edits store (`edits.background.ai.model`) and what masks
 * are keyed by; it never changes. The file behind an id can: replacing an
 * entry's file name, bytes and SHA-256 needs no code change elsewhere — the
 * Cache Storage key includes the SHA-256, so browsers download the new file
 * on next use.
 *
 * The app ships fp16 conversions of the upstream fp32 weights, half their
 * size (scripts/convert-models-fp16.py; the input and the output stay
 * float32, so the worker feeds and reads the same tensors). Each entry pins
 * the converted file (`fileName`, `bytes`, `sha256`) and the upstream file
 * it was converted from (`convertedFrom`: a Hugging Face commit, size and
 * SHA-256). The conversion is reproducible byte for byte.
 *
 * None of the models is committed: `npm run models:fetch` downloads each
 * converted file from the `models-v1` GitHub Release of this repository
 * (asset name = `fileName`) into public/models/<fileName>, and the browser
 * fetches it same-origin only when the user analyzes with that model.
 * The exceptions:
 * - a model with a `url` is downloaded by the browser from that URL (another
 *   origin, with CORS: see model-hosts.js) instead of the site, so it is not
 *   in the Pages artifact (GitHub Pages artifacts must stay under 1 GB);
 * - a `devOnly` model (none now; the BiRefNet ones if BIREFNET_HOST were
 *   null): not hosted anywhere, offered only by development builds, which
 *   serve whatever file was placed in public/models by hand (verified
 *   against the same pins).
 *
 * Models the user adds in Settings (custom-models.js) join the registry at
 * run time (setCustomModelEntries): getModelIds, isModelId and
 * getModelEntry know them; MODEL_REGISTRY stays the built-in models.
 *
 * One model is made of two files: "Click to select" (MobileSAM) runs an
 * image encoder once per frame and a small prompt decoder per click. Its
 * entry lists both in `files` (and `bytes` is their total); every other
 * entry is one file (`fileName`, `bytes`, `sha256`, `convertedFrom`).
 * getModelFiles() gives the files of either kind, so the loader, the
 * cache, Settings and the fetch script treat every model as a list of
 * files. Users only ever see the model.
 */

/**
 * How a frame becomes the model's input and how its output reads.
 * @typedef {Object} ModelPreprocess
 * @property {'letterbox' | 'stretch'} resize - letterbox: fit s×s keeping the
 *   aspect ratio, zero padding centred; stretch: resize to s×s ignoring it
 * @property {number} scale - Multiplier applied to 0..255 channel values
 * @property {readonly [number, number, number]} mean - Subtracted per channel (R, G, B) after scaling
 * @property {readonly [number, number, number]} std - Divides per channel after the mean
 * @property {'probability' | 'logits'} output - 'probability': the graph's
 *   output is already in [0, 1]; 'logits': the worker applies a sigmoid
 */

/**
 * One recurrent state of a video model: `output` of a frame is fed back as
 * `input` of the next one (zeros on a job's first frame).
 * @typedef {Object} ModelRecurrentPair
 * @property {string} input
 * @property {string} output
 */

/**
 * The upstream fp32 file a shipped model was converted from.
 * @typedef {Object} ModelUpstreamFile
 * @property {string} repo - Hugging Face repository (GitHub when `url` is set)
 * @property {string} revision - Pinned commit (never a branch)
 * @property {string} path - File path inside the repository (the asset
 *   name when `url` is set)
 * @property {string} [url] - Download URL of a file that is not on Hugging
 *   Face (a GitHub release asset; the release tag points at `revision`)
 * @property {number} bytes - Exact byte size
 * @property {string} sha256 - Lowercase hex SHA-256
 */

/**
 * One line of UI copy about a model's terms, ending in a link.
 * @typedef {Object} ModelLicenseNote
 * @property {string} text - The sentence before the link
 * @property {string} linkLabel
 * @property {string} url
 */

/**
 * @typedef {Object} ModelEntry
 * @property {string} id - Stable id (edits, mask keys, messages)
 * @property {string} label - What it is for, the name the UI leads with
 *   ("General", "Anime"; also in messages: "The Anime model was deleted")
 * @property {string} modelName - The network behind it, shown small next to
 *   the label where models are listed in full (Settings)
 * @property {string} shortModelName - `modelName` short enough for the
 *   editor's model switch
 * @property {string} description - What it is good at (UI copy)
 * @property {string} finds - What it cuts out, as the object of "Finds …
 *   in every frame" (UI copy)
 * @property {string} fileName - File name under public/models/, in the served
 *   URL and of the `models-v1` release asset
 * @property {number} bytes - Exact byte size of the shipped file
 * @property {string} sha256 - Lowercase hex SHA-256 of the shipped file
 * @property {ModelUpstreamFile} convertedFrom
 * @property {{ name: string, url: string }} license
 * @property {string} upstream - Project page of the network
 * @property {ModelLicenseNote} [licenseNote] - A caveat about the weights'
 *   terms, shown on the model's Settings row
 * @property {string} inputName - Image input: float32 [1, 3, inputSize, inputSize]
 * @property {string} outputName - Mask output: float32 [1, 1, inputSize, inputSize]
 * @property {number} inputSize
 * @property {ModelPreprocess} preprocess
 * @property {readonly ModelRecurrentPair[]} [recurrent] - A video model's
 *   state, carried from frame to frame by the worker
 * @property {string} [url] - Absolute URL the browser downloads the file
 *   from (another origin, fetched with CORS) instead of public/models; the
 *   file is then not in the `models-v1` release nor in the Pages artifact
 * @property {true} [custom] - A model the user added (custom-models.js)
 * @property {boolean} [localOnly] - Custom model from a local file: it
 *   exists only in Cache Storage and is never downloaded
 * @property {readonly string[]} [subjects] - Custom model: the subject
 *   cards that list it
 * @property {true} [missing] - A custom model id that no longer names a
 *   model (getModelEntry's placeholder; it cannot be loaded)
 * @property {true} [webgpuOnly] - Runs on WebGPU only: never on the CPU
 *   (WASM) fallback, and the "Run on the CPU" choice is not offered for
 *   it. Without WebGPU it is refused before anything is downloaded
 *   (WEBGPU_REQUIRED). The BiRefNet models: on WASM, whose memory is
 *   limited to 4 GB, their first frame fails with std::bad_alloc after the
 *   download (measured 2026-11-16, Chrome 157, general and lite)
 * @property {true} [devOnly] - Offered only in development builds
 *   (`npm run dev`): its file is not in the `models-v1` release, so
 *   `npm run models:fetch` and the Pages deploy leave it out, and it is
 *   placed in public/models/ by hand (see isModelOffered)
 */

/**
 * One file of a model.
 * @typedef {Object} ModelFile
 * @property {string} role - What the file is ('model'; 'encoder' / 'decoder' of a SAM model)
 * @property {string} fileName - File name under public/models/ and of the release asset
 * @property {number} bytes
 * @property {string} sha256
 * @property {ModelUpstreamFile} convertedFrom - The upstream file (for a file
 *   shipped unchanged, the same bytes and SHA-256)
 */

/**
 * A click-to-select model: an image encoder (once per frame) and a prompt
 * decoder (once per click or tracked frame), in the classic Segment
 * Anything ONNX layout.
 * @typedef {Object} SamModelEntry
 * @property {string} id
 * @property {'sam'} kind
 * @property {string} label
 * @property {string} modelName
 * @property {string} shortModelName
 * @property {string} description
 * @property {string} finds
 * @property {number} bytes - Total of `files`
 * @property {readonly ModelFile[]} files - encoder, then decoder
 * @property {{ name: string, url: string }} license
 * @property {string} upstream
 * @property {ModelLicenseNote} [licenseNote]
 * @property {number} inputSize - Long side the frame is resized to for the encoder
 * @property {number} maxPoints - Prompt points per decode (the UI's pick limit is lower)
 */

/**
 * GitHub Release that hosts the converted models; `npm run models:fetch`
 * downloads `<this>/<fileName>` (the browser never contacts GitHub).
 */
export const MODEL_RELEASE_URL =
  'https://github.com/dennougorilla/glinfs/releases/download/models-v1';

const APACHE_2 = Object.freeze({
  name: 'Apache-2.0',
  url: 'https://www.apache.org/licenses/LICENSE-2.0',
});

const MIT = Object.freeze({
  name: 'MIT',
  url: 'https://opensource.org/license/mit',
});

const GPL_3 = Object.freeze({
  name: 'GPL-3.0',
  url: 'https://www.gnu.org/licenses/gpl-3.0.html',
});

/**
 * skytnt's anime-segmentation IS-Net, converted to fp16 from `isnetis.onnx`
 * (byte-identical to rembg's `isnet-anime.onnx`). isnetis.onnx was last
 * changed in a0a563c4 (2022-09-14); the pinned 493cb608 (2026-08-17) only
 * adds the Apache-2.0 license metadata to the model card, so the bytes are
 * the same. fp16 vs fp32 through the app's worker on WebGPU: masks agree on
 * more than 99.99% of pixels after thresholding at 0.5.
 *
 * Preprocessing, verified against skytnt's own inference code:
 * - https://github.com/SkyTNT/anime-segmentation/blob/55d874013a2811cdf59c365059174c7823acf5b4/inference.py
 *   (`get_mask`, lines 14-35)
 * - https://huggingface.co/spaces/skytnt/anime-remove-background/blob/0ee865394df7f9e5500a67974839f213669fc206/app.py
 *   (`get_mask`, lines 8-21 — the Space that runs this exact isnetis.onnx)
 * Both do: RGB, `img / 255` (no mean/std), resize to fit s×s keeping the
 * aspect ratio with the short side truncated (`int(s * w / h)`), zero-pad
 * centred, HWC → CHW. The graph ends in a sigmoid (train.py `forward`
 * returns `.sigmoid()`), so the output is a [0, 1] probability.
 * @type {ModelEntry}
 */
const ANIME = {
  id: 'anime',
  label: 'Anime',
  modelName: 'ISNet (isnet-anime)',
  shortModelName: 'ISNet anime',
  description: 'Anime and illustrated characters',
  finds: 'the characters',
  fileName: 'isnetis-fp16.onnx',
  bytes: 88_070_957,
  sha256: 'f1aa383a62119572263a36ac9ebbd99bd14bc4052d0948662dc76b4b8c8d0bb0',
  convertedFrom: {
    repo: 'skytnt/anime-seg',
    revision: '493cb60893f47441b26ec4fb9a306bce9e342982',
    path: 'isnetis.onnx',
    bytes: 176_069_933,
    sha256: 'f15622d853e8260172812b657053460e20806f04b9e05147d49af7bed31a6e99',
  },
  license: APACHE_2,
  upstream: 'https://github.com/SkyTNT/anime-segmentation',
  inputName: 'img',
  outputName: 'mask',
  inputSize: 1024,
  preprocess: {
    resize: 'letterbox',
    scale: 1 / 255,
    mean: [0, 0, 0],
    std: [1, 1, 1],
    output: 'probability',
  },
};

/**
 * DIS IS-Net general-use (`isnet-general-use`, Apache-2.0: upstream
 * github.com/xuebinqin/DIS LICENSE.md; the Hugging Face card says
 * apache-2.0), converted to fp16 from the published ONNX export on Hugging
 * Face (byte-identical to rembg's isnet-general-use.onnx release asset).
 * That fp32 file has the network's 12 outputs (main + side outputs); the
 * conversion keeps only `output_image`, the one the worker reads. fp16 vs
 * fp32 through the app's worker on WebGPU: masks agree on more than 99.5%
 * of pixels after thresholding at 0.5 (the rest are soft edge pixels).
 *
 * Preprocessing, verified against the upstream inference script
 * https://github.com/xuebinqin/DIS/blob/b6764e20381f6f42a70f83fa3324181529ed1403/IS-Net/Inference.py
 * (line 23 `input_size=[1024,1024]`, lines 40-51): `F.upsample(...,
 * input_size, mode="bilinear")` — a plain stretch to 1024×1024, no
 * letterbox —, back to uint8, `/ 255`, `normalize(mean=[0.5]*3,
 * std=[1.0]*3)`, NCHW. `output_image` is the sigmoid of the main side
 * output, already in [0, 1]. Upstream then min-max normalizes each image;
 * that is deliberately NOT done here: per-frame normalization would make
 * the same pixel's value jump between frames (flicker) and would turn an
 * empty frame's noise into foreground.
 * @type {ModelEntry}
 */
const GENERAL = {
  id: 'general',
  label: 'General',
  modelName: 'ISNet (general-use)',
  shortModelName: 'ISNet',
  description: 'People, pets and objects in live-action video',
  finds: 'the people, pets and objects',
  fileName: 'isnet-general-fp16.onnx',
  bytes: 90_448_072,
  sha256: '437b3207d043c5206b11c9f1681a0b1d647aeb560174f07420ed651989f3b38b',
  convertedFrom: {
    repo: 'BritishWerewolf/IS-Net',
    revision: '9783722d9f964c0286a411e7e8e6fede947d5a53',
    path: 'onnx/model.onnx',
    bytes: 178_648_008,
    sha256: '60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a',
  },
  license: APACHE_2,
  upstream: 'https://github.com/xuebinqin/DIS',
  // The DIS code is Apache-2.0, but the network was trained on DIS5K, whose
  // terms of use are non-commercial, and upstream states no separate
  // license for the weights. Kept for now; Settings says so.
  licenseNote: {
    text: 'Its training data (DIS5K) has non-commercial terms, and upstream states no license for the weights.',
    linkLabel: 'DIS repository',
    url: 'https://github.com/xuebinqin/DIS',
  },
  inputName: 'input_image',
  outputName: 'output_image',
  inputSize: 1024,
  preprocess: {
    resize: 'stretch',
    scale: 1 / 255,
    mean: [0.5, 0.5, 0.5],
    std: [1, 1, 1],
    output: 'probability',
  },
};

/**
 * MODNet (ZHKKKe/MODNet, code and pretrained weights Apache-2.0), a small
 * portrait matting network, converted to fp16 from the ONNX export on
 * Hugging Face (Xenova/modnet, `onnx/model.onnx`, opset 11). onnxruntime-web
 * 1.30's WebGPU backend computes Convs whose input channel count is not a
 * multiple of 4 wrong (MODNet has three: 35, 99 and 35 channels), which
 * wrecks the mask; the conversion zero-pads those inputs to 36 / 100 / 36
 * channels (scripts/convert-models-fp16.py `pad_conv_channels`), which
 * computes exactly the same values. fp16 on WebGPU vs the upstream fp32 on
 * WASM, same preprocessing: masks agree on 99–100% of pixels after
 * thresholding at 0.5. About 75 ms per frame at 512×512 on an M3.
 *
 * Trained on people (portrait matting): reliable for people, not for pets
 * or objects.
 *
 * Preprocessing, from the export's preprocessor_config.json (Xenova/modnet
 * at the pinned revision) and the upstream demo
 * https://github.com/ZHKKKe/MODNet/blob/28165a451e4610c9d77cfdf925a94610bb2810fb/onnx/inference_onnx.py
 * (`(im - 127.5) / 127.5`, i.e. mean 0.5 / std 0.5 after `/ 255`). Upstream
 * resizes the short side to 512 keeping the aspect ratio (multiples of 32);
 * a plain 512×512 stretch gave equivalent masks and keeps the input square
 * like the other models. The graph ends in a sigmoid: `output` is already
 * a [0, 1] probability.
 * @type {ModelEntry}
 */
const PORTRAIT = {
  id: 'portrait',
  label: 'Portrait',
  modelName: 'MODNet',
  shortModelName: 'MODNet',
  description: 'People in live-action video (fast, small)',
  finds: 'the people',
  fileName: 'modnet-portrait-fp16.onnx',
  bytes: 12_987_022,
  sha256: 'e59298740c266e5a095b5b7f7c7d69c824e231799dd475e6c6d1e8fc83560f1c',
  convertedFrom: {
    repo: 'Xenova/modnet',
    revision: 'fa2fa546052fba4c08921230a26cc69a333fca12',
    path: 'onnx/model.onnx',
    bytes: 25_888_640,
    sha256: '07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9',
  },
  license: APACHE_2,
  upstream: 'https://github.com/ZHKKKe/MODNet',
  inputName: 'input',
  outputName: 'output',
  inputSize: 512,
  preprocess: {
    resize: 'stretch',
    scale: 1 / 255,
    mean: [0.5, 0.5, 0.5],
    std: [0.5, 0.5, 0.5],
    output: 'probability',
  },
};

/**
 * MobileSAM (ChaoningZhang/MobileSAM, code and weights Apache-2.0): Segment
 * Anything with a small image encoder, for "Click to select". The files are
 * the ONNX export on Hugging Face (Acly/MobileSAM at the pinned commit,
 * whose card says MIT; the weights are MobileSAM's), shipped unchanged:
 * - `mobile_sam_image_encoder.onnx`: input `input_image` float32
 *   [H, W, 3], RGB 0..255 of the frame resized so its long side is 1024
 *   (normalization and padding to 1024×1024 are in the graph) → output
 *   `image_embeddings` [1, 256, 64, 64]. About 250 ms per frame on an M3
 *   (WebGPU).
 * - `sam_mask_decoder_multi.onnx`: the original SAM prompt encoder and mask
 *   decoder (`point_coords` [1, N, 2] in the resized frame's pixels,
 *   `point_labels` [1, N] (1 keep, 0 remove, 2 / 3 box corners, -1
 *   padding), `mask_input` [1, 1, 256, 256] + `has_mask_input` [1],
 *   `orig_im_size` [2] = [h, w] of the wanted mask) → `masks` [1, 4, h, w]
 *   logits (> 0 is inside), `iou_predictions` [1, 4], `low_res_masks`
 *   [1, 4, 256, 256]. Mask 0 is SAM's single-mask output, 1–3 the three
 *   multimask outputs (typically a part, a bigger part, the whole). About
 *   35 ms per prompt.
 * fp16 is not used: an fp16 conversion of the encoder computes wrong
 * embeddings on onnxruntime-web 1.30's WebGPU backend (relative error ≈3,
 * masks unusable), and the decoder does not convert.
 * @type {SamModelEntry}
 */
const CLICK = {
  id: 'click',
  kind: 'sam',
  label: 'Click to select',
  modelName: 'MobileSAM',
  shortModelName: 'MobileSAM',
  description: 'Anything you click, followed through the clip',
  finds: 'what you click',
  bytes: 28_157_093 + 16_496_559,
  files: [
    {
      role: 'encoder',
      fileName: 'mobilesam-image-encoder.onnx',
      bytes: 28_157_093,
      sha256: '580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749',
      convertedFrom: {
        repo: 'Acly/MobileSAM',
        revision: '0d3b403339b4674a82493d5e97964dd78089ddc8',
        path: 'mobile_sam_image_encoder.onnx',
        bytes: 28_157_093,
        sha256: '580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749',
      },
    },
    {
      role: 'decoder',
      fileName: 'mobilesam-mask-decoder.onnx',
      bytes: 16_496_559,
      sha256: '8976b90a87ba50a6a72217a5ff994f7d25ce16f2229fcc1ed259e1294c622ffe',
      convertedFrom: {
        repo: 'Acly/MobileSAM',
        revision: '0d3b403339b4674a82493d5e97964dd78089ddc8',
        path: 'sam_mask_decoder_multi.onnx',
        bytes: 16_496_559,
        sha256: '8976b90a87ba50a6a72217a5ff994f7d25ce16f2229fcc1ed259e1294c622ffe',
      },
    },
  ],
  license: APACHE_2,
  upstream: 'https://github.com/ChaoningZhang/MobileSAM',
  inputSize: 1024,
  maxPoints: 32,
};

/**
 * BEN2 base (PramaLLC/BEN2, MIT): the Background Erase Network with its
 * confidence-guided refiner, strongest on hair and fine detail. Upstream
 * publishes the ONNX file already in mixed precision (float16 weights, a
 * float16 output named "17728"), so nothing is converted to fp16: the
 * conversion only appends a Cast to float32 and names the output `mask`.
 *
 * Preprocessing: stretch to 1024×1024, `/ 255`, then ImageNet mean/std
 * (0.485, 0.456, 0.406 / 0.229, 0.224, 0.225), as upstream's PyTorch
 * inference (BEN2.py, the code the network was trained with) normalizes.
 * Upstream's onnx_run.py feeds `/ 255` without mean/std, and the graph has
 * no normalization inside; the app used that until the browser bake-off
 * of 2026-11 measured both in Chrome on WebGPU: ImageNet mean/std is
 * better on every measure (ToonOut test split with ground truth, 126
 * images: IoU 0.9725 vs 0.9663, edge-band error 0.065 vs 0.078; on a
 * two-character anime clip the characters vanished on 0 of 63 frames
 * instead of 45; less flicker on unchanged pixels). The graph ends in a
 * sigmoid: the output is a [0, 1] probability. Upstream then min-max
 * normalizes each image; not done here, for the reason given on the
 * general model.
 *
 * Three fixes make it run on WebGPU (scripts/convert-models-fp16.py): its
 * 68 Pow(x, 2) take a float16 base and a float32 exponent, for which
 * onnxruntime-web has no kernel (rewritten as Mul(x, x)); three
 * LayerNorms run in float64, which WebGPU lacks (computed in float32,
 * from float16 inputs); and the output is cast to float32. Against the
 * upstream file on the CPU: masks agree on more than 99.99% of pixels at
 * 0.5. On WebGPU about 430 ms per frame on an RTX 3080 Ti (a 2.5 s
 * warm-up).
 *
 * Trained on DIS5K and Prama's own data; the weights are MIT.
 * @type {ModelEntry}
 */
const BEN2 = {
  id: 'ben2',
  label: 'Hair & detail',
  modelName: 'BEN2 (base)',
  shortModelName: 'BEN2',
  description: 'People, pets and objects, best on hair and fine detail',
  finds: 'the people, pets and objects',
  fileName: 'ben2-base-fp16.onnx',
  bytes: 222_923_759,
  sha256: 'b58fc673c81561a7cb58a5428c50d8ed7db08f70656c141256bfb356ba6e6c82',
  convertedFrom: {
    repo: 'PramaLLC/BEN2',
    revision: 'e48a20765fb421d19dcdb0bf3cc61e802ca5ec8f',
    path: 'BEN2_Base.onnx',
    bytes: 222_932_053,
    sha256: '22cea62108ff53b7ccc20f7a008bf30494228d84b1687f29ecbe76936a998101',
  },
  license: MIT,
  upstream: 'https://github.com/PramaLLC/BEN2',
  inputName: 'input.1',
  outputName: 'mask',
  inputSize: 1024,
  preprocess: {
    resize: 'stretch',
    scale: 1 / 255,
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
    output: 'probability',
  },
};

/**
 * Robust Video Matting, ResNet-50 (PeterL1n/RobustVideoMatting, GPL-3.0,
 * like this app), converted to fp16 from the fp32 ONNX file of its v1.0.0
 * release. A recurrent network: four ConvGRU states carry what it saw in
 * earlier frames, which keeps the matte steady from frame to frame (the
 * worker feeds each frame's `r1o`…`r4o` back as the next frame's
 * `r1i`…`r4i`, see `recurrent`). The conversion keeps `pha` and the
 * states (drops the foreground colour `fgr`) and makes `downsample_ratio`
 * the constant 0.5: the 1024×1024 input is analyzed at 512 and the
 * refiner brings the matte back to 1024. Like MODNet's, four decoder
 * Convs read a channel count that is not a multiple of 4 (771, 387, 131,
 * 35), which onnxruntime-web's WebGPU backend computes wrong: the
 * conversion zero-pads them. Two more fixes keep the graph valid after the
 * fp16 conversion: the state outputs, which the graph also reads, sit
 * behind an Identity, and the states' symbolic dimensions get distinct
 * names (the export calls all four "channels × height × width", which
 * made ONNX Runtime share one state's buffer with another). fp16 on the
 * CPU vs the fp32 export over three frames: masks agree on more than
 * 99.98% of pixels at 0.5; on WebGPU about 80 ms per frame on an RTX
 * 3080 Ti.
 *
 * Trained on people only. Preprocessing, from upstream's
 * documentation/inference.md: RGB in [0, 1] (`/ 255`, no mean/std), any
 * size (here a 1024×1024 stretch, like the other models). `pha` is
 * clipped to [0, 1].
 * @type {ModelEntry}
 */
const VIDEO_PERSON = {
  id: 'video-person',
  label: 'Video person',
  modelName: 'Robust Video Matting (ResNet-50)',
  shortModelName: 'RVM',
  description: 'People in live-action video, steady from frame to frame',
  finds: 'the people',
  fileName: 'rvm-resnet50-fp16.onnx',
  bytes: 53_779_519,
  sha256: 'c1d2ce94dc34029527bd6fff914a04d9eeddcbf8dd0be4e03e5f20143be3a409',
  convertedFrom: {
    repo: 'PeterL1n/RobustVideoMatting',
    revision: '17d1774b032fd503bfe53c57d295db719f9e3da1',
    path: 'rvm_resnet50_fp32.onnx',
    url: 'https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_resnet50_fp32.onnx',
    bytes: 107_479_165,
    sha256: '25db300fcb6ee27f941a1b52c97856e8d1f13c7f35817f81a612f89af0e8a85c',
  },
  license: GPL_3,
  upstream: 'https://github.com/PeterL1n/RobustVideoMatting',
  inputName: 'src',
  outputName: 'pha',
  inputSize: 1024,
  preprocess: {
    resize: 'stretch',
    scale: 1 / 255,
    mean: [0, 0, 0],
    std: [1, 1, 1],
    output: 'probability',
  },
  recurrent: [
    { input: 'r1i', output: 'r1o' },
    { input: 'r2i', output: 'r2o' },
    { input: 'r3i', output: 'r3o' },
    { input: 'r4i', output: 'r4o' },
  ],
};

/**
 * What the three BiRefNet models share. BiRefNet (ZhengPeng7/BiRefNet,
 * code and weights MIT) publishes PyTorch checkpoints, and no published
 * ONNX file of it runs in the browser (onnx-community's fail with "Too many
 * storage buffers" on WebGPU, and every fp16 file checked returns NaN on
 * many frames), so scripts/export-birefnet-onnx.py exports them: the final
 * prediction as logits, opset 17, deform_conv2d decomposed, fp16 with a
 * float32 input and output, then four rewrites that compute the same values
 * but run on onnxruntime-web 1.30's WebGPU backend (wide Split/Concat
 * split, Sum as Add, the deformable conv's index maths in float32, and
 * GlobalAveragePool/ReduceMean in float32: in float16 WebGPU's pooling
 * overflows and the mask turns to NaN).
 *
 * Preprocessing, from upstream's inference code (the model card's
 * `transforms.Normalize`): stretch to 1024×1024, `/ 255`, ImageNet mean/std.
 * The output is logits (the worker applies the sigmoid).
 *
 * Measured in the browser bake-off of 2026-11 (Chrome 157, onnxruntime-web
 * 1.30.0, WebGPU, RTX 3080 Ti; 10 anime GIF clips, 422 frames, and the
 * ToonOut test split, 126 images with ground truth): every frame non-empty,
 * the steadiest masks of all models on unchanged pixels, and about 485 ms
 * per frame with a peak of about 7.7 GB GPU memory (lite: 260 ms, 5.8 GB).
 * Too heavy for weak GPUs, and untested on Apple and Intel GPUs.
 *
 * Not in the `models-v1` release: the two large ones cannot ship with the
 * Pages site next to the other models (GitHub Pages artifacts must stay
 * under 1 GB). They are downloaded from BIREFNET_HOST (Hugging Face).
 */
const BIREFNET_COMMON = /** @type {const} */ ({
  license: MIT,
  inputName: 'input_image',
  outputName: 'output_image',
  inputSize: 1024,
  // On the CPU (WASM, 4 GB of memory) the first frame runs out of memory
  webgpuOnly: true,
});

/**
 * Where the BiRefNet files are downloaded from: a base URL that each
 * entry's `fileName` is appended to, here the Hugging Face repository
 * dennougorilla/glinfs-models at a pinned commit (`resolve/<commit>`; its
 * files have the pinned sizes and SHA-256, and it sends CORS headers, see
 * model-hosts.js). null would make the BiRefNet models development-only
 * again (not hosted: development builds serve them from public/models).
 * @type {string | null}
 */
export const BIREFNET_HOST =
  'https://huggingface.co/dennougorilla/glinfs-models/resolve/d4b06cb3e2d551d954cd9fd748abc14a79f1618c';

/**
 * Where a hosted file comes from: `{ url }` under `host`, or `{ devOnly }`
 * when `host` is null (not hosted yet)
 * @param {string | null} host - Base URL
 * @param {string} fileName
 * @returns {{ url: string } | { devOnly: true }}
 */
export function hostedFile(host, fileName) {
  if (!host) return { devOnly: true };
  return { url: `${host.replace(/\/+$/, '')}/${encodeURIComponent(fileName)}` };
}

/** @returns {ModelPreprocess} */
function birefnetPreprocess() {
  return {
    resize: 'stretch',
    scale: 1 / 255,
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
    output: 'logits',
  };
}

/**
 * BiRefNet general (Swin-L backbone), from model.safetensors at the pinned
 * commit. In the bake-off the most reliable model on busy anime
 * backgrounds: no frame lost the character or kept the background (ISNet
 * anime and BEN2 did both). Ground truth: IoU 0.970.
 * @type {ModelEntry}
 */
const BIREFNET_GENERAL = {
  id: 'birefnet-general',
  label: 'Busy backgrounds',
  modelName: 'BiRefNet (general)',
  shortModelName: 'BiRefNet',
  description: 'Characters, people and objects, cleanest on busy backgrounds (needs a strong GPU)',
  finds: 'the characters, people and objects',
  fileName: 'birefnet-general-fp16.onnx',
  ...hostedFile(BIREFNET_HOST, 'birefnet-general-fp16.onnx'),
  bytes: 519_348_204,
  sha256: '809c204052cb841141fb261e4beefd313dd8035587246940bd73aa3c6d20207e',
  convertedFrom: {
    repo: 'ZhengPeng7/BiRefNet',
    revision: 'e2bf8e4460fc8fa32bba5ea4d94b3233d367b0e4',
    path: 'model.safetensors',
    bytes: 444_473_596,
    sha256: '9ab37426bf4de0567af6b5d21b16151357149139362e6e8992021b8ce356a154',
  },
  upstream: 'https://github.com/ZhengPeng7/BiRefNet',
  ...BIREFNET_COMMON,
  preprocess: birefnetPreprocess(),
};

/**
 * BiRefNet lite (Swin-T backbone), from model.safetensors at the pinned
 * commit: close to general (ground truth IoU 0.970) at about half the time
 * and a quarter of the download, but in the bake-off it kept part of the
 * background on one clip.
 * @type {ModelEntry}
 */
const BIREFNET_LITE = {
  id: 'birefnet-lite',
  label: 'Busy backgrounds, faster',
  modelName: 'BiRefNet lite (Swin-T)',
  shortModelName: 'BiRefNet lite',
  description: 'Like Busy backgrounds, about twice as fast and a smaller download',
  finds: 'the characters, people and objects',
  fileName: 'birefnet-lite-fp16.onnx',
  ...hostedFile(BIREFNET_HOST, 'birefnet-lite-fp16.onnx'),
  bytes: 122_466_609,
  sha256: 'dd67588b7b3fe3d4b311a5f30d4298f3a3b5e2bd513c0c72c0e41c29fcb8e05e',
  convertedFrom: {
    repo: 'ZhengPeng7/BiRefNet_lite',
    revision: 'aa62cd87eafb9cc43056d08ef3615a14628b831d',
    path: 'model.safetensors',
    bytes: 177_634_392,
    sha256: '4417d89795250e698c3cb0ae8df15743810065f646f48a694fdfa7ca052d0815',
  },
  upstream: 'https://github.com/ZhengPeng7/BiRefNet',
  ...BIREFNET_COMMON,
  preprocess: birefnetPreprocess(),
};

/**
 * BiRefNet ToonOut (joelseytre/toonout: BiRefNet general fine-tuned on
 * anime characters; weights MIT, dataset CC BY 4.0), from
 * birefnet_finetuned_toonout.pth at the pinned commit. The most accurate
 * model where ground truth exists (ToonOut test split: IoU 0.993, the best
 * hair and edges), but on busy real anime backgrounds it kept background
 * objects touching the character on 5 of the 10 bake-off clips.
 * @type {ModelEntry}
 */
const BIREFNET_TOONOUT = {
  id: 'birefnet-toonout',
  label: 'Anime hair',
  modelName: 'BiRefNet ToonOut',
  shortModelName: 'ToonOut',
  description: 'Anime characters, best on hair and edges; may keep parts of a busy background',
  finds: 'the characters',
  fileName: 'birefnet-toonout-fp16.onnx',
  ...hostedFile(BIREFNET_HOST, 'birefnet-toonout-fp16.onnx'),
  bytes: 519_348_204,
  sha256: 'dd9c9fbc1a831b34aa8e2b7f9e28d42d44ac2debc37eedea85df33d1abbf038e',
  convertedFrom: {
    repo: 'joelseytre/toonout',
    revision: 'cbf720eca394edcde66b861a8a8c20fbabe9c748',
    path: 'birefnet_finetuned_toonout.pth',
    bytes: 885_046_394,
    sha256: '8c7f8a0bc24400f4caade76622f75ff22ca1e93e169add9d2b70093e2487fbe5',
  },
  upstream: 'https://huggingface.co/joelseytre/toonout',
  ...BIREFNET_COMMON,
  preprocess: birefnetPreprocess(),
};

/**
 * Deep-freeze a registry entry (it is shared by every module).
 * @template {ModelEntry | SamModelEntry} T
 * @param {T} entry
 * @returns {Readonly<T>}
 */
function freezeEntry(entry) {
  if (entry.licenseNote) Object.freeze(entry.licenseNote);
  if ('files' in entry) {
    for (const file of entry.files) {
      Object.freeze(file.convertedFrom);
      Object.freeze(file);
    }
    Object.freeze(entry.files);
  } else {
    Object.freeze(entry.convertedFrom);
    Object.freeze(entry.preprocess.mean);
    Object.freeze(entry.preprocess.std);
    Object.freeze(entry.preprocess);
    if (entry.recurrent) {
      for (const pair of entry.recurrent) Object.freeze(pair);
      Object.freeze(entry.recurrent);
    }
  }
  return Object.freeze(entry);
}

/**
 * Every model, in the order the UI lists them (the editor's switch left to
 * right, Settings top to bottom). A new model needs only an entry here (and
 * its file in the `models-v1` release).
 */
export const MODEL_REGISTRY = Object.freeze(
  /** @type {readonly Readonly<ModelEntry | SamModelEntry>[]} */ ([
    freezeEntry(GENERAL),
    freezeEntry(PORTRAIT),
    freezeEntry(ANIME),
    freezeEntry(CLICK),
    freezeEntry(BEN2),
    freezeEntry(VIDEO_PERSON),
    freezeEntry(BIREFNET_GENERAL),
    freezeEntry(BIREFNET_LITE),
    freezeEntry(BIREFNET_TOONOUT),
  ]),
);

/**
 * Whether a model is offered in this build: every model in a development
 * build, else only the models of the `models-v1` release (not `devOnly`)
 * @param {Readonly<ModelEntry | SamModelEntry>} entry
 * @param {boolean} dev - A development build (`import.meta.env.DEV`)
 * @returns {boolean}
 */
export function isEntryOffered(entry, dev) {
  return dev || !('devOnly' in entry && entry.devOnly);
}

/**
 * The models of the `models-v1` release, which `npm run models:fetch`
 * downloads and the Pages deploy ships (every model but the `devOnly` ones
 * and the ones downloaded from their own `url`)
 * @returns {readonly Readonly<ModelEntry | SamModelEntry>[]}
 */
export function getReleaseModels() {
  return MODEL_REGISTRY.filter((entry) => isEntryOffered(entry, false) && !('url' in entry));
}

/**
 * Model of edits that do not name one (everything saved before the general
 * model). Only for reading old edits: a new choice follows
 * model-preference.js (remembered > downloaded > FIRST_RUN_MODEL_ID).
 */
export const DEFAULT_MODEL_ID = ANIME.id;

/**
 * Model a subject card starts with when the user never chose one of its
 * models and none of them is downloaded (#187), if the card can use it
 */
export const FIRST_RUN_MODEL_ID = BEN2.id;

/** Cache Storage bucket that keeps verified models between visits */
export const MODEL_CACHE_NAME = 'glinfs-models-v1';

/**
 * Models the user added (custom-models.js), in the order Settings lists them
 * @type {readonly Readonly<ModelEntry>[]}
 */
let customEntries = Object.freeze([]);

/** @type {Set<() => void>} */
const customListeners = new Set();

/**
 * Replace the user-added models (custom-model-store.js calls this when
 * the stored definitions are read or change). Listeners run afterwards.
 * @param {readonly ModelEntry[]} entries - Each with `custom: true`
 */
export function setCustomModelEntries(entries) {
  const builtIn = new Set(MODEL_REGISTRY.map((entry) => entry.id));
  customEntries = Object.freeze(
    entries.filter((entry) => !builtIn.has(entry.id)).map((entry) => Object.freeze({ ...entry })),
  );
  for (const listener of [...customListeners]) listener();
}

/** @returns {readonly Readonly<ModelEntry>[]} The user-added models */
export function getCustomModelEntries() {
  return customEntries;
}

/**
 * Run `listener` whenever the user-added models change
 * @param {() => void} listener
 * @returns {() => void} Unsubscribe
 */
export function onCustomModelsChange(listener) {
  customListeners.add(listener);
  return () => {
    customListeners.delete(listener);
  };
}

/** @returns {string[]} Every model id: the built-in ones, then the user-added ones */
export function getModelIds() {
  return [...MODEL_REGISTRY, ...customEntries].map((entry) => entry.id);
}

/**
 * @param {string} id
 * @returns {Readonly<ModelEntry | SamModelEntry> | undefined}
 */
function findEntry(id) {
  return MODEL_REGISTRY.find((e) => e.id === id) ?? customEntries.find((e) => e.id === id);
}

/**
 * @param {unknown} id
 * @returns {boolean} `id` names a registered model (built in or user-added)
 */
export function isModelId(id) {
  return typeof id === 'string' && findEntry(id) !== undefined;
}

/** Ids of user-added models (custom-models.js isCustomModelId) */
const CUSTOM_ID = /^custom-[0-9a-f]{16}-[0-9a-f]{8}$/;

/**
 * Whether an id has the form of a user-added model's id (present or not)
 * @param {unknown} id
 * @returns {boolean}
 */
export function isCustomEntryId(id) {
  return typeof id === 'string' && CUSTOM_ID.test(id);
}

/**
 * The entry a custom model id gets once the model is gone (deleted, or
 * never added in this browser): labels still render, loading it fails with
 * MODEL_UNAVAILABLE (model-config.js getModelSpec)
 * @param {string} id
 * @returns {Readonly<ModelEntry>}
 */
function missingCustomEntry(id) {
  return Object.freeze({
    id,
    custom: true,
    missing: true,
    label: 'Missing custom model',
    modelName: 'Not in this browser',
    shortModelName: 'Missing',
    description: 'A model that was added in Settings and is no longer there',
    finds: 'the subject',
    fileName: `custom/${id}.onnx`,
    localOnly: true,
    bytes: 0,
    sha256: '',
    convertedFrom: { repo: '', revision: '', path: '', bytes: 0, sha256: '' },
    license: { name: 'Added by you', url: '' },
    upstream: '',
    inputName: '',
    outputName: '',
    inputSize: 1024,
    preprocess: {
      resize: 'stretch',
      scale: 1 / 255,
      mean: [0, 0, 0],
      std: [1, 1, 1],
      output: 'probability',
    },
  });
}

/**
 * The registry entry of a model. A custom model id that names no model
 * (anymore) gets a `missing` placeholder, so the clip that uses it still
 * renders and its analysis fails with a clear message.
 * @param {string} id
 * @returns {Readonly<ModelEntry | SamModelEntry> & Record<string, any>}
 * @throws {RangeError} for an unknown id
 */
export function getModelEntry(id) {
  const entry = findEntry(id);
  if (entry) return entry;
  if (isCustomEntryId(id)) return missingCustomEntry(id);
  throw new RangeError(`Unknown AI cutout model "${id}"`);
}

/**
 * Whether an entry is a click-to-select (SAM) model
 * @param {unknown} entry
 * @returns {entry is SamModelEntry}
 */
export function isSamEntry(entry) {
  return /** @type {{ kind?: string } | null} */ (entry)?.kind === 'sam';
}

/**
 * Whether a model id names a click-to-select (SAM) model
 * @param {unknown} id
 * @returns {boolean}
 */
export function isSamModelId(id) {
  return isSamEntry(MODEL_REGISTRY.find((entry) => entry.id === id));
}

/**
 * The files of a model: its `files`, or the one file of a single-file entry
 * @param {Readonly<ModelEntry | SamModelEntry>} entry
 * @returns {readonly ModelFile[]}
 */
export function getModelFiles(entry) {
  if ('files' in entry) return entry.files;
  return [
    {
      role: 'model',
      fileName: entry.fileName,
      bytes: entry.bytes,
      sha256: entry.sha256,
      convertedFrom: entry.convertedFrom,
    },
  ];
}

/**
 * Download URL of a shipped model file: its asset in the `models-v1` GitHub
 * Release (used by the fetch script; the browser loads it same-origin).
 * @param {{ fileName: string }} file - A single-file entry or a ModelFile
 * @returns {string}
 */
export function getModelDownloadUrl(file) {
  return `${MODEL_RELEASE_URL}/${file.fileName}`;
}

/**
 * Pinned URL of the upstream file a model file comes from: its Hugging
 * Face commit, or `convertedFrom.url` (scripts/convert-models-fp16.py
 * downloads the ones it converts).
 * @param {{ convertedFrom: ModelUpstreamFile }} entry - A single-file entry or a ModelFile
 * @returns {string}
 */
export function getUpstreamModelUrl(entry) {
  const { repo, revision, path, url } = entry.convertedFrom;
  if (url) return url;
  return `https://huggingface.co/${repo}/resolve/${revision}/${path}`;
}

/**
 * Decimal megabytes (10^6 bytes), the unit of "88 MB" in the README, the
 * credits, the editor and Settings: whole megabytes, or `decimals` places
 * where an amount must visibly move (download progress: "12.3 MB of 88.1 MB")
 * @param {number} bytes
 * @param {number} [decimals]
 * @returns {string}
 */
export function formatModelSize(bytes, decimals = 0) {
  return `${(bytes / 1_000_000).toFixed(decimals)} MB`;
}
