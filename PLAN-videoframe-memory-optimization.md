# VideoFrame メモリ管理の最適化計画

## 概要

現在のVideoFrame管理は過剰なクローンが発生しており、GPUメモリを無駄に消費している。
本計画では「VideoFramePool」パターンを導入し、所有権ベースの管理に移行する。

## 1. 現状分析

### 1.1 現在のVideoFrameフロー

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           現在の VideoFrame フロー                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  [Capture]                [Editor]                    [Export]              │
│     │                        │                           │                  │
│  originals              clones (1st)            clones (2nd + 3rd)         │
│  in buffer           from handleCreateClip      from handleExport          │
│     │                        │                           │                  │
│     │──── clone() ──────────>│                           │                  │
│     │                        │──── clone() x2 ──────────>│                  │
│     │                        │                           │                  │
│  close() on         close() in cleanup()       close() in cleanup()        │
│  buffer eviction                                                            │
│                                                                             │
│  GPU Memory: 最大3倍消費 (1920x1080 で 300フレーム = 最大 9.6GB)            │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 クローン発生箇所

| 箇所 | ファイル:行 | 内容 |
|------|------------|------|
| handleCreateClip | `src/features/capture/index.js:377` | 全フレームをクローン |
| handleExport (1) | `src/features/editor/index.js:498-501` | 選択フレームをクローン |
| handleExport (2) | `src/features/editor/index.js:505-511` | 戻り用に全フレームを再クローン |

### 1.3 その他の非効率

| 箇所 | ファイル:行 | 内容 |
|------|------------|------|
| addFrame | `src/features/capture/core.js:43` | 毎フレーム配列全体をコピー O(n) |
| createAddFrameMessage | `src/workers/worker-protocol.js:153` | ArrayBufferを冗長コピー |

---

## 2. 提案する設計: VideoFramePool

### 2.1 コンセプト

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        提案: VideoFramePool 設計                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│                     ┌──────────────────────────┐                           │
│                     │   VideoFramePool         │                           │
│                     │   (shared/videoframe-    │                           │
│                     │    pool.js)              │                           │
│                     ├──────────────────────────┤                           │
│                     │ frames: Map<id, {        │                           │
│                     │   videoFrame: VideoFrame │                           │
│                     │   owners: Set<string>    │                           │
│                     │ }>                       │                           │
│                     │                          │                           │
│                     │ register(frame, owner)   │                           │
│                     │ acquire(frameId, owner)  │                           │
│                     │ release(frameId, owner)  │                           │
│                     │ releaseAll(owner)        │                           │
│                     └──────────────────────────┘                           │
│                          ▲     ▲      ▲                                    │
│                          │     │      │                                    │
│         ┌────────────────┘     │      └────────────────┐                  │
│         │                      │                       │                   │
│    [Capture]              [Editor]                [Export]                 │
│   owner="capture"       owner="editor"          owner="export"            │
│                                                                             │
│   → owners が空になったら自動で close()                                    │
│   → GPUメモリ: 1倍のみ (クローン不要)                                      │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 メリット

- **GPUメモリ 66% 削減**: クローン3回 → 0回
- **シンプルな所有権管理**: 各モジュールは acquire/release を呼ぶだけ
- **安全なクリーンアップ**: 最後の owner が release するまで close されない

---

## 3. 実装計画

### Phase 1: VideoFramePool の導入 (P0)

#### 3.1 新規ファイル作成

**`src/shared/videoframe-pool.js`**

```javascript
/**
 * @typedef {Object} PoolEntry
 * @property {VideoFrame} videoFrame
 * @property {Set<string>} owners
 */

/** @type {Map<string, PoolEntry>} */
const pool = new Map();

export function register(frameId, videoFrame, owner) { /* ... */ }
export function acquire(frameId, owner) { /* ... */ }
export function release(frameId, owner) { /* ... */ }
export function releaseAll(owner) { /* ... */ }
export function getFrame(frameId) { /* ... */ }
```

#### 3.2 Capture の変更

**`src/features/capture/index.js` - handleCreateClip**

変更前:
```javascript
const clonedFrames = frames.map((frame) => ({
  ...frame,
  frame: frame.frame.clone(),  // クローン
}));
```

変更後:
```javascript
import { acquire } from '../../shared/videoframe-pool.js';

// クローンせず、Editor を owner として追加
frames.forEach((frame) => acquire(frame.id, 'editor'));

setClipPayload({
  frames,  // オリジナルの参照を渡す
  fps: state.settings.fps,
  capturedAt: Date.now(),
});
```

#### 3.3 Editor の変更

**`src/features/editor/index.js` - handleExport**

変更前:
```javascript
// 2回クローン
const clonedForExport = selectedFrames.map((f) => ({ ...f, frame: f.frame.clone() }));
const clonedClipForReturn = { ...state.clip, frames: state.clip.frames.map(...) };
```

変更後:
```javascript
import { acquire, releaseAll } from '../../shared/videoframe-pool.js';

// クローンせず、Export を owner として追加
selectedFrames.forEach((frame) => acquire(frame.id, 'export'));

setEditorPayload({
  frames: selectedFrames,  // オリジナルの参照
  cropArea: state.cropArea,
  // clonedClipForReturn は不要 - Editor が frames を保持し続ける
  fps: state.clip.fps,
});
```

**`src/features/editor/index.js` - cleanup**

変更前:
```javascript
closeAllFrames(state.clip.frames);
```

変更後:
```javascript
releaseAll('editor');
```

#### 3.4 Export の変更

**cleanup で closeAllFrames の代わりに releaseAll('export') を呼ぶ**

---

### Phase 2: 循環バッファの最適化 (P2)

**`src/features/capture/core.js` - addFrame**

変更前:
```javascript
const newFrames = [...buffer.frames];  // O(n) コピー
```

変更後:
```javascript
// 配列はコピーせず、buffer オブジェクトのみ新規作成
// (React は buffer オブジェクトの参照変更で再レンダリングを検知)
buffer.frames[buffer.tail] = frame;  // インプレース更新
return {
  ...buffer,
  // frames は同じ参照を維持
  head: newHead,
  tail: newTail,
  size: newSize,
  totalMemoryBytes: newTotalMemoryBytes,
};
```

---

### Phase 3: ArrayBuffer 転送の最適化 (P3)

**`src/workers/worker-protocol.js` - createAddFrameMessage**

変更前:
```javascript
const buffer = rgba.buffer.slice(0);  // 冗長コピー
```

変更後:
```javascript
// 呼び出し元で不要になった場合、直接 Transfer
export function createAddFrameMessage(rgba, width, height, frameIndex, options = {}) {
  const buffer = options.transfer ? rgba.buffer : rgba.buffer.slice(0);
  return {
    message: { command: Commands.ADD_FRAME, rgbaData: buffer, width, height, frameIndex },
    transfer: [buffer],
  };
}
```

---

## 4. リスクと対策

| リスク | 影響度 | 対策 |
|--------|--------|------|
| 参照が残った状態で close される | 高 | Pool で owners 管理、owners.size === 0 のみ close |
| Export→Editor 戻り時にフレームが消える | 高 | Editor は owner のまま、Export cleanup 後も有効 |
| 配列の不変性が崩れて React 更新が効かない | 中 | buffer オブジェクトは新規作成し、frames 配列のみ共有 |
| テストが壊れる | 中 | videoframe-ownership.test.js を新モデルに更新 |

---

## 5. ユースケース検証

### 5.1 Clip 作成後に Capture を継続

```
提案後:
1. handleCreateClip() で Editor に所有権を追加
2. Capture は引き続き owner のまま → Capture 継続可能
3. バッファ evict 時: release('capture') → Editor がまだ owner なら close されない ✓
```

### 5.2 Export 失敗時の Editor 復帰

```
提案後:
1. Editor は frames を保持し続ける
2. Export cleanup で releaseAll('export')
3. Editor がまだ owner なので frames は close されない
4. Editor に戻ると同じ frames を使用可能 ✓
```

---

## 6. テスト計画

### 6.1 新規テスト

**`tests/unit/shared/videoframe-pool.test.js`**

- 複数 owner のサポート
- 最後の owner が release するまで close されない
- releaseAll で特定 owner の全フレームを解放

### 6.2 既存テストの更新

**`tests/unit/shared/videoframe-ownership.test.js`**

- clone() ベースの契約を acquire/release ベースに変更

---

## 7. 変更対象ファイル一覧

| ファイル | 変更内容 |
|---------|---------|
| `src/shared/videoframe-pool.js` | **新規作成** - Pool 実装 |
| `src/features/capture/index.js` | handleCreateClip を acquire ベースに変更 |
| `src/features/capture/core.js` | addFrame の配列コピー削除、evict 時に release 追加 |
| `src/features/editor/index.js` | handleExport のクローン削除、cleanup を releaseAll に変更 |
| `src/features/export/index.js` | cleanup を releaseAll に変更 |
| `src/workers/worker-protocol.js` | createAddFrameMessage に transfer オプション追加 |
| `tests/unit/shared/videoframe-pool.test.js` | **新規作成** - Pool テスト |
| `tests/unit/shared/videoframe-ownership.test.js` | 新モデルに更新 |

---

## 8. 実装優先度

| 優先度 | タスク | 効果 |
|--------|--------|------|
| **P0** | VideoFramePool 導入 + Capture/Editor/Export 変更 | GPU 66% 削減 |
| **P2** | 循環バッファの配列コピー最適化 | CPU 負荷軽減 |
| **P3** | ArrayBuffer 転送最適化 | Worker 転送時のコピー削減 |

---

## 承認事項

この計画を実装してよろしいですか？

- [ ] Phase 1 (VideoFramePool) を実装する
- [ ] Phase 2 (循環バッファ最適化) を実装する
- [ ] Phase 3 (ArrayBuffer最適化) を実装する
