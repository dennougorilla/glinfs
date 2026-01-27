# Scene Detection Usage Guide

新しく追加されたシーン検出アルゴリズムの使用方法

## 利用可能なアルゴリズム

現在、以下の3つのアルゴリズムが利用可能です:

### 1. Histogram (ヒストグラム比較法) - デフォルト
- **ID**: `histogram`
- **特徴**: 色分布の変化を検出
- **用途**: 一般的なシーン変化、照明変化の検出
- **速度**: ⭐⭐⭐⭐⭐ (非常に速い)
- **精度**: ⭐⭐⭐☆☆ (中程度)

### 2. Pixel Difference (ピクセル差分法)
- **ID**: `pixel-diff`
- **特徴**: フレーム間のピクセル差分を計算
- **用途**: ハードカット(急激なシーン変化)の検出
- **速度**: ⭐⭐⭐⭐⭐ (非常に速い)
- **精度**: ⭐⭐⭐☆☆ (中程度、カメラワークに敏感)

### 3. Edge Change Ratio (エッジ変化率法)
- **ID**: `edge-change`
- **特徴**: エッジ情報の変化を検出
- **用途**: カメラワークの多い動画、ロバストな検出
- **速度**: ⭐⭐⭐⭐☆ (速い)
- **精度**: ⭐⭐⭐⭐☆ (高い)

---

## プログラムからの使用方法

### 基本的な使い方

```javascript
import { createDetector } from './features/scene-detection/index.js';

// アルゴリズムを選択してdetectorを作成
const detector = createDetector('histogram');  // または 'pixel-diff', 'edge-change'

// シーン検出を実行
const scenes = detector.detect(frames, {
  threshold: 0.3,           // 検出感度 (アルゴリズムによって範囲が異なる)
  minSceneDuration: 5,      // 最小シーン長 (フレーム数)
  sampleInterval: 1         // サンプリング間隔 (1=全フレーム処理)
});

console.log(`Detected ${scenes.length} scenes`);
scenes.forEach(scene => {
  console.log(`Scene: frames ${scene.startFrame}-${scene.endFrame}, duration: ${scene.duration}s`);
});
```

### SceneDetectionManagerを使用する場合

```javascript
import { createSceneDetectionManager } from './features/scene-detection/index.js';

const manager = createSceneDetectionManager();

// 初期化時にアルゴリズムを指定
await manager.init({
  algorithmId: 'edge-change',  // 使用するアルゴリズム
  workerPath: '/workers/scene-detection-worker.js'
});

// 検出実行
const result = await manager.detect(frames, {
  threshold: 0.5,
  minSceneDuration: 5,
  onProgress: (progress) => {
    console.log(`Progress: ${progress.percent}%`);
  }
});

console.log(`Processing time: ${result.processingTimeMs}ms`);
console.log(`Algorithm used: ${result.algorithmId}`);
```

---

## アルゴリズム別の推奨パラメータ

### Histogram

```javascript
{
  threshold: 0.3,           // 0.2-0.5 (低いほど敏感)
  minSceneDuration: 5,      // 5-10フレーム
  sampleInterval: 1         // 1-2
}
```

**用途**:
- 一般的な動画
- 照明変化が多いシーン
- バランス型の検出

**避けるべきケース**:
- カメラワーク(パン/ズーム)が多い動画
- 類似色の連続シーン

---

### Pixel Difference

```javascript
{
  threshold: 0.20,          // 0.15-0.25 (低いほど敏感)
  minSceneDuration: 5,      // 5-10フレーム
  sampleInterval: 1         // 1-2
}
```

**用途**:
- ハードカット(急激な切り替え)が主な動画
- 編集済み動画
- 高速処理が必要な場合

**避けるべきケース**:
- カメラワークが多い動画
- ディゾルブやフェード等のトランジション
- 段階的な変化

---

### Edge Change Ratio

```javascript
{
  threshold: 0.5,           // 0.4-0.6 (低いほど敏感)
  edgeThreshold: 30,        // 20-50 (エッジ検出の感度)
  minSceneDuration: 5,      // 5-10フレーム
  sampleInterval: 1         // 1-2
}
```

**用途**:
- カメラワークが多い動画
- 高精度な検出が必要な場合
- 誤検出を減らしたい場合

**特記事項**:
- 他のアルゴリズムより計算コストがやや高い
- `edgeThreshold`でエッジ検出の感度を調整可能

---

## パフォーマンス最適化

### 高速化のテクニック

1. **サンプリング間隔を増やす**
   ```javascript
   { sampleInterval: 2 }  // 2フレームごとに処理 → 約2倍高速
   ```

2. **最小シーン長を大きくする**
   ```javascript
   { minSceneDuration: 10 }  // 後処理が減る → わずかに高速化
   ```

3. **高速アルゴリズムを選択**
   ```javascript
   const detector = createDetector('pixel-diff');  // 最速
   ```

### 精度向上のテクニック

1. **全フレームを処理**
   ```javascript
   { sampleInterval: 1 }
   ```

2. **閾値を調整**
   ```javascript
   // より敏感に検出
   { threshold: 0.2 }  // histogram/pixel-diff
   { threshold: 0.4 }  // edge-change
   ```

3. **高精度アルゴリズムを選択**
   ```javascript
   const detector = createDetector('edge-change');  // 最も精度が高い
   ```

---

## 複数アルゴリズムの比較実行

```javascript
import { createDetector } from './features/scene-detection/index.js';

const algorithmIds = ['histogram', 'pixel-diff', 'edge-change'];
const results = [];

for (const algorithmId of algorithmIds) {
  const detector = createDetector(algorithmId);
  const startTime = performance.now();

  const scenes = detector.detect(frames, detector.getDefaultOptions());
  const processingTime = performance.now() - startTime;

  results.push({
    algorithmId,
    sceneCount: scenes.length,
    processingTime,
    scenes
  });
}

// 結果を比較
console.table(results.map(r => ({
  Algorithm: r.algorithmId,
  'Scene Count': r.sceneCount,
  'Time (ms)': Math.round(r.processingTime)
})));

// 詳細比較
results.forEach(result => {
  console.log(`\n=== ${result.algorithmId} ===`);
  console.log(`Detected ${result.sceneCount} scenes in ${Math.round(result.processingTime)}ms`);
  result.scenes.forEach((scene, i) => {
    console.log(`  Scene ${i + 1}: ${scene.startFrame}-${scene.endFrame} (${scene.duration}s)`);
  });
});
```

---

## UIでのアルゴリズム選択

アプリケーションのキャプチャ設定にアルゴリズム選択機能を追加する場合:

```javascript
// CaptureSettings に追加
const captureSettings = {
  // 既存の設定...
  sceneDetectionEnabled: true,
  sceneDetectionAlgorithm: 'histogram',  // 'histogram' | 'pixel-diff' | 'edge-change'
  sceneDetectionOptions: {
    threshold: 0.3,
    minSceneDuration: 5,
    sampleInterval: 1
  }
};

// Loading画面での使用
const manager = createSceneDetectionManager();
await manager.init({
  algorithmId: captureSettings.sceneDetectionAlgorithm,
  workerPath: '/workers/scene-detection-worker.js'
});

const result = await manager.detect(frames, captureSettings.sceneDetectionOptions);
```

### 設定UI例 (HTML)

```html
<div class="scene-detection-settings">
  <label>
    <input type="checkbox" id="sceneDetectionEnabled" checked />
    シーン検出を有効化
  </label>

  <label>
    アルゴリズム:
    <select id="sceneDetectionAlgorithm">
      <option value="histogram" selected>Histogram (バランス型)</option>
      <option value="pixel-diff">Pixel Difference (高速)</option>
      <option value="edge-change">Edge Change (高精度)</option>
    </select>
  </label>

  <label>
    検出感度:
    <input type="range" id="threshold" min="0.1" max="1.0" step="0.05" value="0.3" />
    <span id="thresholdValue">0.3</span>
  </label>

  <label>
    最小シーン長:
    <input type="number" id="minSceneDuration" min="1" max="30" value="5" />
    フレーム
  </label>
</div>
```

---

## トラブルシューティング

### 検出されるシーンが多すぎる

**原因**: 閾値が低すぎる、またはカメラワークに敏感なアルゴリズムを使用

**解決策**:
1. 閾値を上げる
   ```javascript
   { threshold: 0.4 }  // histogram/pixel-diff
   { threshold: 0.6 }  // edge-change
   ```

2. Edge Change Ratioアルゴリズムを使用
   ```javascript
   const detector = createDetector('edge-change');
   ```

3. 最小シーン長を増やす
   ```javascript
   { minSceneDuration: 10 }
   ```

### 検出されるシーンが少なすぎる

**原因**: 閾値が高すぎる

**解決策**:
1. 閾値を下げる
   ```javascript
   { threshold: 0.2 }  // histogram/pixel-diff
   { threshold: 0.4 }  // edge-change
   ```

2. サンプリング間隔を減らす
   ```javascript
   { sampleInterval: 1 }
   ```

### 処理が遅い

**原因**: 大量のフレーム、または重いアルゴリズムを使用

**解決策**:
1. サンプリング間隔を増やす
   ```javascript
   { sampleInterval: 2 }
   ```

2. 高速アルゴリズムを使用
   ```javascript
   const detector = createDetector('pixel-diff');
   ```

3. Web Workerを使用 (メインスレッドをブロックしない)
   ```javascript
   const manager = createSceneDetectionManager();
   ```

### カメラワークで誤検出が多い

**原因**: Pixel DifferenceやHistogramはカメラワークに敏感

**解決策**:
1. Edge Change Ratioアルゴリズムを使用
   ```javascript
   const detector = createDetector('edge-change');
   ```

2. 閾値を上げる
   ```javascript
   { threshold: 0.4 }  // pixel-diff/histogram
   { threshold: 0.6 }  // edge-change
   ```

---

## パラメータ情報の取得

各アルゴリズムの推奨パラメータ情報を取得:

```javascript
const detector = createDetector('edge-change');

// デフォルトオプション
const defaultOptions = detector.getDefaultOptions();
console.log(defaultOptions);
// { threshold: 0.5, edgeThreshold: 30, minSceneDuration: 5, sampleInterval: 1 }

// パラメータ定義(UI構築用)
const parameters = detector.getParameters();
parameters.forEach(param => {
  console.log(`${param.label}: ${param.default}`);
  console.log(`  Range: ${param.min}-${param.max}, Step: ${param.step}`);
  console.log(`  Description: ${param.description}`);
});
```

---

## 今後の拡張

### 新しいアルゴリズムの追加方法

1. **新しいdetectorファイルを作成**
   ```
   src/features/scene-detection/algorithms/your-detector.js
   ```

2. **Detector interfaceを実装**
   ```javascript
   export function createYourDetector(config = {}) {
     return {
       id: 'your-algorithm',
       name: 'Your Algorithm Name',
       description: 'Description...',
       detect(frames, options) {
         // 実装...
         return scenes;
       },
       getDefaultOptions() {
         return { threshold: 0.5 };
       },
       getParameters() {
         return [/* parameter definitions */];
       }
     };
   }
   ```

3. **Registryに登録**
   ```javascript
   // src/features/scene-detection/index.js
   import { createYourDetector } from './algorithms/your-detector.js';

   export function initSceneDetection() {
     // 既存の登録...
     registerDetector('your-algorithm', createYourDetector);
   }
   ```

4. **利用可能に**
   ```javascript
   const detector = createDetector('your-algorithm');
   ```

---

## コンテンツタイプ別の推奨設定

### 🎨 アニメ・アニメーション (最推奨: Histogram)

**特徴**:
- 色分布が明確で均一
- ハードカットが多い
- エッジ（輪郭線）がはっきり
- カメラワークが控えめ
- ノイズが少ない

**推奨アルゴリズム 1位: Histogram** ⭐⭐⭐⭐⭐

```javascript
const detector = createDetector('histogram');
const scenes = detector.detect(frames, {
  threshold: 0.25,         // やや低め（色変化が明確なので敏感に）
  minSceneDuration: 3,     // アニメはカットが短いことが多い
  sampleInterval: 1        // 全フレーム処理
});
```

**理由**:
- ✅ アニメの色分布変化を正確に捉える
- ✅ シーン変化時の色の変化が顕著
- ✅ カメラワークが少ないため誤検出が少ない
- ✅ 非常に高速
- ✅ 背景色の変化も確実に検出

**推奨アルゴリズム 2位: Pixel Difference** (高速処理が必要な場合)

```javascript
const detector = createDetector('pixel-diff');
const scenes = detector.detect(frames, {
  threshold: 0.18,         // やや低め
  minSceneDuration: 3,
  sampleInterval: 1
});
```

**理由**:
- ✅ ハードカットが多いアニメに最適
- ✅ 最速の処理速度
- ⚠️ アクションシーン（動きが激しい）で誤検出の可能性

**推奨アルゴリズム 3位: Edge Change** (アクションアニメ向け)

```javascript
const detector = createDetector('edge-change');
const scenes = detector.detect(frames, {
  threshold: 0.45,         // やや低め
  edgeThreshold: 25,       // 輪郭線が明確なので低めでOK
  minSceneDuration: 3,
  sampleInterval: 1
});
```

**理由**:
- ✅ キャラクターの動きが激しいアクションシーンに強い
- ✅ パンやズームが多いシーンでも安定
- ❌ やや計算コストが高い

**アニメ向け設定例**:

```javascript
// 一般的なアニメ（日常系、コメディなど）
{
  algorithmId: 'histogram',
  threshold: 0.25,
  minSceneDuration: 3,
  sampleInterval: 1
}

// アクションアニメ（バトル、スポーツなど）
{
  algorithmId: 'edge-change',
  threshold: 0.45,
  edgeThreshold: 25,
  minSceneDuration: 3,
  sampleInterval: 1
}

// 長時間アニメ（高速処理優先）
{
  algorithmId: 'pixel-diff',
  threshold: 0.18,
  minSceneDuration: 3,
  sampleInterval: 2  // 2フレームごとに処理して高速化
}
```

---

### 🎬 実写映画・ドラマ (最推奨: Edge Change)

**特徴**:
- カメラワーク（パン、ズーム）が多い
- 照明変化がある
- ディゾルブやフェード等のトランジション
- 色分布が複雑

**推奨アルゴリズム: Edge Change** ⭐⭐⭐⭐⭐

```javascript
const detector = createDetector('edge-change');
const scenes = detector.detect(frames, {
  threshold: 0.5,          // デフォルト
  edgeThreshold: 30,       // デフォルト
  minSceneDuration: 10,    // 長めに設定（カット編集が少ない）
  sampleInterval: 1
});
```

**理由**:
- ✅ カメラワークによる誤検出が少ない
- ✅ 照明変化に比較的ロバスト
- ✅ 高精度

**代替: Histogram** (バランス型)

```javascript
const detector = createDetector('histogram');
const scenes = detector.detect(frames, {
  threshold: 0.35,         // やや高め（誤検出を減らす）
  minSceneDuration: 10,
  sampleInterval: 1
});
```

---

### ⚽ スポーツ映像 (最推奨: Edge Change)

**特徴**:
- カメラの動きが非常に激しい（追従、ズーム）
- 類似した色の連続（グラウンド、ユニフォーム）
- 急激な動き

**推奨アルゴリズム: Edge Change** ⭐⭐⭐⭐⭐

```javascript
const detector = createDetector('edge-change');
const scenes = detector.detect(frames, {
  threshold: 0.6,          // 高め（誤検出を防ぐ）
  edgeThreshold: 35,       // やや高め
  minSceneDuration: 15,    // 長め（カメラワークでの誤検出を防ぐ）
  sampleInterval: 1
});
```

**理由**:
- ✅ カメラワークに最も強い
- ✅ 構造的な変化（フィールド→観客席など）を検出
- ❌ HistogramやPixel Diffは誤検出が多すぎる

---

### 📹 ゲーム実況・配信 (最推奨: Histogram or Pixel Diff)

**特徴**:
- ゲーム内シーンは色分布が明確（3DCG）
- ハードカットが多い（メニュー切替、マップ切替）
- カメラワークは中程度

**推奨アルゴリズム: Histogram** ⭐⭐⭐⭐⭐

```javascript
const detector = createDetector('histogram');
const scenes = detector.detect(frames, {
  threshold: 0.3,          // デフォルト
  minSceneDuration: 5,
  sampleInterval: 1
});
```

**代替: Pixel Difference** (高速処理向け)

```javascript
const detector = createDetector('pixel-diff');
const scenes = detector.detect(frames, {
  threshold: 0.20,
  minSceneDuration: 5,
  sampleInterval: 2  // 高速化
});
```

---

### 🎤 プレゼンテーション・講義 (最推奨: Histogram)

**特徴**:
- スライド切替が明確
- 色の変化が大きい
- カメラの動きが少ない

**推奨アルゴリズム: Histogram** ⭐⭐⭐⭐⭐

```javascript
const detector = createDetector('histogram');
const scenes = detector.detect(frames, {
  threshold: 0.25,         // 低め（スライド変化を確実に捉える）
  minSceneDuration: 10,    // スライドは数秒表示されるので長め
  sampleInterval: 2        // 高速化（変化が少ないので）
});
```

---

### 🎥 ドキュメンタリー (最推奨: Edge Change)

**特徴**:
- カメラワークが多い（手持ちカメラ）
- 照明変化が激しい（屋外・屋内）
- ゆっくりとしたシーン展開

**推奨アルゴリズム: Edge Change** ⭐⭐⭐⭐⭐

```javascript
const detector = createDetector('edge-change');
const scenes = detector.detect(frames, {
  threshold: 0.55,         // やや高め
  edgeThreshold: 30,
  minSceneDuration: 15,    // 長め（ゆっくりとした展開）
  sampleInterval: 1
});
```

---

### 📺 ニュース番組 (最推奨: Histogram)

**特徴**:
- スタジオとVTRの切替が明確
- カメラワークが少ない
- 色分布の変化が明確

**推奨アルゴリズム: Histogram** ⭐⭐⭐⭐⭐

```javascript
const detector = createDetector('histogram');
const scenes = detector.detect(frames, {
  threshold: 0.28,
  minSceneDuration: 8,
  sampleInterval: 1
});
```

---

## 簡易選択ガイド

```
動画タイプを選んでください:

1. アニメ・3DCGアニメ
   → Histogram (threshold: 0.25, minSceneDuration: 3)

2. 実写映画・ドラマ
   → Edge Change (threshold: 0.5, minSceneDuration: 10)

3. スポーツ映像
   → Edge Change (threshold: 0.6, minSceneDuration: 15)

4. ゲーム実況・配信
   → Histogram (threshold: 0.3, minSceneDuration: 5)

5. プレゼン・講義
   → Histogram (threshold: 0.25, minSceneDuration: 10, sampleInterval: 2)

6. ドキュメンタリー
   → Edge Change (threshold: 0.55, minSceneDuration: 15)

7. ニュース番組
   → Histogram (threshold: 0.28, minSceneDuration: 8)

8. わからない・混合
   → Histogram (threshold: 0.3, minSceneDuration: 5) [デフォルト]
```

---

## 参考情報

- アルゴリズム詳細: `src/features/scene-detection/ALGORITHMS.md`
- 実装コード: `src/features/scene-detection/algorithms/`
- Type定義: `src/features/scene-detection/types.js`
