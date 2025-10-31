# 技術選定＆アーキテクチャ設計 - Screen Capture & GIF Generator

**作成日**: 2025-10-31  
**目的**: 軽量で高速なツールとして作り直すための技術選定と設計  
**参照**: spec.md（機能要件）

---

## 1. 現状の課題分析

### 1.1 Flutter Web の問題点

**パフォーマンス**:
- Flutter Web の大きなバンドルサイズ（1.5MB以上）
- Dart → JavaScript のトランスパイルによるオーバーヘッド
- Canvas API の抽象化レイヤーによる遅延
- Virtual DOM 的なレンダリングによるメモリ消費

**WASM統合**:
- Flutter Web と WASM の統合が複雑
- Web Workers との連携が煩雑
- 型システムの不一致によるデバッグの難しさ

**開発体験**:
- Hot Reload が Web では不安定
- ブラウザ API への直接アクセスが制限される
- デバッグツールが限定的

**メモリ**:
- フレームワーク自体のメモリフットプリントが大きい
- GC（Garbage Collection）の挙動が予測しにくい
- メモリリークの検出が困難

### 1.2 要件の再確認

**このツールに必要なもの**:
- ✅ ブラウザ API への直接アクセス（Screen Capture API, Canvas API）
- ✅ WASM との高速な統合
- ✅ Web Workers による並列処理
- ✅ 最小限のバンドルサイズ（< 500KB理想）
- ✅ 低メモリフットプリント（< 100MB アイドル時）
- ✅ リアクティブなUI（60 FPS維持）

**不要なもの**:
- ❌ モバイルアプリ対応
- ❌ クロスプラットフォーム抽象化
- ❌ 複雑な状態管理
- ❌ サーバーサイドレンダリング（SSR）

---

## 2. フレームワーク選定

### 2.1 候補の比較

| フレームワーク | バンドルサイズ | 実行速度 | メモリ使用量 | WASM統合 | 学習コスト |
|--------------|-------------|---------|------------|----------|----------|
| **Vanilla JS** | ~0KB | 最速 | 最小 | ⭐⭐⭐⭐⭐ | 低 |
| **Svelte** | ~3-5KB | 非常に高速 | 非常に小 | ⭐⭐⭐⭐⭐ | 低 |
| **Solid.js** | ~3.86KB | 最速クラス | 最小クラス | ⭐⭐⭐⭐⭐ | 中 |
| **Vue 3** | ~40KB | 高速 | 小 | ⭐⭐⭐⭐ | 中 |
| **React** | ~130KB | 中速 | 中 | ⭐⭐⭐ | 高 |
| **Flutter Web** | ~1500KB | 低速 | 大 | ⭐⭐ | 高 |

### 2.2 推奨フレームワーク: **Vite + Svelte**

#### 選定理由

**1. パフォーマンス**:
- コンパイル時に最適化されたバニラJS生成
- Virtual DOM なし → 直接DOM操作で高速
- バンドルサイズが60-70%小さい（vs React/Vue）
- メモリ使用量が最小クラス

**2. WASM統合**:
- ブラウザAPIへの直接アクセスが容易
- WASM モジュールのロードと実行がシンプル
- Web Workers との連携が簡単

**3. 開発体験**:
- シンプルなコンポーネント構文（HTML + CSS + JS）
- リアクティブな変数宣言（`$:`構文）
- 優れた TypeScript サポート
- 高速なビルド（Vite ベース）

**4. 軽量性**:
- Svelte単体のランタイム（~5KB）のみ
- 不要なフレームワーク機能を排除
- 最小限の依存関係

#### なぜSvelteKitを採用しないのか

**SvelteKitの主な機能（このアプリには不要）**:
- ❌ SSR/SSG（サーバーサイドレンダリング）→ 完全クライアント側アプリ
- ❌ ファイルベースルーティング → 2-3画面のみで手動ルーティングで十分
- ❌ APIルート → サーバー機能不要
- ❌ フルスタック機能 → 静的SPAのみ

**SvelteKitのデメリット**:
- バンドルサイズ増加（+15-25KB）
- 不要な規約（+page.svelte, +layout.svelte）
- 学習コストの増加
- ビルド設定の複雑化

**結論**: 
このプロジェクトには **Vite + Svelte（SvelteKitなし）** が最適。
必要な機能だけを組み合わせることで、最小バンドルサイズと最高のパフォーマンスを実現。

#### 代替案: **Solid.js**

**Solid.jsも検討に値する理由**:
- さらに小さいバンドル（3.86KB）
- ベンチマークでトップクラスのパフォーマンス
- React風の構文で移行しやすい

**Svelteを優先する理由**:
- より大きなコミュニティとエコシステム
- 学習コストがやや低い
- ビルドツールの成熟度（Vite統合が安定）

### 2.3 Vanilla JS の検討

**Vanilla JS（フレームワークなし）も可能**:

**メリット**:
- ゼロバンドルサイズ
- 完全な制御
- 最速の実行速度

**デメリット**:
- リアクティブな UI 構築が煩雑
- コード量が増える
- メンテナンス性が低下

**結論**: 
このプロジェクトの規模（3つの主要画面、複雑な状態管理）では、Svelte のリアクティブシステムが開発効率とパフォーマンスのバランスが最適。

---

## 3. アーキテクチャ設計

### 3.1 全体構成

```
┌─────────────────────────────────────────────────────────────┐
│                    Browser Environment                       │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              Main Thread (Svelte App)                │   │
│  │                                                      │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌───────────┐ │   │
│  │  │   Capture    │  │    Editor    │  │  Export   │ │   │
│  │  │   Screen     │  │   Canvas     │  │  Dialog   │ │   │
│  │  │              │  │   Timeline   │  │  Settings │ │   │
│  │  └──────┬───────┘  └──────┬───────┘  └─────┬─────┘ │   │
│  │         │                  │                │       │   │
│  │         └──────────────────┴────────────────┘       │   │
│  │                            │                        │   │
│  │                   ┌────────▼───────────┐            │   │
│  │                   │  State Management  │            │   │
│  │                   │  (Svelte Stores)   │            │   │
│  │                   └────────┬───────────┘            │   │
│  │                            │                        │   │
│  └────────────────────────────┼────────────────────────┘   │
│                               │                            │
│  ┌────────────────────────────▼───────────────────────┐    │
│  │         Browser APIs (Direct Access)               │    │
│  │  • Screen Capture API                             │    │
│  │  • Canvas API (2D Context)                        │    │
│  │  • Web Workers API                                │    │
│  │  • WebAssembly API                                │    │
│  │  • File System Access API (Download)             │    │
│  └──────────┬────────────────────────┬────────────────┘    │
│             │                        │                     │
│  ┌──────────▼──────────┐  ┌──────────▼──────────────────┐ │
│  │  Web Workers Pool   │  │   WASM Modules             │ │
│  │                     │  │                            │ │
│  │  ┌───────────────┐  │  │  ┌───────────────────┐    │ │
│  │  │ Thumbnail     │  │  │  │ exoquant.wasm     │    │ │
│  │  │ Generator     │  │  │  │ (Color Quant)     │    │ │
│  │  └───────────────┘  │  │  └───────────────────┘    │ │
│  │                     │  │                            │ │
│  │  ┌───────────────┐  │  │  ┌───────────────────┐    │ │
│  │  │ GIF Encoder   │◄─┼──┼──┤ gif-encoder.wasm  │    │ │
│  │  │ Worker        │  │  │  │ (LZW Compress)    │    │ │
│  │  └───────────────┘  │  │  └───────────────────┘    │ │
│  │                     │  │                            │ │
│  │  ┌───────────────┐  │  │  ┌───────────────────┐    │ │
│  │  │ Frame         │  │  │  │ dithering.wasm    │    │ │
│  │  │ Processor     │  │  │  │ (Optional)        │    │ │
│  │  └───────────────┘  │  │  └───────────────────┘    │ │
│  └─────────────────────┘  └────────────────────────────┘ │
│                                                           │
└───────────────────────────────────────────────────────────┘
```

### 3.2 データフロー

#### 3.2.1 キャプチャフロー

```
User clicks "Start Capture"
        ↓
Navigator.mediaDevices.getDisplayMedia()
        ↓
MediaStream received
        ↓
Create <video> element (hidden, autoplay)
        ↓
video.srcObject = mediaStream
        ↓
requestAnimationFrame loop starts
        ↓
Every frame (30 FPS):
    ├─ Create temporary Canvas
    ├─ Draw video frame to Canvas
    ├─ Get ImageData (canvas.getImageData())
    ├─ Store frame in circular buffer (Array)
    └─ Update UI (frame count, duration)
        ↓
User clicks "Clip"
        ↓
Copy buffer to editor
        ↓
Generate thumbnails in Web Worker
        ↓
Navigate to Editor screen
```

#### 3.2.2 編集フロー

```
Editor screen loaded
        ↓
Display timeline with thumbnails
        ↓
User interaction:
    ├─ Select frame range (drag handles)
    ├─ Navigate frames (keyboard / buttons)
    ├─ Create crop area (drag on canvas)
    └─ Adjust crop (resize handles)
        ↓
Canvas rendering loop:
    ├─ Get current frame ImageData
    ├─ Draw to main canvas
    ├─ Apply crop overlay (CSS + Canvas)
    └─ Update at 60 FPS
        ↓
User clicks "Export"
        ↓
Open Export Dialog
```

#### 3.2.3 エクスポートフロー

```
Export Dialog opened
        ↓
User selects encoder + settings
        ↓
Estimate file size (JS calculation)
        ↓
User clicks "Export"
        ↓
Create Web Worker for encoding
        ↓
Load WASM module in worker:
    ├─ fetch('encoder.wasm')
    ├─ WebAssembly.instantiateStreaming()
    └─ Initialize encoder
        ↓
Transfer frames to worker (Transferable)
        ↓
Worker processing:
    ├─ For each frame:
    │   ├─ Apply crop (Canvas in Worker)
    │   ├─ Resize if needed
    │   ├─ Color quantization (WASM)
    │   ├─ Dithering (WASM, optional)
    │   └─ LZW compression (WASM)
    ├─ Post progress to main thread
    └─ Assemble GIF file
        ↓
Worker sends Blob to main thread
        ↓
Main thread triggers download:
    ├─ Create <a> element
    ├─ href = URL.createObjectURL(blob)
    └─ click()
        ↓
Done
```

### 3.3 状態管理（Svelte Stores）

#### 3.3.1 Store 設計

```javascript
// stores/capture.js
export const captureStore = writable({
  isCapturing: false,
  frames: [],           // Array<ImageData>
  settings: {
    fps: 30,
    bufferSize: 500,
    thumbnailQuality: 0.5
  },
  stats: {
    currentFrames: 0,
    maxFrames: 500,
    duration: 0,
    memoryUsage: 0
  }
});

// stores/editor.js
export const editorStore = writable({
  frames: [],           // From capture
  currentFrame: 0,
  frameRange: { start: 0, end: 299 },
  cropArea: null,       // { x, y, width, height } | null
  settings: {
    playbackSpeed: 1.0,
    showGrid: false,
    aspectRatio: 'free',
    cropLineColor: 'red'
  },
  playback: {
    isPlaying: false,
    loopEnabled: true
  }
});

// stores/export.js
export const exportStore = writable({
  selectedEncoder: 'wasm-exoquant',
  settings: {
    quality: 0.8,
    frameSkip: 1,
    playbackSpeed: 1.0,
    dithering: true,
    loopCount: 0,
    openInNewTab: false
  },
  progress: {
    status: 'idle',      // idle | preparing | encoding | completed | error
    percent: 0,
    currentFrame: 0,
    totalFrames: 0,
    elapsedTime: 0,
    estimatedRemaining: 0
  },
  estimatedSize: 0       // in MB
});
```

#### 3.3.2 Derived Stores（算出値）

```javascript
// stores/derived.js
import { derived } from 'svelte/store';
import { captureStore, editorStore, exportStore } from './index.js';

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

// 推定ファイルサイズ
export const estimatedFileSize = derived(
  [editorStore, exportStore, selectedFrameCount],
  ([$editor, $export, frameCount]) => {
    const { quality, frameSkip, dithering } = $export.settings;
    const { cropArea } = $editor;
    
    // 簡易計算式
    const baseSize = 1024; // 1KB per frame base
    const qualityMultiplier = quality;
    const ditherMultiplier = dithering ? 1.2 : 1.0;
    const skipDivisor = frameSkip;
    
    let width = 1920, height = 1080; // default
    if (cropArea) {
      width = cropArea.width;
      height = cropArea.height;
    }
    
    const pixelCount = width * height;
    const pixelFactor = pixelCount / (1920 * 1080); // normalize
    
    const effectiveFrames = frameCount / skipDivisor;
    const sizeBytes = effectiveFrames * baseSize * qualityMultiplier * ditherMultiplier * pixelFactor;
    
    return sizeBytes / (1024 * 1024); // MB
  }
);
```

### 3.4 コンポーネント構成

#### 3.4.1 ディレクトリ構造

```
src/
├── lib/
│   ├── components/
│   │   ├── capture/
│   │   │   ├── CaptureScreen.svelte        # メイン録画画面
│   │   │   ├── ControlPanel.svelte         # 右サイドバー
│   │   │   ├── VideoStream.svelte          # 録画ビュー
│   │   │   └── BufferStats.svelte          # 統計表示
│   │   │
│   │   ├── editor/
│   │   │   ├── EditorScreen.svelte         # メイン編集画面
│   │   │   ├── EditorCanvas.svelte         # キャンバス（フレーム表示）
│   │   │   ├── CropOverlay.svelte          # クロップUI
│   │   │   ├── Timeline.svelte             # タイムライン
│   │   │   ├── ThumbnailStrip.svelte       # サムネイル縦並び
│   │   │   ├── PlaybackControls.svelte     # 再生コントロール
│   │   │   └── EditorSettings.svelte       # 編集設定パネル
│   │   │
│   │   ├── export/
│   │   │   ├── ExportDialog.svelte         # エクスポートダイアログ
│   │   │   ├── EncoderGrid.svelte          # エンコーダー選択
│   │   │   ├── ExportSettings.svelte       # GIF設定
│   │   │   ├── ProgressDialog.svelte       # 進捗表示
│   │   │   └── FileSizeEstimate.svelte     # サイズ推定表示
│   │   │
│   │   └── shared/
│   │       ├── Button.svelte               # 共通ボタン
│   │       ├── Slider.svelte               # スライダー
│   │       ├── Toggle.svelte               # トグルスイッチ
│   │       ├── Modal.svelte                # モーダル
│   │       └── Tooltip.svelte              # ツールチップ
│   │
│   ├── stores/
│   │   ├── capture.js                      # キャプチャ状態
│   │   ├── editor.js                       # エディタ状態
│   │   ├── export.js                       # エクスポート状態
│   │   └── derived.js                      # 算出値
│   │
│   ├── workers/
│   │   ├── thumbnail-generator.worker.js   # サムネイル生成
│   │   ├── gif-encoder.worker.js           # GIFエンコード
│   │   └── frame-processor.worker.js       # フレーム処理
│   │
│   ├── wasm/
│   │   ├── exoquant.wasm                   # 色量子化
│   │   ├── gif-lzw.wasm                    # LZW圧縮
│   │   └── dithering.wasm                  # ディザリング
│   │
│   ├── utils/
│   │   ├── canvas.js                       # Canvas操作
│   │   ├── image-data.js                   # ImageData処理
│   │   ├── file.js                         # ファイル操作
│   │   └── performance.js                  # パフォーマンス計測
│   │
│   └── types/
│       ├── capture.d.ts                    # 型定義
│       ├── editor.d.ts
│       └── export.d.ts
│
├── routes/
│   ├── +page.svelte                        # トップ（キャプチャ画面）
│   ├── editor/+page.svelte                 # エディタ画面
│   └── +layout.svelte                      # 共通レイアウト
│
├── app.html                                # HTML テンプレート
└── app.css                                 # グローバルCSS
```

#### 3.4.2 主要コンポーネントの責務

**CaptureScreen.svelte**:
- Screen Capture API の初期化
- MediaStream の管理
- フレームキャプチャループ（requestAnimationFrame）
- 循環バッファの管理
- Clip ボタンのハンドリング

**EditorCanvas.svelte**:
- Canvas要素の管理
- 現在フレームの描画（60 FPS）
- マウスイベントハンドリング（クロップ作成・移動・リサイズ）
- キーボードショートカット

**Timeline.svelte**:
- フレーム範囲の可視化
- ドラッグハンドルの管理
- サムネイル表示
- フレームジャンプ

**ExportDialog.svelte**:
- エンコーダー選択UI
- 設定変更のハンドリング
- ファイルサイズ推定の表示
- エクスポート開始のトリガー

**gif-encoder.worker.js**:
- WASM モジュールのロード
- フレームの受信（Transferable）
- 色量子化・ディザリング・LZW圧縮
- 進捗の報告
- Blob の返却

---

## 4. 技術スタック詳細

### 4.1 フロントエンド

```json
{
  "dependencies": {
    "svelte": "^5.0.0",
    "@sveltejs/kit": "^2.0.0",
    "@sveltejs/adapter-static": "^3.0.0"
  },
  "devDependencies": {
    "vite": "^5.0.0",
    "typescript": "^5.0.0",
    "@types/node": "^20.0.0",
    "vitest": "^1.0.0",
    "@testing-library/svelte": "^4.0.0"
  }
}
```

**ビルドツール**: Vite
- 高速な開発サーバー
- HMR（Hot Module Replacement）
- 最適化されたプロダクションビルド
- WASM ローダーのサポート

**言語**: TypeScript
- 型安全性
- IntelliSense
- リファクタリングサポート

### 4.2 GIFエンコーディング戦略

#### プライマリ案: **gif.js（JavaScript実装）**

**採用理由**:
- ✅ MIT License
- ✅ 実績あり（多数のプロジェクトで使用）
- ✅ Web Worker対応済み
- ✅ 確実に動作（ブラウザ互換性高い）
- ✅ メンテナンス継続中

**構成**:
```
gif.js (MIT License)
├── gif.js (~5KB) - メインライブラリ
├── gif.worker.js (~15KB) - Worker実装
└── LZW圧縮（組み込み）
```

**パフォーマンス**:
- 1920x1080, 300フレーム: 約15-25秒
- メモリ効率的（Worker内で処理）
- プログレス報告機能あり

**使用例**:
```javascript
import GIF from 'gif.js';

const gif = new GIF({
  workers: 4,
  quality: 10,
  workerScript: '/gif.worker.js'
});

frames.forEach(frame => gif.addFrame(frame));
gif.render();
gif.on('finished', blob => download(blob));
```

#### セカンダリ案: **カスタムWASM（パフォーマンス最適化時）**

**Phase 3で検証する項目**:
- **exoquant** (Rust → WASM): 色量子化の高速化
- **カスタムLZW** (C/C++ → WASM): 圧縮の高速化
- **dithering** (Rust → WASM): ディザリング処理

**想定構成**:
```
カスタムWASM案
├── exoquant.wasm (~50KB) - 色量子化
├── lzw-encoder.wasm (~30KB) - LZW圧縮
└── dithering.wasm (~20KB) - オプション

合計: ~100KB gzipped
```

**期待効果**:
- エンコード時間: 15-25秒 → 5-12秒（**50-60%高速化**）
- メモリ使用量: 同等またはやや削減

**リスク**:
- ⚠️ ビルド環境の構築が必要（Rust, Emscripten）
- ⚠️ ブラウザ互換性の検証が必要
- ⚠️ デバッグが困難

#### 段階的アプローチ

**Phase 1-2（プロトタイプ〜コア機能）**:
- gif.js で実装（確実に動作）

**Phase 3（WASM統合）**:
- gif.js をベースラインとして保持
- カスタムWASMの検証とベンチマーク
- パフォーマンス向上が**50%以上**なら採用

**Phase 4（最適化）**:
- gif.js とカスタムWASMの切り替え機能
- ユーザーが選択可能（設定画面）
- フォールバック機構（WASMエラー時にgif.jsに切り替え）

#### フォールバック戦略

```javascript
async function encodeGif(frames, settings) {
  try {
    // まずカスタムWASMを試行
    return await encodeWithWasm(frames, settings);
  } catch (error) {
    console.warn('WASM encoding failed, falling back to gif.js', error);
    // フォールバック: gif.js
    return await encodeWithGifJs(frames, settings);
  }
}
```

### 4.3 Web Workers

**thumbnail-generator.worker.js**:
- OffscreenCanvas でサムネイル生成
- バッチ処理（10フレームずつ）
- 進捗報告

**gif-encoder.worker.js**:
- WASM モジュールのインスタンス化
- フレーム単位のエンコード
- プログレス計算

**frame-processor.worker.js**:
- クロップ処理
- リサイズ処理
- 色空間変換

### 4.4 ビルド最適化

**Code Splitting**:
- ルート単位で分割（Capture / Editor / Export）
- WASM は Dynamic Import
- Workers は別ファイル

**Tree Shaking**:
- Vite による自動最適化
- 未使用コードの削除

**Minification**:
- Terser による圧縮
- CSS の最適化（cssnano）

**Asset Optimization**:
- 画像の最適化（svgo）
- WASM の gzip 圧縮

**期待されるバンドルサイズ**:
- 初期ロード: ~150KB (gzipped)
  - Svelte runtime: ~5KB
  - App code: ~50KB
  - CSS: ~20KB
  - Polyfills: ~30KB
  - Vendor: ~45KB
- WASM (lazy load): ~100KB (gzipped)
- Total: ~250KB (gzipped)

**Flutter Web との比較**:
- Flutter Web: ~1.5MB (gzipped)
- **削減率: 約 83%**

---

## 5. パフォーマンス最適化戦略

### 5.1 メモリ管理

**循環バッファ**:
```javascript
// Circular buffer implementation
class CircularFrameBuffer {
  constructor(maxSize = 500) {
    this.buffer = new Array(maxSize);
    this.head = 0;
    this.size = 0;
    this.maxSize = maxSize;
  }
  
  push(frame) {
    this.buffer[this.head] = frame;
    this.head = (this.head + 1) % this.maxSize;
    if (this.size < this.maxSize) this.size++;
    
    // 古いフレームは自動的に上書きされる
  }
  
  getAll() {
    // 正しい順序で返す
    const start = this.size < this.maxSize ? 0 : this.head;
    return [
      ...this.buffer.slice(start),
      ...this.buffer.slice(0, start)
    ].filter(f => f !== undefined);
  }
  
  clear() {
    this.buffer.fill(undefined);
    this.head = 0;
    this.size = 0;
  }
}
```

**フレームキャッシュ**:
```javascript
// LRU Cache for thumbnails
class LRUFrameCache {
  constructor(maxSize = 10) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }
  
  get(key) {
    if (!this.cache.has(key)) return null;
    
    // LRU: 最近使用されたものを末尾に
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }
  
  set(key, value) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // 最も古いものを削除
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }
}
```

### 5.2 Canvas 最適化

**OffscreenCanvas for Workers**:
```javascript
// thumbnail-generator.worker.js
self.onmessage = async (e) => {
  const { frames, quality } = e.data;
  
  // Worker内でOffscreenCanvasを使用
  const canvas = new OffscreenCanvas(160, 90); // 16:9 thumbnail
  const ctx = canvas.getContext('2d', { 
    alpha: false,
    desynchronized: true 
  });
  
  const thumbnails = [];
  for (const frame of frames) {
    ctx.putImageData(frame, 0, 0);
    const blob = await canvas.convertToBlob({ 
      type: 'image/jpeg', 
      quality 
    });
    thumbnails.push(blob);
    
    // 進捗報告
    self.postMessage({ 
      type: 'progress', 
      current: thumbnails.length, 
      total: frames.length 
    });
  }
  
  self.postMessage({ type: 'complete', thumbnails });
};
```

**Double Buffering**:
```javascript
// EditorCanvas.svelte
let mainCanvas, bufferCanvas;

function drawFrame(frameData) {
  // バッファキャンバスに描画
  bufferCtx.putImageData(frameData, 0, 0);
  
  // メインキャンバスに一括転送
  mainCtx.drawImage(bufferCanvas, 0, 0);
  
  // クロップオーバーレイを別レイヤーで描画
  drawCropOverlay();
}
```

### 5.3 WASM 最適化

**Streaming Instantiation**:
```javascript
// utils/wasm-loader.js
export async function loadWasmModule(url) {
  const response = await fetch(url);
  const { instance } = await WebAssembly.instantiateStreaming(response, {
    env: {
      memory: new WebAssembly.Memory({ 
        initial: 256,  // 16MB
        maximum: 512   // 32MB
      })
    }
  });
  return instance.exports;
}
```

**Shared Memory (Future)**:
```javascript
// SharedArrayBuffer でメインスレッドとWorkerでメモリ共有
const sharedBuffer = new SharedArrayBuffer(1024 * 1024 * 16); // 16MB
const sharedArray = new Uint8Array(sharedBuffer);

// Worker に転送（コピーなし）
worker.postMessage({ type: 'init', buffer: sharedBuffer });
```

### 5.4 レンダリング最適化

**requestAnimationFrame の効率的な使用**:
```javascript
let rafId = null;
let lastFrameTime = 0;
const TARGET_FPS = 60;
const FRAME_INTERVAL = 1000 / TARGET_FPS;

function renderLoop(timestamp) {
  if (timestamp - lastFrameTime < FRAME_INTERVAL) {
    rafId = requestAnimationFrame(renderLoop);
    return;
  }
  
  lastFrameTime = timestamp;
  
  // 描画処理
  drawCurrentFrame();
  
  rafId = requestAnimationFrame(renderLoop);
}

// 開始
rafId = requestAnimationFrame(renderLoop);

// 停止
cancelAnimationFrame(rafId);
```

**Intersection Observer for Lazy Rendering**:
```javascript
// Timeline.svelte - スクロール外のサムネイルは描画しない
let observer;

onMount(() => {
  observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        // 見える範囲に入った→サムネイル読み込み
        loadThumbnail(entry.target.dataset.frameIndex);
      } else {
        // 見えない範囲→メモリ解放
        unloadThumbnail(entry.target.dataset.frameIndex);
      }
    });
  }, { rootMargin: '50px' }); // 50px 先読み
  
  thumbnailElements.forEach(el => observer.observe(el));
});
```

---

## 6. 開発・デプロイ戦略

### 6.1 開発環境

**必須ツール**:
- Node.js 20+
- pnpm (推奨) または npm
- VS Code (推奨エディタ)
- Chrome DevTools

**推奨 VS Code 拡張**:
- Svelte for VS Code
- ESLint
- Prettier
- WASM Language Support

**開発サーバー**:
```bash
pnpm install
pnpm dev
# → http://localhost:5173
```

### 6.2 ビルド設定

**vite.config.js**:
```javascript
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()],
  
  build: {
    target: 'esnext',
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: true,
        passes: 2
      }
    },
    rollupOptions: {
      output: {
        manualChunks: {
          'wasm-utils': ['./src/lib/utils/wasm-loader.js'],
          'workers': [
            './src/lib/workers/thumbnail-generator.worker.js',
            './src/lib/workers/gif-encoder.worker.js'
          ]
        }
      }
    }
  },
  
  optimizeDeps: {
    exclude: ['*.wasm']
  },
  
  server: {
    fs: {
      allow: ['..'] // WASM ファイルへのアクセス許可
    }
  }
});
```

**svelte.config.js**:
```javascript
import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default {
  preprocess: vitePreprocess(),
  
  kit: {
    adapter: adapter({
      pages: 'build',
      assets: 'build',
      fallback: 'index.html', // SPA mode
      precompress: true,      // Brotli + gzip
      strict: true
    }),
    
    alias: {
      $components: 'src/lib/components',
      $stores: 'src/lib/stores',
      $utils: 'src/lib/utils',
      $workers: 'src/lib/workers',
      $wasm: 'src/lib/wasm'
    }
  }
};
```

### 6.3 デプロイ

**静的ホスティング推奨先**:
- Vercel (推奨) - Zero config, Edge Network
- Netlify - 簡単デプロイ、HTTPS自動
- Cloudflare Pages - 高速CDN、無料枠大
- GitHub Pages - 無料、簡単

**デプロイコマンド**:
```bash
pnpm build
# → build/ フォルダが生成される

# Vercel の場合
vercel --prod

# Netlify の場合
netlify deploy --prod --dir=build
```

**環境変数**（不要だが将来的に）:
- `PUBLIC_API_URL`: API エンドポイント（現状不要）
- `PUBLIC_ANALYTICS_ID`: Google Analytics など

### 6.4 HTTPS 設定

**開発環境での HTTPS**:
```bash
# mkcert で自己署名証明書
mkcert localhost 127.0.0.1 ::1

# Vite で HTTPS 有効化
# vite.config.js
export default {
  server: {
    https: {
      key: fs.readFileSync('./localhost-key.pem'),
      cert: fs.readFileSync('./localhost.pem')
    }
  }
}
```

**プロダクション**:
- Vercel/Netlify/Cloudflare Pages は自動 HTTPS
- 独自ドメインの場合は Let's Encrypt

---

## 7. テスト戦略

### 7.1 ユニットテスト

**Vitest + Testing Library**:
```javascript
// src/lib/utils/canvas.test.js
import { describe, it, expect } from 'vitest';
import { createCanvas, getImageData } from './canvas';

describe('Canvas Utils', () => {
  it('should create canvas with correct dimensions', () => {
    const canvas = createCanvas(800, 600);
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(600);
  });
  
  it('should get ImageData from canvas', () => {
    const canvas = createCanvas(100, 100);
    const imageData = getImageData(canvas);
    expect(imageData.width).toBe(100);
    expect(imageData.height).toBe(100);
    expect(imageData.data.length).toBe(100 * 100 * 4); // RGBA
  });
});
```

### 7.2 コンポーネントテスト

```javascript
// src/lib/components/shared/Button.test.js
import { render, fireEvent } from '@testing-library/svelte';
import { expect, it } from 'vitest';
import Button from './Button.svelte';

it('should call onClick when clicked', async () => {
  let clicked = false;
  const { getByRole } = render(Button, {
    props: {
      onClick: () => { clicked = true; },
      label: 'Test Button'
    }
  });
  
  const button = getByRole('button');
  await fireEvent.click(button);
  
  expect(clicked).toBe(true);
});
```

### 7.3 E2E テスト（Playwright）

```javascript
// tests/capture.spec.js
import { test, expect } from '@playwright/test';

test('should capture screen and create clip', async ({ page, context }) => {
  // 画面共有の許可を自動化
  await context.grantPermissions(['display-capture']);
  
  await page.goto('/');
  
  // Start Capture ボタンをクリック
  await page.click('button:has-text("Start Capture")');
  
  // 3秒待機（録画）
  await page.waitForTimeout(3000);
  
  // Clip ボタンをクリック
  await page.click('button:has-text("Clip")');
  
  // エディタ画面に遷移
  await expect(page).toHaveURL('/editor');
  
  // タイムラインが表示される
  await expect(page.locator('.timeline')).toBeVisible();
});
```

### 7.4 パフォーマンステスト

```javascript
// tests/performance.spec.js
import { test, expect } from '@playwright/test';

test('should maintain 60 FPS during playback', async ({ page }) => {
  await page.goto('/editor');
  
  // Performance API で FPS 計測
  const fps = await page.evaluate(() => {
    return new Promise((resolve) => {
      let frameCount = 0;
      let lastTime = performance.now();
      
      function countFrames() {
        frameCount++;
        const now = performance.now();
        
        if (now - lastTime >= 1000) {
          resolve(frameCount);
        } else {
          requestAnimationFrame(countFrames);
        }
      }
      
      requestAnimationFrame(countFrames);
    });
  });
  
  expect(fps).toBeGreaterThanOrEqual(60);
});
```

---

## 8. 移行計画

### 8.1 段階的移行

**Phase 1: プロトタイプ（2週間）**
- Vite + Svelte セットアップ（SvelteKitなし）
- 手動ルーティングの実装（navaidまたは独自実装）
- キャプチャ機能の実装（画面録画、循環バッファ）
- 基本UIの構築
- **マイルストーン**: 画面録画→クリップ作成が動作

**Phase 2: コア機能（3週間）**
- エディタ画面（タイムライン、フレームナビゲーション）
- クロップ機能（Canvas操作、リサイズハンドル）
- Web Workers 統合（サムネイル生成）
- gif.js の統合（基本的なGIFエクスポート）
- **マイルストーン**: フレーム編集→GIFエクスポートが動作

**Phase 3: WASM統合検証（3週間）** ← +1週バッファ
- gif.js をベースライン実装として保持
- カスタムWASMの調査とビルド環境構築
  - exoquant (色量子化)
  - カスタムLZW (圧縮)
- パフォーマンスベンチマーク（gif.js vs WASM）
- 50%以上の高速化が確認できた場合のみWASM採用
- フォールバック機構の実装
- **マイルストーン**: WASM検証完了、採用判断

**Phase 4: 最適化（3週間）** ← +1週バッファ
- パフォーマンスチューニング
  - Canvas描画最適化
  - メモリ使用量の削減
  - バンドルサイズの最適化
- ブラウザ互換性問題の修正
- ユーザビリティ改善（キーボードショートカット等）
- **マイルストーン**: 全パフォーマンス目標達成

**Phase 5: テスト・デプロイ（1週間）**
- E2E テスト（Playwright）
- ブラウザ互換性テスト（Chrome, Firefox, Safari, Edge）
- パフォーマンステスト（Lighthouse, 手動測定）
- プロダクションデプロイ（Vercel/Netlify）
- **マイルストーン**: プロダクションリリース

**合計: 約12週間（3ヶ月）** ← Phase 3, 4に各+1週

**リスクバッファ**:
- Phase 3: WASM統合が困難な場合、gif.jsのみで完了可能
- Phase 4: パフォーマンス目標未達の場合、Phase 4を延長可能
- 最悪ケース（全Phase遅延）: 14週間（3.5ヶ月）

### 8.2 データ移行

現状では永続化データなし→ 移行不要

### 8.3 機能比較

| 機能 | Flutter版 | Svelte版 |
|------|----------|----------|
| 画面キャプチャ | ✅ | ✅ |
| 循環バッファ | ✅ | ✅ |
| フレーム編集 | ✅ | ✅ |
| クロップ | ✅ | ✅ |
| GIF エクスポート | ✅ | ✅ |
| WASM エンコーダー | ⚠️ (不安定) | ✅ (最適化) |
| バンドルサイズ | 1.5MB | 0.25MB |
| 初期ロード | 3-5秒 | < 1秒 |
| メモリ使用量 | 高 | 低 |

---

## 9. リスクと対策

### 9.1 技術的リスク

| リスク | 影響 | 確率 | 対策 |
|--------|------|------|------|
| WASM モジュールのブラウザ非互換 | 高 | 低 | フォールバックに JS 実装を用意 |
| Web Workers のメモリリーク | 中 | 中 | Worker の定期的な再起動 |
| Canvas 描画のパフォーマンス低下 | 中 | 低 | OffscreenCanvas + Double Buffering |
| ファイルサイズの肥大化 | 低 | 低 | Code Splitting + Tree Shaking |

### 9.2 スケジュールリスク

| リスク | 影響 | 確率 | 対策 |
|--------|------|------|------|
| WASM 統合の遅延 | 高 | 中 | Phase 3 を前倒し、早期に検証 |
| パフォーマンス最適化の長期化 | 中 | 中 | Phase 4 を柔軟に延長可能に |
| ブラウザ互換性問題 | 中 | 低 | Phase 5 を余裕を持って設定 |

### 9.3 ユーザー体験リスク

| リスク | 影響 | 確率 | 対策 |
|--------|------|------|------|
| UI/UX の劣化 | 高 | 低 | Flutter版のデザインを忠実に再現 |
| 機能の欠落 | 高 | 低 | 機能比較表で事前確認 |
| バグの増加 | 中 | 中 | 十分なテストカバレッジ（>80%） |

---

## 10. パフォーマンス測定方法

### 10.1 バンドルサイズ測定

**ビルド後のファイルサイズ確認**:
```bash
npm run build

# 詳細なファイルサイズ確認
ls -lh dist/ | grep -E '\.(js|css|wasm)$'

# gzip圧縮後のサイズ確認
gzip -c dist/assets/*.js | wc -c
```

**目標値**:
- 初期ロード（HTML + CSS + JS）: < 150KB (gzipped)
- WASM（遅延ロード）: < 100KB (gzipped)
- 合計: < 250KB (gzipped)

**測定ツール**:
- `vite-plugin-compression` でgzip/brotli圧縮サイズを確認
- Lighthouse の「Performance」スコアで検証

### 10.2 初期ロード時間測定

**Chrome DevToolsで測定**:
```
1. DevTools > Network タブを開く
2. "Disable cache" にチェック
3. ページをリロード
4. DOMContentLoaded イベントまでの時間を確認
```

**目標値**:
- DOMContentLoaded: < 500ms
- First Contentful Paint (FCP): < 1.0s
- Largest Contentful Paint (LCP): < 1.5s
- Time to Interactive (TTI): < 2.0s

**スロットリングテスト**:
```
DevTools > Network > Throttling:
- Fast 3G: < 3秒
- Slow 3G: < 5秒
```

### 10.3 メモリ使用量測定

**Chrome DevTools Performance Monitorで測定**:
```
1. DevTools > Performance Monitor を開く
2. 以下のメトリクスを監視:
   - JS heap size
   - DOM Nodes
   - Event listeners
```

**目標値**:
- アイドル時: < 50MB (JS heap)
- 録画中（300フレーム）: < 500MB
- エディタ画面: < 300MB
- ピーク時: < 1.5GB

**メモリリーク検出**:
```
1. DevTools > Memory > Heap snapshot
2. 録画 → クリップ → 編集 → エクスポートのサイクルを3回繰り返す
3. Heap snapshotを比較
4. メモリが解放されているか確認
```

### 10.4 FPS測定

**Chrome DevTools Renderingで測定**:
```
1. DevTools > Rendering > Frame Rendering Stats
2. エディタ画面でフレーム再生
3. FPS meterで60 FPSを維持できているか確認
```

**プログラマティック測定**:
```javascript
// tests/performance/fps-test.js
let frameCount = 0;
let lastTime = performance.now();

function measureFPS() {
  return new Promise((resolve) => {
    function countFrames(timestamp) {
      frameCount++;
      
      if (timestamp - lastTime >= 1000) {
        resolve(frameCount);
      } else {
        requestAnimationFrame(countFrames);
      }
    }
    requestAnimationFrame(countFrames);
  });
}

// テストで使用
const fps = await measureFPS();
expect(fps).toBeGreaterThanOrEqual(60);
```

**目標値**:
- エディタ画面（フレーム再生中）: 60 FPS維持
- タイムラインスクロール: 60 FPS維持
- クロップエリア操作: 60 FPS維持

### 10.5 エンコード速度測定

**ベンチマーク条件**:
```
解像度: 1920x1080
フレーム数: 300フレーム（10秒 @ 30 FPS）
品質: 80%
ディザリング: ON
```

**測定方法**:
```javascript
const startTime = performance.now();

await encodeGif(frames, settings);

const elapsedTime = (performance.now() - startTime) / 1000;
console.log(`Encoding time: ${elapsedTime.toFixed(2)}s`);
```

**目標値**:
- gif.js（JavaScript）: 15-25秒
- カスタムWASM: 5-12秒（**50-60%高速化**）

### 10.6 継続的パフォーマンス監視

**CI/CDでの自動測定**:
```yaml
# .github/workflows/performance.yml
name: Performance Test

on: [push, pull_request]

jobs:
  lighthouse:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - run: npm ci
      - run: npm run build
      - uses: treosh/lighthouse-ci-action@v9
        with:
          urls: |
            http://localhost:5173
          budgetPath: ./lighthouse-budget.json
```

**Lighthouse予算設定**:
```json
// lighthouse-budget.json
{
  "budgets": [
    {
      "path": "/*",
      "timings": [
        { "metric": "first-contentful-paint", "budget": 1000 },
        { "metric": "largest-contentful-paint", "budget": 1500 },
        { "metric": "interactive", "budget": 2000 }
      ],
      "resourceSizes": [
        { "resourceType": "script", "budget": 150 },
        { "resourceType": "stylesheet", "budget": 20 }
      ]
    }
  ]
}
```

---

## 11. まとめ

### 11.1 期待される改善

**パフォーマンス**:
- バンドルサイズ: 1.5MB → 80-120KB（**92-95%削減**）
- 初期ロード: 3-5秒 → < 1秒（**80%短縮**）
- メモリ使用量: 高 → 低（**推定50%削減**）
- UI応答性: 30-40 FPS → 60 FPS（**安定化**）

**開発体験**:
- ビルド時間: 30秒 → 5秒（**83%短縮**）
- HMR: 不安定 → 安定（Vite）
- デバッグ: 困難 → 容易（Chrome DevTools完全対応）

**ユーザー体験**:
- 初回ロード: 遅い → 高速
- 操作感: カクつく → 滑らか
- エクスポート: gif.jsで確実に動作、将来的にWASM最適化

### 11.2 技術的優位性

**Vite + Svelte + gif.js + Web Workers**:
- ブラウザAPIへの直接アクセス
- ゼロオーバーヘッドの状態管理
- 並列処理による高速化
- 最小限のメモリフットプリント
- 確実に動作するエンコーディング

### 11.3 次のステップ

1. **プロトタイプ作成** - Phase 1 開始
2. **Flutter版との機能比較** - チェックリスト作成
3. **gif.jsの統合** - Phase 1-2で実装
4. **WASMの検証** - Phase 3で性能評価
5. **デザインシステム移植** - Figma または Flutterコードから抽出

---

**文書バージョン**: 1.1  
**最終更新**: 2025-10-31  
**変更履歴**:
- v1.1: Vite + Svelte採用、gif.js優先、パフォーマンス測定方法追加
- v1.0: 初版作成
