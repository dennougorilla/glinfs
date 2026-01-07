# Glinfs

High-performance screen capture to GIF converter.

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)
[![GitHub Pages](https://img.shields.io/badge/demo-GitHub%20Pages-brightgreen)](https://dennougorilla.github.io/glinfs/)

<!-- Demo GIF placeholder - add your own demo.gif here -->
<!-- ![Glinfs Demo](./docs/demo.gif) -->

## Features

### Capture
Record your screen with up to 60 FPS. Supports window, tab, or entire screen capture with a rolling buffer of up to 60 seconds.

### Edit
Trim your clip by selecting start and end frames. Crop and zoom to focus on specific areas with preset aspect ratios (1:1, 16:9, 4:3, and more).

### Export
Convert to GIF with customizable quality, playback speed, and frame rate settings. Real-time preview before final export.

## Privacy

All processing happens entirely in your browser. Your screen recordings never leave your device - no uploads, no servers, no tracking.

## Getting Started

**Try it now:** [https://dennougorilla.github.io/glinfs/](https://dennougorilla.github.io/glinfs/)

### Browser Support
- Chrome 94+
- Edge 94+

(Chromium-based browsers only - Screen Capture API required)

## How to Use

1. **Capture** - Click "Start Capture" and select your screen, window, or tab
2. **Edit** - Use the timeline to trim, and crop tool to focus on specific areas
3. **Export** - Adjust quality settings and download your GIF

## Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Run tests
npm test
```

## License

[ISC License](LICENSE)
