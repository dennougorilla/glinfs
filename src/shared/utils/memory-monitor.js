/**
 * Memory Monitor
 * リアルタイムメモリ監視とアラート
 * @module shared/utils/memory-monitor
 */

/** @type {number} 警告閾値 (MB) */
const WARNING_THRESHOLD_MB = 400;

/** @type {number} 危険閾値 (MB) */
const CRITICAL_THRESHOLD_MB = 500;

/**
 * メモリ状態レベル
 * @typedef {'normal' | 'warning' | 'critical'} MemoryLevel
 */

/**
 * メモリステータス
 * @typedef {Object} MemoryStatus
 * @property {number} usedMB - 使用中メモリ (MB)
 * @property {number} limitMB - 制限値 (MB)
 * @property {MemoryLevel} level - 状態レベル
 * @property {number} percent - 使用率 (0-100)
 */

/**
 * 現在のメモリステータスを取得
 * @returns {MemoryStatus | null} - performance.memory が利用できない場合は null
 */
export function getMemoryStatus() {
  // performance.memory は Chrome 限定 API
  // @ts-ignore - Chrome-specific API
  const memory = performance.memory;

  if (!memory) {
    return null;
  }

  const usedMB = memory.usedJSHeapSize / (1024 * 1024);
  const limitMB = memory.jsHeapSizeLimit / (1024 * 1024);
  const percent = Math.round((usedMB / limitMB) * 100);

  /** @type {MemoryLevel} */
  let level = 'normal';
  if (usedMB >= CRITICAL_THRESHOLD_MB) {
    level = 'critical';
  } else if (usedMB >= WARNING_THRESHOLD_MB) {
    level = 'warning';
  }

  return { usedMB, limitMB, level, percent };
}

/**
 * 定期的なメモリ監視を開始
 * @param {(status: MemoryStatus) => void} callback - ステータスコールバック
 * @param {number} [intervalMs=1000] - 監視間隔 (ms)
 * @returns {() => void} - 停止関数
 */
export function startMemoryMonitor(callback, intervalMs = 1000) {
  const interval = setInterval(() => {
    const status = getMemoryStatus();
    if (status) {
      callback(status);
    }
  }, intervalMs);

  return () => clearInterval(interval);
}

/**
 * VideoFrame バッファのメモリ使用量を推定
 * VideoFrame は GPU メモリに格納されるため、CPU メモリ使用量は少ない
 * @param {number} frameCount - フレーム数
 * @param {number} width - フレーム幅
 * @param {number} height - フレーム高さ
 * @returns {number} - 推定 MB
 */
export function estimateBufferMemory(frameCount, width, height) {
  // VideoFrame は GPU メモリに格納
  // CPU 側のオーバーヘッドは約 1/10
  const bytesPerFrame = (width * height * 4) / 10;
  return (frameCount * bytesPerFrame) / (1024 * 1024);
}

/**
 * メモリ使用量のフォーマット
 * @param {number} mb - メモリ (MB)
 * @returns {string}
 */
export function formatMemory(mb) {
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(2)} GB`;
  }
  return `${mb.toFixed(1)} MB`;
}

/**
 * メモリレベルに応じた色を取得
 * @param {MemoryLevel} level
 * @returns {string} - CSS 色
 */
export function getMemoryLevelColor(level) {
  switch (level) {
    case 'critical':
      return '#ff4444';
    case 'warning':
      return '#ffaa00';
    default:
      return '#44ff44';
  }
}

/**
 * メモリレベルに応じたメッセージを取得
 * @param {MemoryLevel} level
 * @returns {string}
 */
export function getMemoryLevelMessage(level) {
  switch (level) {
    case 'critical':
      return 'メモリ使用量が危険レベルです。録画を停止してください。';
    case 'warning':
      return 'メモリ使用量が増加しています。録画時間を短くすることを推奨します。';
    default:
      return 'メモリ使用量は正常です。';
  }
}

/**
 * 最大フレーム数を推定（メモリ制限に基づく）
 * @param {number} width - フレーム幅
 * @param {number} height - フレーム高さ
 * @param {number} [targetMemoryMB=400] - 目標メモリ使用量
 * @returns {number} - 推定最大フレーム数
 */
export function estimateMaxFrames(width, height, targetMemoryMB = WARNING_THRESHOLD_MB) {
  const bytesPerFrame = (width * height * 4) / 10;
  const targetBytes = targetMemoryMB * 1024 * 1024;
  return Math.floor(targetBytes / bytesPerFrame);
}
