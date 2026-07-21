# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1](https://github.com/dennougorilla/glinfs/compare/v0.3.0...v0.3.1) (2026-07-21)


### Bug Fixes

* **capture:** plug worker and ImageBitmap lifecycle leaks ([#56](https://github.com/dennougorilla/glinfs/issues/56)) ([8feda92](https://github.com/dennougorilla/glinfs/commit/8feda92d43d0e1f43be43fd2cc0d73fdcb01f6f2))
* **dom:** skip nullish and false attribute values in createElement ([#35](https://github.com/dennougorilla/glinfs/issues/35)) ([#51](https://github.com/dennougorilla/glinfs/issues/51)) ([6d3babe](https://github.com/dennougorilla/glinfs/commit/6d3babe7f3e29561c1eebdbe8416bc685b6be87a))
* **editor:** read live state in frame nav, shortcuts, and Clear Crop ([#37](https://github.com/dennougorilla/glinfs/issues/37)) ([#53](https://github.com/dennougorilla/glinfs/issues/53)) ([f374c16](https://github.com/dennougorilla/glinfs/commit/f374c16a85e176f45ade5ca65ce536ba29c677cb))
* **editor:** refresh toolbar time display when the selection changes ([#60](https://github.com/dennougorilla/glinfs/issues/60)) ([2a4aafd](https://github.com/dennougorilla/glinfs/commit/2a4aafd3637d51fef0b75e8637fc0cbbc138fe80))
* **editor:** respect clip.fps in playback interval and timecodes ([#41](https://github.com/dennougorilla/glinfs/issues/41)) ([#58](https://github.com/dennougorilla/glinfs/issues/58)) ([ccd159f](https://github.com/dennougorilla/glinfs/commit/ccd159f277ebc33c3f57fbd607c9606454911441))
* **editor:** restore scene detection results when returning from Export ([#59](https://github.com/dennougorilla/glinfs/issues/59)) ([1d8d300](https://github.com/dennougorilla/glinfs/commit/1d8d300ad577a70bce49fdb9b5ce88587ee40cbd))
* **export:** bound in-flight frames with ACK backpressure; drop redundant buffer copy ([#55](https://github.com/dennougorilla/glinfs/issues/55)) ([62243bb](https://github.com/dennougorilla/glinfs/commit/62243bbca22cdbc7820f5effd4d120a5078ecf52))
* **export:** reject pending finish() on dispose so cancel no longer freezes the UI ([#54](https://github.com/dennougorilla/glinfs/issues/54)) ([340b429](https://github.com/dennougorilla/glinfs/commit/340b429dc8fedc8b0f7c264f5643d3cb0f54d550))
* **settings:** repair dead settings screen and defective UI controls ([#36](https://github.com/dennougorilla/glinfs/issues/36)) ([#52](https://github.com/dennougorilla/glinfs/issues/52)) ([6089147](https://github.com/dennougorilla/glinfs/commit/60891478af0c6011a517c8c008d822d2402ca837))

## [0.3.0](https://github.com/dennougorilla/glinfs/compare/v0.2.0...v0.3.0) (2026-01-26)


### Features

* **editor:** improve FrameGrid performance and selection visibility ([#31](https://github.com/dennougorilla/glinfs/issues/31)) ([0f61b9f](https://github.com/dennougorilla/glinfs/commit/0f61b9f978c7392bc4ccf3ad64ee62c7b3152e71))

## [0.2.0](https://github.com/dennougorilla/glinfs/compare/v0.1.1...v0.2.0) (2026-01-25)


### Features

* add left sidebar with scene thumbnails and enhance FrameGrid UI ([#22](https://github.com/dennougorilla/glinfs/issues/22)) ([4b43b3b](https://github.com/dennougorilla/glinfs/commit/4b43b3b5a52eac95d7b750d507b13693d5fa4db4))


### Bug Fixes

* remove inaccurate memory display from Capture stats ([#26](https://github.com/dennougorilla/glinfs/issues/26)) ([ccfff0c](https://github.com/dennougorilla/glinfs/commit/ccfff0c52056b286814a4786a2e406d9e592949d))

## [0.1.1] - 2025-01-14

### Fixed

- Center crop area when changing aspect ratio (#21)

## [0.1.0] - 2025-01-14

### Features

- Initial release of Glinfs
- Screen capture functionality with getDisplayMedia API
- Real-time recording with frame capture
- Scene detection for automatic frame selection
- Frame editor with timeline and preview
- Crop area selection
- GIF export with customizable settings
- Web Worker based GIF encoding for smooth performance

[0.1.1]: https://github.com/dennougorilla/glinfs/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/dennougorilla/glinfs/releases/tag/v0.1.0
