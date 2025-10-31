# アーキテクチャ設計 - Vite + Svelte

**作成日**: 2025-10-31  
**フレームワーク**: Vite + Svelte (SvelteKitなし)  
**設計原則**: Feature-Sliced Design + Functional Core, Imperative Shell  
**参照**: spec.md（機能要件）, plan.md（技術選定）

---

## 目次

1. [設計哲学](#1-設計哲学)
2. [プロジェクト構造](#2-プロジェクト構造)
3. [レイヤー設計](#3-レイヤー設計)
4. [機能別詳細設計](#4-機能別詳細設計)
5. [状態管理](#5-状態管理)
6. [データフロー](#6-データフロー)
7. [型定義](#7-型定義)
8. [命名規則](#8-命名規則)

---

## 1. 設計哲学

### 1.1 なぜDDDを採用しないのか

**DDD（Domain-Driven Design）の問題点**（このプロジェクトにおいて）:
- ✗ 過剰な抽象化（Entity, Value Object, Repository, Use Case...）
- ✗ ボイラープレートコードの増加
- ✗ 学習コストが高い
- ✗ 小規模プロジェクトでは複雑性がメリットを上回る

### 1.2 採用する原則

#### **Feature-Sliced Design (FSD)**
```
特徴単位でコードを分割
├── capture/    # 画面キャプチャ機能
├── editor/     # 編集機能
└── export/     # エクスポート機能

メリット:
✓ 機能の責務が明確
✓ 独立して開発・テスト可能
✓ スケールしやすい
✓ 理解しやすい
```

#### **Functional Core, Imperative Shell**
```
Functional Core（純粋関数）:
- ビジネスロジック
- データ変換
- 計算処理
→ 副作用なし、テスト容易

Imperative Shell（副作用）:
- DOM操作
- API呼び出し
- Canvas描画
- Worker通信
→ Coreを呼び出すだけ
```

#### **Composition over Inheritance**
```
クラス継承を避け、関数合成を使用
→ 柔軟性と再利用性が向上
```

#### **Explicit is better than Implicit**
```
暗黙的な動作を避け、明示的に記述
→ コードが自己文書化される
```

---

## 2. プロジェクト構造

```
fglips-svelte/
├── public/
│   ├── index.html                    # エントリーHTML
│   └── favicon.ico
│
├── src/
│   ├── main.js                       # アプリケーションエントリー
│   ├── App.svelte                    # ルートコンポーネント
│   │
│   ├── features/                     # 機能別モジュール
│   │   ├── capture/
│   │   │   ├── components/           # UI コンポーネント
│   │   │   │   ├── CaptureScreen.svelte
│   │   │   │   ├── VideoStream.svelte
│   │   │   │   ├── ControlPanel.svelte
│   │   │   │   └── BufferStats.svelte
│   │   │   ├── store.js              # 状態管理（Svelte Store）
│   │   │   ├── core.js               # ビジネスロジック（純粋関数）
│   │   │   ├── api.js                # 外部I/O（Screen Capture API）
│   │   │   └── types.js              # 型定義（JSDoc or .d.ts）
│   │   │
│   │   ├── editor/
│   │   │   ├── components/
│   │   │   │   ├── EditorScreen.svelte
│   │   │   │   ├── EditorCanvas.svelte
│   │   │   │   ├── CropOverlay.svelte
│   │   │   │   ├── Timeline.svelte
│   │   │   │   ├── ThumbnailStrip.svelte
│   │   │   │   └── PlaybackControls.svelte
│   │   │   ├── store.js
│   │   │   ├── core.js               # クロップ計算、フレーム選択ロジック
│   │   │   ├── canvas.js             # Canvas描画ロジック
│   │   │   └── types.js
│   │   │
│   │   └── export/
│   │       ├── components/
│   │       │   ├── ExportDialog.svelte
│   │       │   ├── EncoderGrid.svelte
│   │       │   ├── ExportSettings.svelte
│   │       │   └── ProgressDialog.svelte
│   │       ├── store.js
│   │       ├── core.js               # ファイルサイズ推定、設定検証
│   │       ├── encoder.js            # エンコーダー起動ロジック
│   │       └── types.js
│   │
│   ├── shared/                       # 共有モジュール
│   │   ├── components/               # 共通UIコンポーネント
│   │   │   ├── Button.svelte
│   │   │   ├── Slider.svelte
│   │   │   ├── Toggle.svelte
│   │   │   ├── Modal.svelte
│   │   │   └── Tooltip.svelte
│   │   │
│   │   ├── stores/                   # グローバルストア
│   │   │   └── router.js             # ルーティング状態
│   │   │
│   │   ├── utils/                    # ユーティリティ関数
│   │   │   ├── image.js              # ImageData操作
│   │   │   ├── math.js               # 数学関数（クランプ、補間など）
│   │   │   ├── format.js             # フォーマット（時間、バイトサイズ）
│   │   │   └── performance.js        # パフォーマンス計測
│   │   │
│   │   └── types/                    # 共通型定義
│   │       └── common.d.ts
│   │
│   ├── workers/                      # Web Workers
│   │   ├── thumbnail-generator.worker.js
│   │   ├── gif-encoder.worker.js
│   │   └── frame-processor.worker.js
│   │
│   ├── wasm/                         # WASM モジュール
│   │   ├── exoquant.wasm
│   │   ├── gif-lzw.wasm
│   │   ├── dithering.wasm
│   │   └── loader.js                 # WASM ローダー
│   │
│   └── styles/                       # グローバルスタイル
│       ├── global.css
│       ├── variables.css             # CSS変数（カラー、サイズ）
│       └── reset.css
│
├── tests/                            # テスト
│   ├── unit/                         # ユニットテスト（Vitest）
│   │   ├── capture/
│   │   ├── editor/
│   │   └── export/
│   ├── component/                    # コンポーネントテスト
│   └── e2e/                          # E2Eテスト（Playwright）
│
├── package.json
├── vite.config.js
├── tsconfig.json                     # TypeScript設定（JSDocベース）
└── README.md
```

---

## 3. レイヤー設計

### 3.1 レイヤー構成

各機能（feature）は以下の4レイヤーで構成:

```
┌─────────────────────────────────────────┐
│  Components (Svelte)                    │  ← UI層（Imperative Shell）
│  - ユーザー入力のハンドリング              │
│  - Storeの購読と表示                     │
│  - DOM/Canvas操作のトリガー               │
├─────────────────────────────────────────┤
│  Store (Svelte Store)                   │  ← 状態管理層
│  - アプリケーション状態                   │
│  - Derived Stores（算出値）              │
│  - 状態の永続化（将来的）                 │
├─────────────────────────────────────────┤
│  Core (Pure Functions)                  │  ← ビジネスロジック層（Functional Core）
│  - ビジネスルール                        │
│  - データ変換・計算                      │
│  - バリデーション                        │
│  - 副作用なし（テスト容易）               │
├─────────────────────────────────────────┤
│  API (Side Effects)                     │  ← 外部I/O層（Imperative Shell）
│  - Browser APIs                         │
│  - Worker通信                           │
│  - File操作                             │
└─────────────────────────────────────────┘
```

### 3.2 データフロー

```
User Action (Component)
    ↓
Store Update (dispatch action)
    ↓
Core Logic (pure function)
    ↓
New State
    ↓
Store Notify
    ↓
Component Re-render
    ↓
API Call (side effect) ← 必要に応じて
```

### 3.3 依存関係ルール

```
Components → Store → Core ← API
    ↓          ↓      ↑
  Utils ←─────┴──────┘

ルール:
1. Coreは他の層に依存しない（純粋関数）
2. Storeは Core を使用可能
3. Components は Store のみ購読（直接Coreを呼ばない）
4. API は Core を呼び出して結果を返す
5. Utils はどこからでも使用可能
```

---

## 4. 機能別詳細設計

### 4.1 Capture機能

#### **責務**
- Screen Capture APIの管理
- 循環バッファへのフレーム保存
- クリップ作成

#### **ディレクトリ構成**

```javascript
// features/capture/core.js - ビジネスロジック（純粋関数）

/**
 * 循環バッファにフレームを追加
 * @param {ImageData[]} buffer - 現在のバッファ
 * @param {ImageData} frame - 新しいフレーム
 * @param {number} maxSize - 最大バッファサイズ
 * @returns {ImageData[]} - 更新されたバッファ
 */
export function addFrameToBuffer(buffer, frame, maxSize) {
  const newBuffer = [...buffer, frame];
  return newBuffer.length > maxSize 
    ? newBuffer.slice(newBuffer.length - maxSize) 
    : newBuffer;
}

/**
 * バッファの統計を計算
 * @param {ImageData[]} buffer
 * @param {number} fps
 * @returns {{ frameCount: number, duration: number, memoryMB: number }}
 */
export function calculateBufferStats(buffer, fps) {
  const frameCount = buffer.length;
  const duration = frameCount / fps;
  
  // 推定メモリ使用量（RGBA × width × height）
  const memoryBytes = buffer.reduce((sum, frame) => {
    return sum + frame.data.length; // Uint8ClampedArray
  }, 0);
  
  return {
    frameCount,
    duration,
    memoryMB: memoryBytes / (1024 * 1024)
  };
}

/**
 * フレームをクリップ可能か検証
 * @param {number} frameCount
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateClip(frameCount) {
  if (frameCount === 0) {
    return { valid: false, error: 'No frames to clip' };
  }
  if (frameCount < 5) {
    return { valid: false, error: 'Need at least 5 frames' };
  }
  return { valid: true };
}
```

```javascript
// features/capture/api.js - 外部I/O（副作用）

/**
 * Screen Capture APIを開始
 * @returns {Promise<MediaStream>}
 * @throws {Error} ユーザーが許可を拒否した場合
 */
export async function startScreenCapture() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 }
      },
      audio: false
    });
    return stream;
  } catch (error) {
    if (error.name === 'NotAllowedError') {
      throw new Error('Screen sharing permission denied');
    }
    throw error;
  }
}

/**
 * MediaStreamから現在のフレームをキャプチャ
 * @param {HTMLVideoElement} video
 * @param {HTMLCanvasElement} canvas
 * @returns {ImageData}
 */
export function captureFrame(video, canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  
  ctx.drawImage(video, 0, 0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/**
 * MediaStreamを停止
 * @param {MediaStream} stream
 */
export function stopScreenCapture(stream) {
  stream.getTracks().forEach(track => track.stop());
}
```

```javascript
// features/capture/store.js - 状態管理

import { writable, derived } from 'svelte/store';
import { addFrameToBuffer, calculateBufferStats } from './core.js';

// プライベートストア（書き込み可能）
const _state = writable({
  isCapturing: false,
  frames: [],
  settings: {
    fps: 30,
    maxFrames: 500,
    thumbnailQuality: 0.5
  },
  stream: null,
  error: null
});

// パブリックストア（読み取り専用）
export const captureStore = {
  subscribe: _state.subscribe
};

// Derived Store: バッファ統計
export const bufferStats = derived(
  _state,
  $state => calculateBufferStats($state.frames, $state.settings.fps)
);

// Actions（Storeの更新関数）
export const captureActions = {
  start(stream) {
    _state.update(state => ({
      ...state,
      isCapturing: true,
      stream,
      error: null
    }));
  },
  
  stop() {
    _state.update(state => {
      if (state.stream) {
        state.stream.getTracks().forEach(track => track.stop());
      }
      return {
        ...state,
        isCapturing: false,
        stream: null
      };
    });
  },
  
  addFrame(frame) {
    _state.update(state => ({
      ...state,
      frames: addFrameToBuffer(
        state.frames, 
        frame, 
        state.settings.maxFrames
      )
    }));
  },
  
  clearBuffer() {
    _state.update(state => ({
      ...state,
      frames: []
    }));
  },
  
  setError(error) {
    _state.update(state => ({
      ...state,
      error,
      isCapturing: false
    }));
  },
  
  updateSettings(newSettings) {
    _state.update(state => ({
      ...state,
      settings: { ...state.settings, ...newSettings }
    }));
  }
};
```

```svelte
<!-- features/capture/components/CaptureScreen.svelte -->
<script>
  import { onMount, onDestroy } from 'svelte';
  import { captureStore, captureActions, bufferStats } from '../store.js';
  import { startScreenCapture, captureFrame, stopScreenCapture } from '../api.js';
  import { validateClip } from '../core.js';
  import { navigate } from '../../../shared/stores/router.js';
  
  import VideoStream from './VideoStream.svelte';
  import ControlPanel from './ControlPanel.svelte';
  import BufferStats from './BufferStats.svelte';
  
  let videoElement;
  let canvasElement;
  let rafId = null;
  
  // ストアの購読
  $: ({ isCapturing, frames, error } = $captureStore);
  $: stats = $bufferStats;
  
  // キャプチャ開始
  async function handleStartCapture() {
    try {
      const stream = await startScreenCapture();
      captureActions.start(stream);
      
      // ビデオ要素にストリームをセット
      videoElement.srcObject = stream;
      videoElement.play();
      
      // フレームキャプチャループ開始
      startCaptureLoop();
    } catch (err) {
      captureActions.setError(err.message);
    }
  }
  
  // フレームキャプチャループ
  function startCaptureLoop() {
    const fps = $captureStore.settings.fps;
    const interval = 1000 / fps;
    let lastTime = performance.now();
    
    function loop(currentTime) {
      if (currentTime - lastTime >= interval) {
        const frame = captureFrame(videoElement, canvasElement);
        captureActions.addFrame(frame);
        lastTime = currentTime;
      }
      
      if ($captureStore.isCapturing) {
        rafId = requestAnimationFrame(loop);
      }
    }
    
    rafId = requestAnimationFrame(loop);
  }
  
  // キャプチャ停止
  function handleStopCapture() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    captureActions.stop();
  }
  
  // クリップ作成
  function handleCreateClip() {
    const validation = validateClip(frames.length);
    if (!validation.valid) {
      alert(validation.error);
      return;
    }
    
    // フレームをエディターに渡して遷移
    // TODO: エディターストアにフレームをコピー
    navigate('editor');
  }
  
  onDestroy(() => {
    if (rafId) cancelAnimationFrame(rafId);
    if ($captureStore.isCapturing) {
      handleStopCapture();
    }
  });
</script>

<div class="capture-screen">
  <main class="capture-main">
    <VideoStream bind:videoElement bind:canvasElement />
  </main>
  
  <aside class="capture-sidebar">
    <ControlPanel
      {isCapturing}
      on:start={handleStartCapture}
      on:stop={handleStopCapture}
      on:clip={handleCreateClip}
    />
    
    <BufferStats {stats} />
    
    {#if error}
      <div class="error-message">{error}</div>
    {/if}
  </aside>
</div>

<style>
  .capture-screen {
    display: flex;
    height: 100vh;
  }
  
  .capture-main {
    flex: 1;
    background: #1a1a1a;
  }
  
  .capture-sidebar {
    width: 320px;
    background: #2a2a2a;
    padding: 1rem;
  }
  
  .error-message {
    background: #ff4444;
    color: white;
    padding: 0.75rem;
    border-radius: 4px;
    margin-top: 1rem;
  }
</style>
```

---

### 4.2 Editor機能

#### **責務**
- フレーム範囲の選択
- クロップエリアの管理
- プレビュー再生

#### **Core Logic**

```javascript
// features/editor/core.js

/**
 * クロップエリアを画面境界内にクランプ
 * @param {{ x: number, y: number, width: number, height: number }} cropArea
 * @param {{ width: number, height: number }} frameSize
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
export function clampCropArea(cropArea, frameSize) {
  return {
    x: Math.max(0, Math.min(cropArea.x, frameSize.width - cropArea.width)),
    y: Math.max(0, Math.min(cropArea.y, frameSize.height - cropArea.height)),
    width: Math.min(cropArea.width, frameSize.width),
    height: Math.min(cropArea.height, frameSize.height)
  };
}

/**
 * アスペクト比を維持したままクロップエリアをリサイズ
 * @param {{ x, y, width, height }} cropArea
 * @param {string} aspectRatio - '16:9', '1:1', etc.
 * @param {string} handle - 'nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w'
 * @param {{ x: number, y: number }} delta - マウス移動量
 * @returns {{ x, y, width, height }}
 */
export function resizeCropArea(cropArea, aspectRatio, handle, delta) {
  // アスペクト比をパース
  const ratio = parseAspectRatio(aspectRatio);
  
  let { x, y, width, height } = cropArea;
  
  // ハンドル位置に応じてサイズ変更
  switch (handle) {
    case 'se': // 右下
      width += delta.x;
      height += delta.y;
      break;
    case 'nw': // 左上
      x += delta.x;
      y += delta.y;
      width -= delta.x;
      height -= delta.y;
      break;
    // ... 他のハンドル
  }
  
  // アスペクト比を適用
  if (ratio) {
    height = width / ratio;
  }
  
  return { x, y, width, height };
}

/**
 * アスペクト比文字列をパース
 * @param {string} aspectRatio - '16:9', 'free'
 * @returns {number | null} - 数値比率 or null（free）
 */
function parseAspectRatio(aspectRatio) {
  if (aspectRatio === 'free') return null;
  
  const [w, h] = aspectRatio.split(':').map(Number);
  return w / h;
}

/**
 * フレーム範囲が有効か検証
 * @param {{ start: number, end: number }} range
 * @param {number} totalFrames
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateFrameRange(range, totalFrames) {
  if (range.start < 0 || range.end >= totalFrames) {
    return { valid: false, error: 'Range out of bounds' };
  }
  if (range.start >= range.end) {
    return { valid: false, error: 'Start must be before end' };
  }
  return { valid: true };
}

/**
 * 選択範囲のフレーム数を計算
 * @param {{ start: number, end: number }} range
 * @returns {number}
 */
export function calculateSelectedFrameCount(range) {
  return range.end - range.start + 1;
}

/**
 * 選択範囲の再生時間を計算
 * @param {{ start: number, end: number }} range
 * @param {number} fps
 * @returns {number} - 秒数
 */
export function calculateSelectedDuration(range, fps) {
  const frameCount = calculateSelectedFrameCount(range);
  return frameCount / fps;
}
```

```javascript
// features/editor/canvas.js - Canvas描画ロジック

/**
 * キャンバスにフレームを描画
 * @param {CanvasRenderingContext2D} ctx
 * @param {ImageData} frame
 * @param {{ x, y, width, height } | null} cropArea
 */
export function drawFrame(ctx, frame, cropArea = null) {
  const canvas = ctx.canvas;
  
  if (cropArea) {
    // クロップ領域のみを描画
    const tempCanvas = new OffscreenCanvas(cropArea.width, cropArea.height);
    const tempCtx = tempCanvas.getContext('2d');
    
    // 元フレームをtempCanvasに描画
    tempCtx.putImageData(frame, -cropArea.x, -cropArea.y);
    
    // メインキャンバスにスケール描画
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(tempCanvas, 0, 0, canvas.width, canvas.height);
  } else {
    // フレーム全体を描画
    const tempCanvas = new OffscreenCanvas(frame.width, frame.height);
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.putImageData(frame, 0, 0);
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(tempCanvas, 0, 0, canvas.width, canvas.height);
  }
}

/**
 * クロップオーバーレイを描画
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ x, y, width, height }} cropArea
 * @param {string} color - 'red', 'blue', etc.
 */
export function drawCropOverlay(ctx, cropArea, color = 'red') {
  const canvas = ctx.canvas;
  
  // 外側を暗くする
  ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  
  // クロップ領域をクリア（明るく）
  ctx.clearRect(cropArea.x, cropArea.y, cropArea.width, cropArea.height);
  
  // 境界線を描画
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.strokeRect(cropArea.x, cropArea.y, cropArea.width, cropArea.height);
  
  // リサイズハンドルを描画
  drawResizeHandles(ctx, cropArea, color);
}

/**
 * リサイズハンドルを描画
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ x, y, width, height }} cropArea
 * @param {string} color
 */
function drawResizeHandles(ctx, cropArea, color) {
  const handleSize = 10;
  const handles = [
    { x: cropArea.x, y: cropArea.y }, // nw
    { x: cropArea.x + cropArea.width, y: cropArea.y }, // ne
    { x: cropArea.x, y: cropArea.y + cropArea.height }, // sw
    { x: cropArea.x + cropArea.width, y: cropArea.y + cropArea.height }, // se
    // ... 他のハンドル
  ];
  
  ctx.fillStyle = color;
  handles.forEach(handle => {
    ctx.fillRect(
      handle.x - handleSize / 2,
      handle.y - handleSize / 2,
      handleSize,
      handleSize
    );
  });
}
```

---

### 4.3 Export機能

#### **Core Logic**

```javascript
// features/export/core.js

/**
 * GIFファイルサイズを推定
 * @param {{
 *   frameCount: number,
 *   width: number,
 *   height: number,
 *   quality: number,
 *   frameSkip: number,
 *   dithering: boolean
 * }} params
 * @returns {number} - バイト数
 */
export function estimateGifSize(params) {
  const {
    frameCount,
    width,
    height,
    quality,
    frameSkip,
    dithering
  } = params;
  
  // 簡易計算式
  const baseSizePerFrame = 1024; // 1KB
  const pixelCount = width * height;
  const pixelFactor = pixelCount / (1920 * 1080); // normalize to 1080p
  
  const qualityMultiplier = quality;
  const ditherMultiplier = dithering ? 1.2 : 1.0;
  const effectiveFrames = frameCount / frameSkip;
  
  return effectiveFrames * baseSizePerFrame * qualityMultiplier * ditherMultiplier * pixelFactor;
}

/**
 * エクスポート設定を検証
 * @param {ExportSettings} settings
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateExportSettings(settings) {
  const errors = [];
  
  if (settings.quality < 0.1 || settings.quality > 1.0) {
    errors.push('Quality must be between 10% and 100%');
  }
  
  if (settings.frameSkip < 1 || settings.frameSkip > 5) {
    errors.push('Frame skip must be between 1 and 5');
  }
  
  if (settings.playbackSpeed < 0.25 || settings.playbackSpeed > 2.0) {
    errors.push('Playback speed must be between 0.25x and 2.0x');
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * 利用可能なエンコーダーをフィルタリング
 * @param {Encoder[]} encoders
 * @param {boolean} isProduction
 * @returns {Encoder[]}
 */
export function getAvailableEncoders(encoders, isProduction) {
  // プロダクションビルドではMITライセンスのみ
  if (isProduction) {
    return encoders.filter(encoder => encoder.license === 'MIT');
  }
  return encoders;
}
```

```javascript
// features/export/encoder.js - エンコーダー起動

/**
 * GIFエンコードWorkerを起動
 * @param {{
 *   frames: ImageData[],
 *   settings: ExportSettings,
 *   encoder: string,
 *   onProgress: (progress) => void
 * }} params
 * @returns {Promise<Blob>}
 */
export async function encodeGif({ frames, settings, encoder, onProgress }) {
  // Workerを起動
  const worker = new Worker(
    new URL('../../workers/gif-encoder.worker.js', import.meta.url),
    { type: 'module' }
  );
  
  return new Promise((resolve, reject) => {
    worker.onmessage = (e) => {
      const { type, data } = e.data;
      
      if (type === 'progress') {
        onProgress(data);
      } else if (type === 'complete') {
        worker.terminate();
        resolve(data.blob);
      } else if (type === 'error') {
        worker.terminate();
        reject(new Error(data.message));
      }
    };
    
    worker.onerror = (error) => {
      worker.terminate();
      reject(error);
    };
    
    // Workerにデータを送信（Transferable）
    const frameBuffers = frames.map(frame => frame.data.buffer);
    worker.postMessage(
      {
        type: 'encode',
        frames: frames.map(f => ({
          data: f.data,
          width: f.width,
          height: f.height
        })),
        settings,
        encoder
      },
      frameBuffers // Transfer ownership
    );
  });
}

/**
 * Blobをダウンロードまたはタブで開く
 * @param {Blob} blob
 * @param {string} filename
 * @param {boolean} openInNewTab
 */
export function downloadOrOpen(blob, filename, openInNewTab) {
  const url = URL.createObjectURL(blob);
  
  if (openInNewTab) {
    window.open(url, '_blank');
  } else {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
  
  // メモリリーク防止
  setTimeout(() => URL.revokeObjectURL(url), 100);
}
```

---

## 5. 状態管理

### 5.1 ストア設計パターン

**プライベート/パブリックパターン**:
```javascript
// ❌ 悪い例: 直接書き込み可能
export const myStore = writable({ count: 0 });

// ✅ 良い例: 読み取り専用 + Actions
const _state = writable({ count: 0 });

export const myStore = {
  subscribe: _state.subscribe
};

export const myActions = {
  increment() {
    _state.update(s => ({ count: s.count + 1 }));
  }
};
```

### 5.2 グローバルストア vs ローカルストア

**グローバルストア**:
- ルーティング状態
- テーマ設定（ダークモード）
- ユーザー設定（将来的）

**ローカルストア**（機能ごと）:
- captureStore（キャプチャ状態）
- editorStore（エディタ状態）
- exportStore（エクスポート状態）

### 5.3 Derived Stores

```javascript
// shared/stores/derived-example.js
import { derived } from 'svelte/store';
import { editorStore } from '../../features/editor/store.js';
import { captureStore } from '../../features/capture/store.js';

// 選択フレーム数
export const selectedFrameCount = derived(
  editorStore,
  $editor => $editor.frameRange.end - $editor.frameRange.start + 1
);

// 選択範囲の再生時間
export const selectedDuration = derived(
  [editorStore, captureStore],
  ([$editor, $capture]) => {
    const frameCount = $editor.frameRange.end - $editor.frameRange.start + 1;
    return frameCount / $capture.settings.fps;
  }
);
```

---

## 6. データフロー

### 6.1 キャプチャ→エディタ

```
CaptureScreen.svelte
    ↓ (handleCreateClip)
editorActions.loadFrames(frames)
    ↓
editorStore updated
    ↓
navigate('editor')
    ↓
EditorScreen.svelte
    ↓ (onMount)
Generate Thumbnails in Worker
    ↓
editorActions.setThumbnails(thumbnails)
```

### 6.2 エディタ→エクスポート

```
EditorScreen.svelte
    ↓ (handleExport)
exportActions.openDialog({
  frames: selectedFrames,
  cropArea,
  fps
})
    ↓
ExportDialog.svelte
    ↓ (handleStartExport)
encodeGif({ frames, settings })
    ↓
Worker処理
    ↓
onProgress → exportActions.updateProgress
    ↓
onComplete → exportActions.complete(blob)
    ↓
downloadOrOpen(blob, filename)
```

---

## 7. 型定義

### 7.1 TypeScript設定（JSDocベース）

**tsconfig.json**:
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "lib": ["ES2020", "DOM"],
    "moduleResolution": "bundler",
    "allowJs": true,
    "checkJs": true,
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "paths": {
      "$lib/*": ["./src/*"],
      "$features/*": ["./src/features/*"],
      "$shared/*": ["./src/shared/*"]
    }
  },
  "include": ["src/**/*.js", "src/**/*.svelte"],
  "exclude": ["node_modules", "build", "dist"]
}
```

### 7.2 型定義例

```typescript
// shared/types/common.d.ts

export type CaptureState = {
  isCapturing: boolean;
  frames: ImageData[];
  settings: CaptureSettings;
  stream: MediaStream | null;
  error: string | null;
};

export type CaptureSettings = {
  fps: 15 | 30 | 60;
  maxFrames: number;
  thumbnailQuality: number;
};

export type EditorState = {
  frames: ImageData[];
  currentFrame: number;
  frameRange: FrameRange;
  cropArea: CropArea | null;
  settings: EditorSettings;
  playback: PlaybackState;
  thumbnails: Blob[];
};

export type FrameRange = {
  start: number;
  end: number;
};

export type CropArea = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type EditorSettings = {
  playbackSpeed: number;
  showGrid: boolean;
  aspectRatio: 'free' | '1:1' | '16:9' | '4:3' | '9:16' | '3:4';
  cropLineColor: 'red' | 'blue' | 'yellow' | 'white' | 'neon';
};

export type PlaybackState = {
  isPlaying: boolean;
  loopEnabled: boolean;
};

export type ExportState = {
  selectedEncoder: string;
  settings: ExportSettings;
  progress: ExportProgress;
  estimatedSizeMB: number;
};

export type ExportSettings = {
  quality: number;
  frameSkip: number;
  playbackSpeed: number;
  dithering: boolean;
  loopCount: number;
  openInNewTab: boolean;
};

export type ExportProgress = {
  status: 'idle' | 'preparing' | 'encoding' | 'completed' | 'error';
  percent: number;
  currentFrame: number;
  totalFrames: number;
  elapsedTime: number;
  estimatedRemaining: number;
};

export type Encoder = {
  id: string;
  name: string;
  speed: 'fast' | 'medium' | 'slow';
  quality: 'high' | 'medium' | 'low';
  license: 'MIT' | 'GPL';
  available: boolean;
};
```

### 7.3 JSDocの使用例

```javascript
// features/capture/core.js

/**
 * @typedef {import('../../shared/types/common').CaptureSettings} CaptureSettings
 */

/**
 * バッファ統計を計算
 * @param {ImageData[]} buffer
 * @param {number} fps
 * @returns {{ frameCount: number, duration: number, memoryMB: number }}
 */
export function calculateBufferStats(buffer, fps) {
  // ...
}
```

---

## 8. 命名規則

### 8.1 ファイル・ディレクトリ

```
コンポーネント: PascalCase.svelte (例: CaptureScreen.svelte)
JS/TS: kebab-case.js (例: capture-utils.js) または camelCase.js (例: captureUtils.js)
ストア: feature-name/store.js
ビジネスロジック: feature-name/core.js
API層: feature-name/api.js
型定義: types.js または types.d.ts
```

### 8.2 変数・関数

```
変数: camelCase (例: frameCount, isCapturing)
定数: UPPER_SNAKE_CASE (例: MAX_BUFFER_SIZE, DEFAULT_FPS)
関数: camelCase (例: calculateBufferStats, handleStartCapture)
コンポーネントイベントハンドラ: handleEventName (例: handleClick, handleSubmit)
ストアアクション: 動詞 (例: start, stop, addFrame, updateSettings)
```

### 8.3 Svelte特有

```
ストア変数: $storeName (例: $captureStore, $bufferStats)
バインド変数: bind:variableName
イベントハンドラ: on:eventname={handler}
```

### 8.4 コメント

```javascript
// ✅ 良い例: なぜそうするのか説明
// 循環バッファの実装 - 古いフレームを自動削除してメモリ節約
const newBuffer = buffer.length > maxSize 
  ? buffer.slice(buffer.length - maxSize)
  : buffer;

// ❌ 悪い例: 何をしているか説明（コード自体が説明的であるべき）
// バッファが最大サイズより大きい場合、スライスする
const newBuffer = buffer.length > maxSize ? buffer.slice(...) : buffer;
```

---

## 付録

### A. 依存関係図

```
┌─────────────────────────────────────────┐
│              App.svelte                 │
└────────┬────────────────────────────────┘
         │
    ┌────┴────┬────────┬────────┐
    │         │        │        │
    ▼         ▼        ▼        ▼
Capture   Editor   Export   Shared
feature   feature  feature  modules
    │         │        │        │
    ├─────────┴────────┴────────┤
    │                           │
    ▼                           ▼
Components                   Utils
Store                        Types
Core
API
```

### B. パフォーマンスチェックリスト

- [ ] 重い計算はWeb Workerで実行
- [ ] Canvas操作はrequestAnimationFrame内で
- [ ] 不要なリアクティブ更新を避ける（$:の過度な使用）
- [ ] 大きな配列は仮想スクロール
- [ ] メモリリークチェック（Event listenerの解除）
- [ ] WASMモジュールは遅延ロード
- [ ] ImageDataはTransferableで転送

### C. セキュリティチェックリスト

- [ ] CSP（Content Security Policy）設定
- [ ] HTTPS必須（Screen Capture API）
- [ ] ユーザーデータをサーバーに送信しない
- [ ] XSS対策（Svelteは自動エスケープ）
- [ ] Dependencyの脆弱性スキャン（npm audit）

---

**文書バージョン**: 1.0  
**最終更新**: 2025-10-31  
**次のステップ**: 実装フェーズへ移行（/speckit.tasks）
