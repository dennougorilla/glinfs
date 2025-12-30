/**
 * Thumbnail Cache
 * LRU キャッシュによるサムネイル管理
 * @module shared/utils/thumbnail-cache
 */

/** @type {number} デフォルトキャッシュサイズ */
const DEFAULT_CACHE_SIZE = 300;

/** @type {number} デフォルトサムネイルサイズ */
const DEFAULT_THUMBNAIL_SIZE = 80;

/**
 * LRU Thumbnail Cache
 * OffscreenCanvas を使用した効率的なサムネイル生成
 */
export class ThumbnailCache {
  /**
   * @param {number} [maxSize=300] - 最大キャッシュエントリ数
   */
  constructor(maxSize = DEFAULT_CACHE_SIZE) {
    /** @type {Map<string, HTMLCanvasElement>} */
    this.cache = new Map();

    /** @type {number} */
    this.maxSize = maxSize;
  }

  /**
   * キャッシュからサムネイルを取得
   * @param {string} frameId - フレームID
   * @returns {HTMLCanvasElement | null}
   */
  get(frameId) {
    const cached = this.cache.get(frameId);
    if (cached) {
      // LRU: アクセスしたエントリを末尾に移動
      this.cache.delete(frameId);
      this.cache.set(frameId, cached);
      return cached;
    }
    return null;
  }

  /**
   * サムネイルが存在するかチェック
   * @param {string} frameId - フレームID
   * @returns {boolean}
   */
  has(frameId) {
    return this.cache.has(frameId);
  }

  /**
   * サムネイルを生成してキャッシュ
   * @param {import('../../features/capture/types.js').Frame} frame - フレーム
   * @param {number} [maxDimension=80] - 最大サイズ
   * @returns {Promise<HTMLCanvasElement>}
   */
  async generate(frame, maxDimension = DEFAULT_THUMBNAIL_SIZE) {
    // キャッシュにあれば返す
    const cached = this.get(frame.id);
    if (cached) return cached;

    // スケール計算
    const scale = Math.min(maxDimension / frame.width, maxDimension / frame.height);
    const thumbWidth = Math.round(frame.width * scale);
    const thumbHeight = Math.round(frame.height * scale);

    // OffscreenCanvas で描画（バックグラウンド処理可能）
    const offscreen = new OffscreenCanvas(thumbWidth, thumbHeight);
    const ctx = offscreen.getContext('2d');

    if (!ctx) {
      throw new Error('Failed to get OffscreenCanvas context');
    }

    if (!frame?.frame) {
      // 無効なフレームはプレースホルダー
      ctx.fillStyle = '#333';
      ctx.fillRect(0, 0, thumbWidth, thumbHeight);
    } else {
      ctx.drawImage(frame.frame, 0, 0, thumbWidth, thumbHeight);
    }

    // 通常の Canvas に変換（DOM 表示用）
    const canvas = document.createElement('canvas');
    canvas.width = thumbWidth;
    canvas.height = thumbHeight;
    const canvasCtx = canvas.getContext('2d');

    if (!canvasCtx) {
      throw new Error('Failed to get canvas context');
    }

    canvasCtx.drawImage(offscreen, 0, 0);

    // キャッシュに追加
    this._addToCache(frame.id, canvas);

    return canvas;
  }

  /**
   * 複数フレームのサムネイルをバッチ生成
   * requestIdleCallback で非ブロッキング処理
   * @param {import('../../features/capture/types.js').Frame[]} frames - フレーム配列
   * @param {number} [maxDimension=80] - 最大サイズ
   * @param {(progress: number) => void} [onProgress] - 進捗コールバック
   * @returns {Promise<void>}
   */
  async generateBatch(frames, maxDimension = DEFAULT_THUMBNAIL_SIZE, onProgress) {
    const uncached = frames.filter((f) => !this.cache.has(f.id));

    if (uncached.length === 0) {
      onProgress?.(100);
      return;
    }

    const BATCH_SIZE = 10;
    let processed = 0;

    for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
      const batch = uncached.slice(i, i + BATCH_SIZE);

      await Promise.all(batch.map((f) => this.generate(f, maxDimension)));

      processed += batch.length;
      onProgress?.(Math.round((processed / uncached.length) * 100));

      // メインスレッドに譲る
      await new Promise((resolve) => {
        if (typeof requestIdleCallback === 'function') {
          requestIdleCallback(resolve, { timeout: 16 });
        } else {
          setTimeout(resolve, 0);
        }
      });
    }
  }

  /**
   * キャッシュに追加（LRU）
   * @param {string} frameId
   * @param {HTMLCanvasElement} canvas
   * @private
   */
  _addToCache(frameId, canvas) {
    // LRU: 容量超過時は最古のエントリを削除
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(frameId, canvas);
  }

  /**
   * 特定フレームのキャッシュを無効化
   * @param {string} frameId
   */
  invalidate(frameId) {
    this.cache.delete(frameId);
  }

  /**
   * キャッシュをクリア
   */
  clear() {
    this.cache.clear();
  }

  /**
   * キャッシュサイズを取得
   * @returns {number}
   */
  get size() {
    return this.cache.size;
  }
}

/** @type {ThumbnailCache | null} */
let instance = null;

/**
 * シングルトンインスタンスを取得
 * @returns {ThumbnailCache}
 */
export function getThumbnailCache() {
  if (!instance) {
    instance = new ThumbnailCache();
  }
  return instance;
}

/**
 * シングルトンインスタンスをリセット（テスト用）
 */
export function resetThumbnailCache() {
  if (instance) {
    instance.clear();
    instance = null;
  }
}
