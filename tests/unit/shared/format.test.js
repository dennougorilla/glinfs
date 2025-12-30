import { describe, it, expect } from 'vitest';
import {
  formatBytes,
  formatDuration,
  formatRemaining,
  formatPercent,
  formatTimestamp,
  formatCompactDuration,
} from '../../../src/shared/utils/format.js';

describe('formatBytes', () => {
  it('formats bytes correctly', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(500)).toBe('500 B');
  });

  it('formats kilobytes correctly', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(2560)).toBe('2.5 KB');
  });

  it('formats megabytes correctly', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.5 MB');
  });

  it('formats gigabytes correctly', () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB');
  });
});

describe('formatDuration', () => {
  it('formats seconds under a minute', () => {
    expect(formatDuration(5)).toBe('0:05');
    expect(formatDuration(30)).toBe('0:30');
    expect(formatDuration(59)).toBe('0:59');
  });

  it('formats minutes correctly', () => {
    expect(formatDuration(60)).toBe('1:00');
    expect(formatDuration(90)).toBe('1:30');
    expect(formatDuration(125)).toBe('2:05');
  });

  it('handles fractional seconds', () => {
    expect(formatDuration(5.7)).toBe('0:05');
  });
});

describe('formatRemaining', () => {
  it('formats very short times', () => {
    expect(formatRemaining(500)).toBe('Less than a second remaining');
  });

  it('formats seconds', () => {
    expect(formatRemaining(1000)).toBe('About 1 second remaining');
    expect(formatRemaining(5000)).toBe('About 5 seconds remaining');
  });

  it('formats minutes', () => {
    expect(formatRemaining(60000)).toBe('About 1 minute remaining');
    expect(formatRemaining(120000)).toBe('About 2 minutes remaining');
  });
});

describe('formatPercent', () => {
  it('formats percentages correctly', () => {
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(0.5)).toBe('50%');
    expect(formatPercent(1)).toBe('100%');
  });

  it('rounds to whole numbers', () => {
    expect(formatPercent(0.333)).toBe('33%');
    expect(formatPercent(0.666)).toBe('67%');
  });
});

describe('formatTimestamp', () => {
  it('returns ISO string', () => {
    const timestamp = Date.UTC(2025, 0, 1, 12, 0, 0);
    expect(formatTimestamp(timestamp)).toBe('2025-01-01T12:00:00.000Z');
  });
});

describe('formatCompactDuration', () => {
  it('formats zero seconds', () => {
    expect(formatCompactDuration(0)).toBe('0.0s');
  });

  it('formats fractional seconds', () => {
    expect(formatCompactDuration(1.5)).toBe('1.5s');
  });

  it('formats whole seconds with decimal', () => {
    expect(formatCompactDuration(10)).toBe('10.0s');
  });

  it('rounds to one decimal place', () => {
    expect(formatCompactDuration(10.123)).toBe('10.1s');
    expect(formatCompactDuration(10.156)).toBe('10.2s');
  });

  it('handles very small values', () => {
    expect(formatCompactDuration(0.03)).toBe('0.0s');
    expect(formatCompactDuration(0.05)).toBe('0.1s');
  });
});
