import { describe, it, expect } from 'vitest';

/**
 * Calculate grid line positions for rule of thirds
 * @param {{ x: number, y: number, width: number, height: number }} area
 * @param {number} divisions
 * @returns {{ vertical: number[], horizontal: number[] }}
 */
function calculateGridLines(area, divisions = 3) {
  const cellWidth = area.width / divisions;
  const cellHeight = area.height / divisions;

  const vertical = [];
  const horizontal = [];

  for (let i = 1; i < divisions; i++) {
    vertical.push(area.x + i * cellWidth);
    horizontal.push(area.y + i * cellHeight);
  }

  return { vertical, horizontal };
}

describe('Grid Alignment Calculation (US2)', () => {
  describe('rule of thirds positioning', () => {
    it('calculates correct grid lines for full frame', () => {
      const area = { x: 0, y: 0, width: 1920, height: 1080 };

      const lines = calculateGridLines(area, 3);

      // Vertical lines at 1/3 and 2/3 of width
      expect(lines.vertical[0]).toBeCloseTo(640, 0); // 1920 / 3
      expect(lines.vertical[1]).toBeCloseTo(1280, 0); // 1920 * 2 / 3

      // Horizontal lines at 1/3 and 2/3 of height
      expect(lines.horizontal[0]).toBeCloseTo(360, 0); // 1080 / 3
      expect(lines.horizontal[1]).toBeCloseTo(720, 0); // 1080 * 2 / 3
    });

    it('calculates grid lines for crop area', () => {
      const area = { x: 100, y: 50, width: 600, height: 400 };

      const lines = calculateGridLines(area, 3);

      // Vertical lines relative to crop area
      expect(lines.vertical[0]).toBeCloseTo(300, 0); // 100 + 600/3 = 300
      expect(lines.vertical[1]).toBeCloseTo(500, 0); // 100 + 600*2/3 = 500

      // Horizontal lines relative to crop area
      expect(lines.horizontal[0]).toBeCloseTo(183.33, 0); // 50 + 400/3
      expect(lines.horizontal[1]).toBeCloseTo(316.67, 0); // 50 + 400*2/3
    });

    it('produces 2 lines for 3 divisions', () => {
      const area = { x: 0, y: 0, width: 300, height: 300 };

      const lines = calculateGridLines(area, 3);

      expect(lines.vertical).toHaveLength(2);
      expect(lines.horizontal).toHaveLength(2);
    });

    it('produces correct lines for 6 divisions', () => {
      const area = { x: 0, y: 0, width: 600, height: 600 };

      const lines = calculateGridLines(area, 6);

      expect(lines.vertical).toHaveLength(5);
      expect(lines.horizontal).toHaveLength(5);

      expect(lines.vertical[0]).toBe(100);
      expect(lines.vertical[1]).toBe(200);
      expect(lines.vertical[2]).toBe(300);
      expect(lines.vertical[3]).toBe(400);
      expect(lines.vertical[4]).toBe(500);
    });
  });

  describe('grid within visible preview', () => {
    it('grid lines stay within preview bounds', () => {
      const previewArea = { x: 50, y: 50, width: 800, height: 600 };

      const lines = calculateGridLines(previewArea, 3);

      // All vertical lines should be within preview x bounds
      for (const x of lines.vertical) {
        expect(x).toBeGreaterThan(previewArea.x);
        expect(x).toBeLessThan(previewArea.x + previewArea.width);
      }

      // All horizontal lines should be within preview y bounds
      for (const y of lines.horizontal) {
        expect(y).toBeGreaterThan(previewArea.y);
        expect(y).toBeLessThan(previewArea.y + previewArea.height);
      }
    });

    it('grid aligns with crop area when cropping', () => {
      const frameArea = { x: 0, y: 0, width: 1920, height: 1080 };
      const cropArea = { x: 200, y: 100, width: 800, height: 600 };

      const frameLines = calculateGridLines(frameArea, 3);
      const cropLines = calculateGridLines(cropArea, 3);

      // Grid lines should be different for crop vs full frame
      expect(cropLines.vertical[0]).not.toBe(frameLines.vertical[0]);
      expect(cropLines.horizontal[0]).not.toBe(frameLines.horizontal[0]);

      // Crop grid should be within crop area
      expect(cropLines.vertical[0]).toBeGreaterThan(cropArea.x);
      expect(cropLines.vertical[1]).toBeLessThan(cropArea.x + cropArea.width);
    });
  });

  describe('edge cases', () => {
    it('handles very small areas', () => {
      const area = { x: 0, y: 0, width: 30, height: 30 };

      const lines = calculateGridLines(area, 3);

      expect(lines.vertical[0]).toBe(10);
      expect(lines.vertical[1]).toBe(20);
      expect(lines.horizontal[0]).toBe(10);
      expect(lines.horizontal[1]).toBe(20);
    });

    it('handles non-zero origin', () => {
      const area = { x: 500, y: 300, width: 300, height: 300 };

      const lines = calculateGridLines(area, 3);

      // First vertical should be offset by x
      expect(lines.vertical[0]).toBe(600); // 500 + 100
      expect(lines.vertical[1]).toBe(700); // 500 + 200

      // First horizontal should be offset by y
      expect(lines.horizontal[0]).toBe(400); // 300 + 100
      expect(lines.horizontal[1]).toBe(500); // 300 + 200
    });
  });
});
