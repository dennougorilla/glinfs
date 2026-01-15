# Scene Detection Algorithms

シーン検出アルゴリズムの比較と特性一覧

## 現在実装済み

### 1. Histogram-based Detection (ヒストグラム比較法)
**実装状態**: ✅ 実装済み (`histogram-detector.js`)

**アルゴリズム概要**:
- RGB各チャンネルを64ビンに分割してヒストグラムを計算
- カイ二乗距離で連続フレーム間のヒストグラムを比較
- 閾値を超えたらシーン変化と判定

**特性**:
- ✅ 軽量・高速
- ✅ 色分布の変化に敏感
- ✅ 照明変化の検出に強い
- ❌ カメラの動き(パン/ズーム)に誤検出しやすい
- ❌ 空間的な情報を無視

**パラメータ**:
- `threshold`: 0.3 (デフォルト) - 変化感度
- `minSceneDuration`: 5フレーム - 最小シーン長
- `sampleInterval`: 1 - サンプリング間隔

**計算量**: O(n × bins) - n=フレーム数, bins=192 (64×3チャンネル)
**メモリ**: 低 (Float32Array × フレーム数)

---

## 実装候補アルゴリズム

### 2. Pixel Difference (ピクセル差分法)
**実装状態**: ❌ 未実装

**アルゴリズム概要**:
- フレーム間のピクセル値を直接比較
- MAD (Mean Absolute Difference) または MSE (Mean Squared Error) を計算
- 閾値を超えたらシーン変化と判定

**特性**:
- ✅ シンプルで実装が容易
- ✅ 急激な変化に敏感
- ✅ カット検出に最適
- ❌ 段階的な変化(ディゾルブ等)に弱い
- ❌ カメラの動きに非常に敏感(誤検出多い)

**推奨パラメータ**:
- `threshold`: 0.15-0.25 - ピクセル差分の割合
- `downscale`: 64×64 - 処理速度向上のため

**計算量**: O(n × pixels) - pixels=64×64=4096
**メモリ**: 低 (前フレームのみ保持)

**実装難易度**: ⭐☆☆☆☆ (簡単)

---

### 3. Edge Change Ratio (エッジ変化率法)
**実装状態**: ❌ 未実装

**アルゴリズム概要**:
- Sobelフィルタ等でエッジを検出
- フレーム間のエッジ情報の変化率を計算
- エッジが大きく変化したらシーン変化と判定

**特性**:
- ✅ 構造的な変化の検出に優れる
- ✅ 照明変化に比較的ロバスト
- ✅ カメラの動きによる誤検出が少ない
- ❌ 計算コストがやや高い
- ⚠️ 類似した構造の場面で見逃しあり

**推奨パラメータ**:
- `threshold`: 0.4-0.6 - エッジ変化率
- `edgeThreshold`: 30 - エッジ検出の閾値

**計算量**: O(n × pixels × kernel) - kernel=Sobel 3×3
**メモリ**: 中 (エッジマップ保持)

**実装難易度**: ⭐⭐⭐☆☆ (中程度)

---

### 4. Optical Flow (オプティカルフロー法)
**実装状態**: ❌ 未実装

**アルゴリズム概要**:
- フレーム間の動きベクトルを計算
- 大部分のピクセルで動きベクトルが不連続になったらシーン変化

**特性**:
- ✅ カメラワークとシーン変化を区別可能
- ✅ 高精度なシーン検出
- ❌ 計算コストが非常に高い
- ❌ リアルタイム処理には不向き

**推奨パラメータ**:
- `motionThreshold`: 50% - 動きベクトルの変化割合
- `blockSize`: 8×8 - ブロックマッチングサイズ

**計算量**: O(n × pixels × search_range)
**メモリ**: 高 (動きベクトルフィールド)

**実装難易度**: ⭐⭐⭐⭐☆ (難しい)

---

### 5. DCT-based Detection (DCT係数比較法)
**実装状態**: ❌ 未実装

**アルゴリズム概要**:
- 離散コサイン変換(DCT)で周波数領域に変換
- DC成分(平均輝度)とAC成分(詳細情報)を比較
- 周波数特性の変化でシーン検出

**特性**:
- ✅ 圧縮動画との相性が良い(JPEG/H.264ではDCTベース)
- ✅ ノイズに強い
- ⚠️ 実装が複雑
- ⚠️ 閾値調整が難しい

**推奨パラメータ**:
- `dcThreshold`: 0.3 - DC成分の変化
- `acThreshold`: 0.5 - AC成分の変化
- `blockSize`: 8×8 - DCTブロックサイズ

**計算量**: O(n × blocks × N²log(N)) - N=blockSize
**メモリ**: 中

**実装難易度**: ⭐⭐⭐⭐☆ (難しい)

---

### 6. SSIM-based Detection (構造類似性指標法)
**実装状態**: ❌ 未実装

**アルゴリズム概要**:
- SSIM (Structural Similarity Index) でフレーム類似度を計算
- 輝度、コントラスト、構造の3要素を比較
- SSIMが低下したらシーン変化

**特性**:
- ✅ 人間の視覚特性に近い評価
- ✅ 高精度なシーン検出
- ✅ 段階的な変化も検出可能
- ❌ 計算コストが高い

**推奨パラメータ**:
- `threshold`: 0.7-0.8 - SSIM類似度(低いほど変化)
- `windowSize`: 11×11 - 比較ウィンドウサイズ

**計算量**: O(n × pixels × window²)
**メモリ**: 中

**実装難易度**: ⭐⭐⭐☆☆ (中程度)

---

### 7. Machine Learning-based (機械学習ベース)
**実装状態**: ❌ 未実装

**アルゴリズム概要**:
- 事前学習済みモデル(CNN等)で特徴抽出
- 特徴ベクトルの類似度でシーン判定
- またはシーン境界を直接予測

**特性**:
- ✅ 最高精度
- ✅ 複雑なシーン変化も検出可能
- ❌ モデルサイズが大きい(数MB~数十MB)
- ❌ 推論コストが高い
- ❌ 学習データが必要

**実装オプション**:
- TensorFlow.js + MobileNet
- ONNX Runtime Web + ResNet
- MediaPipe

**計算量**: O(n × model_complexity)
**メモリ**: 高 (モデルパラメータ)

**実装難易度**: ⭐⭐⭐⭐⭐ (非常に難しい)

---

## ハイブリッドアプローチ

### 8. Multi-Algorithm Fusion (複合アルゴリズム)
**実装状態**: ❌ 未実装

**アルゴリズム概要**:
- 複数のアルゴリズムを組み合わせ
- 投票制または重み付け平均でシーン判定
- 例: Histogram + Pixel Diff + Edge Change

**特性**:
- ✅ 高精度・低誤検出
- ✅ 様々なシーン変化に対応
- ❌ 計算コストが高い
- ⚠️ パラメータ調整が複雑

**推奨構成**:
- Fast pass: Pixel Diff (粗検出)
- Verification: Histogram + Edge Change (精査)

**実装難易度**: ⭐⭐⭐⭐☆ (難しい)

---

## ライブラリ/WASM オプション

### 利用可能なライブラリ

#### 1. **FFmpeg.wasm**
- **URL**: https://github.com/ffmpegwasm/ffmpeg.wasm
- **機能**: ffmpegの全機能をブラウザで実行
- **シーン検出**: `select` フィルタで実装可能
- **サイズ**: ~31MB (Core) / ~25MB (MT)
- **pros**: 高精度、多機能
- **cons**: 非常に大きい、オーバースペック

#### 2. **OpenCV.js**
- **URL**: https://docs.opencv.org/4.x/d5/d10/tutorial_js_root.html
- **機能**: 画像処理の全般機能
- **シーン検出**: Histogram, Edge, Optical Flow 等実装可能
- **サイズ**: ~8MB
- **pros**: 豊富なアルゴリズム、高速
- **cons**: サイズが大きい

#### 3. **TensorFlow.js**
- **URL**: https://www.tensorflow.org/js
- **機能**: 機械学習モデルの実行
- **シーン検出**: 特徴抽出ベースの検出
- **サイズ**: ~500KB (core) + モデルサイズ
- **pros**: 高精度、カスタムモデル可能
- **cons**: 学習コスト、推論速度

#### 4. **手動実装 (Pure JavaScript)**
- **サイズ**: ~5-20KB (アルゴリズム次第)
- **pros**: 軽量、カスタマイズ自由
- **cons**: 実装工数、最適化が必要

---

## 推奨実装順序

### Phase 1: 基本アルゴリズム追加 (優先度: 高)
1. ✅ **Histogram-based** (実装済み)
2. ❌ **Pixel Difference** - 最もシンプル、カット検出に有効
3. ❌ **Edge Change Ratio** - ロバスト性向上

### Phase 2: 高度なアルゴリズム (優先度: 中)
4. ❌ **SSIM-based** - 精度向上
5. ❌ **Hybrid (Pixel + Histogram + Edge)** - バランス重視

### Phase 3: 最先端技術 (優先度: 低)
6. ❌ **Optical Flow** - 最高精度(重い)
7. ❌ **ML-based** - 実験的

---

## パフォーマンス比較 (予測値)

| アルゴリズム | 速度 | 精度 | メモリ | 実装難易度 | 推奨度 |
|------------|------|------|--------|-----------|--------|
| Histogram | ⭐⭐⭐⭐⭐ | ⭐⭐⭐☆☆ | ⭐⭐⭐⭐⭐ | ⭐☆☆☆☆ | ⭐⭐⭐⭐☆ |
| Pixel Diff | ⭐⭐⭐⭐⭐ | ⭐⭐⭐☆☆ | ⭐⭐⭐⭐⭐ | ⭐☆☆☆☆ | ⭐⭐⭐⭐☆ |
| Edge Change | ⭐⭐⭐⭐☆ | ⭐⭐⭐⭐☆ | ⭐⭐⭐⭐☆ | ⭐⭐⭐☆☆ | ⭐⭐⭐⭐⭐ |
| SSIM | ⭐⭐⭐☆☆ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐☆☆ | ⭐⭐⭐☆☆ | ⭐⭐⭐⭐☆ |
| Optical Flow | ⭐⭐☆☆☆ | ⭐⭐⭐⭐⭐ | ⭐⭐☆☆☆ | ⭐⭐⭐⭐☆ | ⭐⭐☆☆☆ |
| DCT-based | ⭐⭐⭐☆☆ | ⭐⭐⭐⭐☆ | ⭐⭐⭐☆☆ | ⭐⭐⭐⭐☆ | ⭐⭐⭐☆☆ |
| ML-based | ⭐⭐☆☆☆ | ⭐⭐⭐⭐⭐ | ⭐☆☆☆☆ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐☆☆ |
| Hybrid | ⭐⭐⭐☆☆ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐☆☆ | ⭐⭐⭐⭐☆ | ⭐⭐⭐⭐⭐ |

---

## 使い分けガイド

### シナリオ別推奨アルゴリズム

**1. リアルタイム処理が必要 (速度重視)**
- Pixel Difference または Histogram
- サンプリング間隔を増やす (sampleInterval=2-5)

**2. 高精度が必要 (品質重視)**
- SSIM または Hybrid (Histogram + Edge)
- 全フレーム処理 (sampleInterval=1)

**3. バランス型 (実用的)**
- Edge Change Ratio
- または Histogram (現在の実装)

**4. カメラワークが多い動画**
- Edge Change Ratio または Optical Flow
- Histogramは誤検出が多い

**5. 段階的変化を検出したい (ディゾルブ等)**
- SSIM または ML-based
- Pixel Diffは不向き

---

## 次のステップ

### 実装提案

**Option A: Pure JavaScript実装 (推奨)**
- Pixel Difference を実装
- Edge Change Ratioを実装
- 軽量・依存なし・カスタマイズ容易

**Option B: ライブラリ使用**
- OpenCV.jsを統合 (多機能だが8MB)
- 複数アルゴリズムが一度に利用可能

**Option C: ハイブリッド**
- 基本アルゴリズムはPure JS
- 高度な機能はWebAssembly

### 実装時の考慮事項

1. **Registryパターンの活用**
   - 既存の`registry.js`に新アルゴリズムを登録
   - UIで選択可能にする

2. **Worker対応**
   - すべてのアルゴリズムをWorkerで実行
   - メインスレッドをブロックしない

3. **パラメータチューニング**
   - 各アルゴリズムの閾値を調整可能に
   - プリセット提供 (Fast/Balanced/Accurate)

4. **評価指標**
   - Ground truthデータでF1スコア測定
   - 処理時間の計測

---

## 参考文献

- Lienhart, R. (2001). "Comparison of automatic shot boundary detection algorithms"
- Wang, Z. et al. (2004). "Image quality assessment: from error visibility to structural similarity" (SSIM)
- Gygli, M. et al. (2014). "Creating Summaries from User Videos" (ML-based)
- PySceneDetect documentation: https://www.scenedetect.com/
