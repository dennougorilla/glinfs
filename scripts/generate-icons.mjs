/**
 * Generates the pixel-art "meme sticker" cursor icons:
 *   - public/favicon.svg, favicon-recording.svg, favicon-busy.svg (tab states)
 *   - public/favicon.ico (16/32/48, needs Playwright + ImageMagick)
 *   - the animated header logo inside src/index.html (between the logo markers)
 *
 * Usage: node scripts/generate-icons.mjs
 *
 * Everything is drawn on a 32×32 unit grid. One art pixel = 2 units, so the
 * icon is pixel-perfect at 16px (1px) and 32px (2px).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const COLORS = {
  cyan: '#22d3ee',
  pink: '#ec4899',
  ink: '#111114',
  white: '#ffffff',
  sand: '#facc15',
  red: '#ef4444',
};

// K = outline, W = fill, Y = sand (hourglass)
const CURSORS = {
  // macOS-style pointer; drawn solid black (see INK_FILLED)
  arrow: [
    'K........',
    'KK.......',
    'KKK......',
    'KKKK.....',
    'KKKKK....',
    'KKKKKK...',
    'KKKKKKK..',
    'KKKKKKKK.',
    'KKKKKKKKK',
    'KKKKK....',
    'KK.KKK...',
    'K...KKK..',
    '.....KK..',
  ],
  cross: [
    '...KKK...',
    '...KWK...',
    '...KWK...',
    'KKKK.KKKK',
    'KWW...WWK',
    'KKKK.KKKK',
    '...KWK...',
    '...KWK...',
    '...KKK...',
  ],
  ibeam: [
    'KKK.KKK',
    'KWWKWWK',
    'KKKWKKK',
    '..KWK..',
    '..KWK..',
    '..KWK..',
    '..KWK..',
    '..KWK..',
    'KKKWKKK',
    'KWWKWWK',
    'KKK.KKK',
  ],
  hand: [
    '...KK.....',
    '..KWWK....',
    '..KWWK....',
    '..KWWKKK..',
    '..KWWKWWKK',
    'KKKWWKWWKW',
    'KWWKWWWWWK',
    'KWWWWWWWWK',
    '.KWWWWWWWK',
    '.KWWWWWWK.',
    '..KWWWWWK.',
    '..KKKKKKK.',
  ],
  wait: [
    'KKKKKKKK',
    '.KWWWWK.',
    '.KYYYYK.',
    '..KYYK..',
    '...KK...',
    '..KWYK..',
    '.KWYYWK.',
    '.KYYYYK.',
    'KKKKKKKK',
  ],
};
const REC_DOT = ['.WWW.', 'WRRRW', 'WRRRW', 'WRRRW', '.WWW.'];
const PALETTE = { K: COLORS.ink, W: COLORS.white, Y: COLORS.sand, R: COLORS.red };
// Solid black like the macOS pointer, so the white sticker rim reads as the outline
const INK_FILLED = new Set(['arrow', 'cross', 'ibeam']);

/**
 * Header logo frames, in playback order. `name` is matched by the logo's
 * data-state (set by shared/tab-status.js); the first frame is the default.
 */
const FRAMES = [
  { name: 'idle', cursor: 'arrow' },
  { name: 'recording', cursor: 'arrow', rec: true },
  { name: 'select', cursor: 'cross' },
  { name: 'text', cursor: 'ibeam' },
  { name: 'edit', cursor: 'hand' },
  { name: 'busy', cursor: 'wait' },
];
const frame = (name) => FRAMES.find((f) => f.name === name);
/** Seconds per frame on hover; keep in sync with app-logo-frame's duration in global.css */
const HOVER_STEP = 0.4;

const createGrid = () => Array.from({ length: 32 }, () => Array(32).fill(null));

/** Paint art pixels (2×2 units each) onto a unit grid */
function paint(grid, rows, palette, ox, oy) {
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const color = palette[ch];
      if (!color) return;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const gx = ox + x * 2 + dx;
          const gy = oy + y * 2 + dy;
          if (gx >= 0 && gx < 32 && gy >= 0 && gy < 32) grid[gy][gx] = color;
        }
      }
    });
  });
}

/** Silhouette of a cursor as a unit-grid mask */
function silhouette(rows, ox, oy) {
  const grid = createGrid();
  paint(grid, rows, { K: true, W: true, Y: true }, ox, oy);
  return grid.map((row) => row.map(Boolean));
}

/** Grow a mask by r units (square kernel), optionally shifted by dx/dy */
function dilate(mask, r, dx = 0, dy = 0) {
  return mask.map((row, y) =>
    row.map((_, x) => {
      for (let j = -r; j <= r; j++) {
        for (let i = -r; i <= r; i++) {
          if (mask[y - dy + j]?.[x - dx + i]) return true;
        }
      }
      return false;
    }),
  );
}

function fill(grid, mask, color) {
  mask.forEach((row, y) => {
    row.forEach((on, x) => {
      if (on) grid[y][x] = color;
    });
  });
}

/** One <path> per color: horizontal runs, stacked into rectangles when rows repeat */
function toPaths(grid) {
  const byColor = new Map();
  /** @type {Map<string, { color: string, x: number, n: number, y: number, h: number }>} */
  let open = new Map();
  const close = (r) =>
    byColor.set(r.color, `${byColor.get(r.color) ?? ''}M${r.x} ${r.y}h${r.n}v${r.h}h-${r.n}z`);
  for (let y = 0; y <= 32; y++) {
    const next = new Map();
    const row = grid[y] ?? [];
    let x = 0;
    while (y < 32 && x < 32) {
      const color = row[x];
      let n = 1;
      while (x + n < 32 && row[x + n] === color) n++;
      if (color) {
        const key = `${color}|${x}|${n}`;
        const r = open.get(key);
        if (r) {
          r.h++;
          open.delete(key);
          next.set(key, r);
        } else {
          next.set(key, { color, x, n, y, h: 1 });
        }
      }
      x += n;
    }
    open.forEach(close);
    open = next;
  }
  return [...byColor].map(([color, d]) => `<path fill="${color}" d="${d}"/>`).join('');
}

/** @returns {{ cyan: string, pink: string, body: string }} markup for one frame */
function drawFrame({ cursor, rec = false }) {
  const rows = CURSORS[cursor];
  const w = rows[0].length * 2;
  const h = rows.length * 2;
  const x = 2 * Math.round((16 - w / 2 + 2) / 2);
  const y = 2 * Math.round((16 - h / 2) / 2);
  const shape = silhouette(rows, x, y);

  const cyan = createGrid();
  fill(cyan, dilate(shape, 3, -3, 1), COLORS.cyan);
  const pink = createGrid();
  fill(pink, dilate(shape, 3, 3, -1), COLORS.pink);

  // sticker: thin dark line → white rim → cursor
  const body = createGrid();
  fill(body, dilate(shape, 3), COLORS.ink);
  fill(body, dilate(shape, 2), COLORS.white);
  paint(body, rows, INK_FILLED.has(cursor) ? { ...PALETTE, W: COLORS.ink } : PALETTE, x, y);
  if (rec) paint(body, REC_DOT, PALETTE, 20, 2);

  return { cyan: toPaths(cyan), pink: toPaths(pink), body: toPaths(body) };
}

function faviconSvg(f) {
  const { cyan, pink, body } = drawFrame(f);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" shape-rendering="crispEdges" role="img"><title>Glinfs</title>${cyan}${pink}${body}</svg>\n`;
}

function headerSvg() {
  const n = FRAMES.length;
  const frames = FRAMES.map((f, i) => {
    const { cyan, pink, body } = drawFrame(f);
    // Negative delays line the frames up so hovering jumps straight to the
    // next frame: frame i shows during step (i - 1) mod n
    const slot = (i - 1 + n) % n;
    const delay = +(-((n - slot) % n) * HOVER_STEP).toFixed(2);
    return `<g class="app-logo-frame" data-frame="${f.name}" style="animation-delay:${delay}s"><g class="app-logo-shadow app-logo-shadow--cyan">${cyan}</g><g class="app-logo-shadow app-logo-shadow--pink">${pink}</g>${body}</g>`;
  }).join('\n            ');
  return `<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32" shape-rendering="crispEdges">
            ${frames}
          </svg>`;
}

// --- favicons
const files = {
  'favicon.svg': frame('idle'),
  'favicon-edit.svg': frame('edit'),
  'favicon-recording.svg': frame('recording'),
  'favicon-busy.svg': frame('busy'),
};
for (const [name, f] of Object.entries(files)) {
  writeFileSync(join(ROOT, 'public', name), faviconSvg(f));
}

// --- header logo
const htmlPath = join(ROOT, 'src', 'index.html');
const html = readFileSync(htmlPath, 'utf8');
const marker = /(<!-- logo:start[^>]*-->)[\s\S]*?(\s*<!-- logo:end -->)/;
if (!marker.test(html)) throw new Error('logo markers not found in src/index.html');
writeFileSync(
  htmlPath,
  html.replace(marker, (_, start, end) => `${start}\n          ${headerSvg()}${end}`),
);

// --- favicon.ico
const { chromium } = await import('playwright');
const tmp = mkdtempSync(join(tmpdir(), 'glinfs-icons-'));
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const svg = readFileSync(join(ROOT, 'public', 'favicon.svg'), 'utf8');
  const pngs = [];
  for (const size of [16, 32, 48]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}img{display:block}</style><img width="${size}" height="${size}" src="data:image/svg+xml,${encodeURIComponent(svg)}">`,
    );
    const file = join(tmp, `${size}.png`);
    await page.screenshot({ path: file, omitBackground: true });
    pngs.push(file);
  }
  execFileSync('magick', [...pngs, join(ROOT, 'public', 'favicon.ico')]);
} finally {
  await browser.close();
  rmSync(tmp, { recursive: true, force: true });
}
console.log('Icons generated.');
