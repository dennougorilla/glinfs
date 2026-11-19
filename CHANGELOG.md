# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.18.1](https://github.com/dennougorilla/glinfs/compare/v0.18.0...v0.18.1) (2026-11-19)


### Bug Fixes

* **capture:** frames of another size go when capture starts again ([#235](https://github.com/dennougorilla/glinfs/issues/235)) ([c9da841](https://github.com/dennougorilla/glinfs/commit/c9da841238768bd9307512a5f5f71ec09e51ce53))
* **editor:** a closed VideoFrame is never drawn ([#237](https://github.com/dennougorilla/glinfs/issues/237)) ([041d28b](https://github.com/dennougorilla/glinfs/commit/041d28bb9c47ad2e7fe8a4dc682c4fdce894e3d3))
* **export:** a color maps to the same palette index in every frame ([#226](https://github.com/dennougorilla/glinfs/issues/226)) ([1837a60](https://github.com/dennougorilla/glinfs/commit/1837a609616f63295d5c7cb9031c3cb3eee12159))

## [0.18.0](https://github.com/dennougorilla/glinfs/compare/v0.17.0...v0.18.0) (2026-11-19)


### Features

* **capture:** Change source while sharing ([#205](https://github.com/dennougorilla/glinfs/issues/205)) ([77fd699](https://github.com/dennougorilla/glinfs/commit/77fd6998e11eaf123dd2d472d03b09e0e007926b))
* **export:** dither pattern and cutout edge switches (labs L3) ([#225](https://github.com/dennougorilla/glinfs/issues/225)) ([d4388a8](https://github.com/dennougorilla/glinfs/commit/d4388a8b79ec70ed4c8c921d7ce8b5c237e6d363))
* **export:** frame differencing in gifenc for opaque GIFs ([#209](https://github.com/dennougorilla/glinfs/issues/209)) ([08d4301](https://github.com/dennougorilla/glinfs/commit/08d4301a6cd88578aa1bd46d0fd4c274e53b3f75))
* **export:** working dithering, faster palette mapping, sampled size estimate ([#210](https://github.com/dennougorilla/glinfs/issues/210)) ([16c57d0](https://github.com/dennougorilla/glinfs/commit/16c57d0f9d46c4f11dcb6df9568ba23364174068))
* **labs:** scene detection and frame differencing switches (L2) ([#223](https://github.com/dennougorilla/glinfs/issues/223)) ([4ddbc7f](https://github.com/dennougorilla/glinfs/commit/4ddbc7fb4fa1132ba9e50cf120a210292f8435e8))
* **settings:** a registry of switchable methods with a Settings section ([#219](https://github.com/dennougorilla/glinfs/issues/219)) ([749f935](https://github.com/dennougorilla/glinfs/commit/749f9353c1be7825faff8d204c5c3ccdbc430e91))


### Bug Fixes

* **ai-cutout:** four small cutout leaks from the memory audit ([#229](https://github.com/dennougorilla/glinfs/issues/229)) ([573d95a](https://github.com/dennougorilla/glinfs/commit/573d95accc652ab308e07ea13594008b004458fd))
* **ai-cutout:** release a base model when another loads; recover from a GPU reset ([#222](https://github.com/dennougorilla/glinfs/issues/222)) ([d477bbf](https://github.com/dennougorilla/glinfs/commit/d477bbf3ef7bae9b211baada92b8ba1136516fb0))
* **ai-cutout:** stop the model worker when the last clip goes ([#227](https://github.com/dennougorilla/glinfs/issues/227)) ([4d9cf8e](https://github.com/dennougorilla/glinfs/commit/4d9cf8eefd431cda7182700995e5fcd68978b0e4))
* **ai-cutout:** the active clip's masks are never evicted ([#228](https://github.com/dennougorilla/glinfs/issues/228)) ([9979052](https://github.com/dennougorilla/glinfs/commit/9979052c21cce02f22010e41ba6228125aedcb90))
* **capture:** a clip keeps one frame size when the shared source switches ([#203](https://github.com/dennougorilla/glinfs/issues/203)) ([a925bb8](https://github.com/dennougorilla/glinfs/commit/a925bb8265fbdde4109cdf2b3d0a90c0271d7d2c))
* **capture:** no frame leaks on leave, resize, worker error or estimate ([#231](https://github.com/dennougorilla/glinfs/issues/231)) ([61af4a4](https://github.com/dennougorilla/glinfs/commit/61af4a4fc40b3d7d6c1bbd9d719d896ca8561e3b))
* **capture:** the Edit step leads back to the clips from Capture ([#202](https://github.com/dennougorilla/glinfs/issues/202)) ([c843c00](https://github.com/dennougorilla/glinfs/commit/c843c00d4e6077c4a235fbdc81a84ec902995f21))
* **clips:** queued clips open on hardware decoders, and nothing waits forever ([#220](https://github.com/dennougorilla/glinfs/issues/220)) ([2af6997](https://github.com/dennougorilla/glinfs/commit/2af69976f7e5118d11c7c5e81a40cf22e9d1b34d))
* **editor:** the clock and ruler show seconds with tenths ([#207](https://github.com/dennougorilla/glinfs/issues/207)) ([2c58be7](https://github.com/dennougorilla/glinfs/commit/2c58be7c76b7cd9581d5b745121c6c07506bb95a))
* **hotkeys:** Ctrl/Cmd shortcuts work after clicking a panel control ([#204](https://github.com/dennougorilla/glinfs/issues/204)) ([6cdf56d](https://github.com/dennougorilla/glinfs/commit/6cdf56d3be8d1c60281df1df559cdb09ea359019))
* three findings of the 0.17.0 pre-release review ([#200](https://github.com/dennougorilla/glinfs/issues/200)) ([94ab0ee](https://github.com/dennougorilla/glinfs/commit/94ab0ee30275223424f4e390a2c3f494a96404f0))


### Performance Improvements

* **clips:** open queued clips on their own worker; mixed-size clips stay uncompressed ([#221](https://github.com/dennougorilla/glinfs/issues/221)) ([bbf9e05](https://github.com/dennougorilla/glinfs/commit/bbf9e05c25d55150398f20dd03038a0b629ed13b))
* **export:** frame differencing trials stop early and run on a second worker ([#224](https://github.com/dennougorilla/glinfs/issues/224)) ([7ecb6f2](https://github.com/dennougorilla/glinfs/commit/7ecb6f2c8227aeae90a3cae2a8648ecf29f4dcef))
* **grid:** draw grid thumbnails within a per-frame budget ([#206](https://github.com/dennougorilla/glinfs/issues/206)) ([3f73e0a](https://github.com/dennougorilla/glinfs/commit/3f73e0a5ed4625841e871744b27b585b6737cb8d))

## [0.17.0](https://github.com/dennougorilla/glinfs/compare/v0.16.0...v0.17.0) (2026-11-16)


### Features

* **ai-cutout:** a correction refines a tracked fix-up's earlier answer ([#199](https://github.com/dennougorilla/glinfs/issues/199)) ([3e3a62a](https://github.com/dennougorilla/glinfs/commit/3e3a62a77c0765f2502aba2d8c4fdaa290b3573e))
* **ai-cutout:** add your own models in Settings; BiRefNet from Hugging Face in production ([#196](https://github.com/dennougorilla/glinfs/issues/196)) ([1405265](https://github.com/dennougorilla/glinfs/commit/140526507c9a5398f0c147483285a808ccae7347))
* **ai-cutout:** BiRefNet general, lite and ToonOut in development builds; BEN2 ImageNet input; fail on NaN ([#192](https://github.com/dennougorilla/glinfs/issues/192)) ([b9d53e6](https://github.com/dennougorilla/glinfs/commit/b9d53e6deacf628b3f4d5e389d6360e3084a0f04))
* **ai-cutout:** Colour scope for Remove fix-ups, removed by colour on every frame ([#197](https://github.com/dennougorilla/glinfs/issues/197)) ([365731b](https://github.com/dennougorilla/glinfs/commit/365731bab7c5c6a0748f68b0441de632161cc16e))
* **ai-cutout:** flag the Convs onnxruntime-web WebGPU computes wrongly ([#198](https://github.com/dennougorilla/glinfs/issues/198)) ([aad4c73](https://github.com/dennougorilla/glinfs/commit/aad4c73da022ae2f5934c5fa0a7cec76fa9b462a))
* **ai-cutout:** one Keep / Remove pair, box prompts, corrections and coloured regions ([#195](https://github.com/dennougorilla/glinfs/issues/195)) ([a68b675](https://github.com/dennougorilla/glinfs/commit/a68b675af02f01fdfda9000ad22b193a34470d77))
* **ai-cutout:** remember the last model, prefer downloaded models, BEN2 first-run default ([#188](https://github.com/dennougorilla/glinfs/issues/188)) ([56e7037](https://github.com/dennougorilla/glinfs/commit/56e70372c81f200650ab8d6886b716af0df045dc))
* **ai-cutout:** remove or add a tracked object on top of any model ([#193](https://github.com/dennougorilla/glinfs/issues/193)) ([da83ed1](https://github.com/dennougorilla/glinfs/commit/da83ed16cd6517c98d39778ff4d222e7bc9a45e8))
* **queue:** remove the oldest clips automatically when memory or the queue is full ([#191](https://github.com/dennougorilla/glinfs/issues/191)) ([06807d5](https://github.com/dennougorilla/glinfs/commit/06807d58de8ee74d8407392916244a7041be7eb5))


### Bug Fixes

* **capture:** release the screen share when the screen is left mid-start ([#183](https://github.com/dennougorilla/glinfs/issues/183)) ([74a7fc6](https://github.com/dennougorilla/glinfs/commit/74a7fc6ade430cf4a64ea9ec8126f883b50ebf62))
* **capture:** settle every concurrent requestFrames() call ([#185](https://github.com/dennougorilla/glinfs/issues/185)) ([b36f2a6](https://github.com/dennougorilla/glinfs/commit/b36f2a645eece4fe07eedf031bac7f00c87238f0)), closes [#170](https://github.com/dennougorilla/glinfs/issues/170)
* **export:** fall back to canvas when VideoFrame.copyTo() rejects ([#181](https://github.com/dennougorilla/glinfs/issues/181)) ([e15118c](https://github.com/dennougorilla/glinfs/commit/e15118cefa2df6239269322c1065bcdc019dbe8a)), closes [#169](https://github.com/dennougorilla/glinfs/issues/169)
* **loading:** drop scene detection result when the active clip changed meanwhile ([#182](https://github.com/dennougorilla/glinfs/issues/182)) ([84f4e18](https://github.com/dennougorilla/glinfs/commit/84f4e183a485572ef8ddb4df3906c80d3b046faf)), closes [#171](https://github.com/dennougorilla/glinfs/issues/171)
* **queue:** Undo restores a clip deleted while it was compressing ([#184](https://github.com/dennougorilla/glinfs/issues/184)) ([bc626fc](https://github.com/dennougorilla/glinfs/commit/bc626fcff33e720644dcd9e291c21645e8db7b4d))

## [0.16.0](https://github.com/dennougorilla/glinfs/compare/v0.15.1...v0.16.0) (2026-10-02)


### Features

* **ai-cutout:** BEN2 and Robust Video Matting models with a Model choice ([#165](https://github.com/dennougorilla/glinfs/issues/165)) ([f75e00d](https://github.com/dennougorilla/glinfs/commit/f75e00dbcf72e9939d2cfa50591de0dc178d9d9a))

## [0.15.1](https://github.com/dennougorilla/glinfs/compare/v0.15.0...v0.15.1) (2026-10-01)


### Bug Fixes

* **ui:** layouts without container queries (Chrome/Edge 94-104) ([#163](https://github.com/dennougorilla/glinfs/issues/163)) ([b7da33b](https://github.com/dennougorilla/glinfs/commit/b7da33b0dac0768364a57bddfdb96e763690c58d))

## [0.15.0](https://github.com/dennougorilla/glinfs/compare/v0.14.0...v0.15.0) (2026-10-01)


### Features

* **ui:** neutral redesign with cyan/magenta spot colours and a pixel-art welcome scene ([#161](https://github.com/dennougorilla/glinfs/issues/161)) ([ced6ac0](https://github.com/dennougorilla/glinfs/commit/ced6ac07730058dbc0bf209c08ca8f634bfe6d16))

## [0.14.0](https://github.com/dennougorilla/glinfs/compare/v0.13.0...v0.14.0) (2026-10-01)


### Features

* **ai-cutout:** steadier click-to-select tracking and embedding reuse on long clips ([#159](https://github.com/dennougorilla/glinfs/issues/159)) ([a7dd8dc](https://github.com/dennougorilla/glinfs/commit/a7dd8dc17ee57ac579f08adfb08fac470660ba84))

## [0.13.0](https://github.com/dennougorilla/glinfs/compare/v0.12.0...v0.13.0) (2026-09-30)


### Features

* **editor:** show AI-analyzed frames on the timeline ([#155](https://github.com/dennougorilla/glinfs/issues/155)) ([a3354f2](https://github.com/dennougorilla/glinfs/commit/a3354f251db39c6495cf8181361f8c5f6de8a890))

## [0.12.0](https://github.com/dennougorilla/glinfs/compare/v0.11.0...v0.12.0) (2026-09-30)


### Features

* **editor:** "Something else — click it" — click to select with MobileSAM ([#156](https://github.com/dennougorilla/glinfs/issues/156)) ([0710a16](https://github.com/dennougorilla/glinfs/commit/0710a16b77e1a38b668006b6b9a634e560221d62))

## [0.11.0](https://github.com/dennougorilla/glinfs/compare/v0.10.0...v0.11.0) (2026-09-30)


### Features

* **editor:** Background tab around "What do you want to keep?" + fix slider flicker ([#153](https://github.com/dennougorilla/glinfs/issues/153)) ([ac252a9](https://github.com/dennougorilla/glinfs/commit/ac252a9c8001e5627c8a7007a3d7e6e773b78eca))

## [0.10.0](https://github.com/dennougorilla/glinfs/compare/v0.9.1...v0.10.0) (2026-09-30)


### Features

* **ai-cutout:** add MODNet Portrait model ([#150](https://github.com/dennougorilla/glinfs/issues/150)) ([e6feb80](https://github.com/dennougorilla/glinfs/commit/e6feb80e1982c2b46cb21526fd5b116d7212576b))
* **ai-cutout:** AI models manager, persistent storage and model preloading ([#149](https://github.com/dennougorilla/glinfs/issues/149)) ([f5cba64](https://github.com/dennougorilla/glinfs/commit/f5cba64b72d630de985791fb00efaee3975d54ad))
* **editor:** tabbed right sidebar, focused Touch up mode and preview view switch ([#148](https://github.com/dennougorilla/glinfs/issues/148)) ([648a282](https://github.com/dennougorilla/glinfs/commit/648a2821c4cfcd9268c74a340db4514280bc5875))

## [0.9.1](https://github.com/dennougorilla/glinfs/compare/v0.9.0...v0.9.1) (2026-09-29)


### Bug Fixes

* **icon:** pointer shape, per-screen icon and always-on logo animation ([#146](https://github.com/dennougorilla/glinfs/issues/146)) ([1999cae](https://github.com/dennougorilla/glinfs/commit/1999cae76d5eac1c4e9e8c8803de38ae349d90ca))

## [0.9.0](https://github.com/dennougorilla/glinfs/compare/v0.8.0...v0.9.0) (2026-09-29)


### Features

* **icon:** pixel cursor sticker icon, animated header logo and tab status ([#144](https://github.com/dennougorilla/glinfs/issues/144)) ([f374843](https://github.com/dennougorilla/glinfs/commit/f3748430e773b88f03b7df775f0cb9d5934be6d1))

## [0.8.0](https://github.com/dennougorilla/glinfs/compare/v0.7.0...v0.8.0) (2026-09-29)


### Features

* AI cutout for anime characters, fully in the browser ([#138](https://github.com/dennougorilla/glinfs/issues/138)) ([be8830c](https://github.com/dennougorilla/glinfs/commit/be8830cd6b7ed765ab0a2555af358afdd41dc376))
* **editor:** mask brush to touch up background removal ([#140](https://github.com/dennougorilla/glinfs/issues/140)) ([ff376f5](https://github.com/dennougorilla/glinfs/commit/ff376f5524a0270aff76aa855ceed2a1dbdb986d))
* **export:** export dialog, unified speed, target size and output scale ([#139](https://github.com/dennougorilla/glinfs/issues/139)) ([c97a6c1](https://github.com/dennougorilla/glinfs/commit/c97a6c146df3960f46d308719de7e49ce8f2f434))

## [0.7.0](https://github.com/dennougorilla/glinfs/compare/v0.6.0...v0.7.0) (2026-09-25)


### Features

* text captions, transparent backgrounds and GIF/image import ([#136](https://github.com/dennougorilla/glinfs/issues/136)) ([dfac7a4](https://github.com/dennougorilla/glinfs/commit/dfac7a430a6b2bb6ac78e7cc2f1a34d00d05d185))

## [0.6.0](https://github.com/dennougorilla/glinfs/compare/v0.5.6...v0.6.0) (2026-09-24)


### Features

* **app:** add loop-and-record favicon and header logo ([#134](https://github.com/dennougorilla/glinfs/issues/134)) ([d659ea0](https://github.com/dennougorilla/glinfs/commit/d659ea06cccfb3db013ae05970a9c08205846756))

## [0.5.6](https://github.com/dennougorilla/glinfs/compare/v0.5.5...v0.5.6) (2026-09-24)


### Bug Fixes

* **editor:** route live-view Escape through the hotkey dispatcher ([#128](https://github.com/dennougorilla/glinfs/issues/128)) ([9636a70](https://github.com/dennougorilla/glinfs/commit/9636a700f9c82bcfeee101f618d27513c25eae85))

## [0.5.5](https://github.com/dennougorilla/glinfs/compare/v0.5.4...v0.5.5) (2026-09-24)


### Bug Fixes

* **queue:** clip-codec terminate() hands pending encodes their frames back ([#121](https://github.com/dennougorilla/glinfs/issues/121)) ([384c67e](https://github.com/dennougorilla/glinfs/commit/384c67ea1e39a6a5e3b08d14b4613f034fcd9423)), closes [#120](https://github.com/dennougorilla/glinfs/issues/120)

## [0.5.4](https://github.com/dennougorilla/glinfs/compare/v0.5.3...v0.5.4) (2026-09-23)


### Bug Fixes

* **queue:** raw-fallback queue limit default and explicit codec-crash contract ([#115](https://github.com/dennougorilla/glinfs/issues/115)) ([428993c](https://github.com/dennougorilla/glinfs/commit/428993cb814864c065e0c290cf7182b963f3aa69))

## [0.5.3](https://github.com/dennougorilla/glinfs/compare/v0.5.2...v0.5.3) (2026-09-23)


### Bug Fixes

* **editor:** keep crop when Escape closes the clip-queue popover ([#109](https://github.com/dennougorilla/glinfs/issues/109)) ([4326797](https://github.com/dennougorilla/glinfs/commit/432679727a6593774ce9df5ac48dde08574072f3))
* **scene-detection:** close ImageBitmaps on cancel and error paths ([#111](https://github.com/dennougorilla/glinfs/issues/111)) ([aa766a5](https://github.com/dennougorilla/glinfs/commit/aa766a50bc0c6d97efc5d2d0f5736d885022f39a))


### Performance Improvements

* **editor:** drive playback from elapsed time with requestAnimationFrame ([#110](https://github.com/dennougorilla/glinfs/issues/110)) ([e5604cc](https://github.com/dennougorilla/glinfs/commit/e5604cc7eee258fb3c390efb7a8aa9509dc2fe9f))
* **export:** build fast-preset palette from frames sampled across the clip ([#112](https://github.com/dennougorilla/glinfs/issues/112)) ([314399b](https://github.com/dennougorilla/glinfs/commit/314399b28124497e056ffc504cf9fbbeea00164d))

## [0.5.2](https://github.com/dennougorilla/glinfs/compare/v0.5.1...v0.5.2) (2026-09-23)


### Bug Fixes

* **editor:** quiet zero-scenes hint, remember sidebar tab, fix stale comments ([#106](https://github.com/dennougorilla/glinfs/issues/106)) ([c7bcd28](https://github.com/dennougorilla/glinfs/commit/c7bcd280f25b0271f904f54658504801676ac5cf)), closes [#98](https://github.com/dennougorilla/glinfs/issues/98)
* **export:** verify gifsicle glue integrity before execution ([#105](https://github.com/dennougorilla/glinfs/issues/105)) ([45e819f](https://github.com/dennougorilla/glinfs/commit/45e819f9c2a8c1d4d941482650a532d673d18302))


### Performance Improvements

* **editor:** reuse ThumbnailCache for frame-grid thumbnails ([#107](https://github.com/dennougorilla/glinfs/issues/107)) ([2c7fa87](https://github.com/dennougorilla/glinfs/commit/2c7fa87e3ea4905f662727ef21b1531cf7fcb021))

## [0.5.1](https://github.com/dennougorilla/glinfs/compare/v0.5.0...v0.5.1) (2026-09-23)


### Bug Fixes

* **export,router:** make empty-state buttons work under CSP; announce route-failure redirects ([#103](https://github.com/dennougorilla/glinfs/issues/103)) ([d74dfc6](https://github.com/dennougorilla/glinfs/commit/d74dfc66b145b0ce4fd3ba939dcfaab9090ec52d))

## [0.5.0](https://github.com/dennougorilla/glinfs/compare/v0.4.1...v0.5.0) (2026-07-28)


### Features

* live capture across routes — background recording, PiP, Clip Now + bounded clip queue, memory safety ([#97](https://github.com/dennougorilla/glinfs/issues/97)) ([6b0f717](https://github.com/dennougorilla/glinfs/commit/6b0f717dada9a2c2914c2dae61bdd9b531ac8236))


### Bug Fixes

* **export,capture,ui:** scope export results to one visit, unlock scene toggle, resolve CSS collisions ([#89](https://github.com/dennougorilla/glinfs/issues/89)) ([153fc62](https://github.com/dennougorilla/glinfs/commit/153fc624ac7c7d3f9c532e6f88ea6732c5fd7d57))

## [0.4.1](https://github.com/dennougorilla/glinfs/compare/v0.4.0...v0.4.1) (2026-07-28)


### Bug Fixes

* **editor:** frame-grid focus retention on eviction; wire thumbnailQuality setting ([#86](https://github.com/dennougorilla/glinfs/issues/86)) ([ab83978](https://github.com/dennougorilla/glinfs/commit/ab83978a14ee7264b78e6ff1d8dad5a8020b2362))
* **export,settings:** cancel stale throttled progress timer; restore correct settings back route ([#87](https://github.com/dennougorilla/glinfs/issues/87)) ([0fc7074](https://github.com/dennougorilla/glinfs/commit/0fc7074e903aece6017326eb7200a96d44ab1815))
* **export:** abort worker encode session after a frame failure ([#45](https://github.com/dennougorilla/glinfs/issues/45)) ([#77](https://github.com/dennougorilla/glinfs/issues/77)) ([8ff8b55](https://github.com/dennougorilla/glinfs/commit/8ff8b55838e4fb731ae2372675b78f43b930aeeb))
* **export:** only restore a saved result whose fingerprint matches the visit ([#85](https://github.com/dennougorilla/glinfs/issues/85)) ([4586809](https://github.com/dennougorilla/glinfs/commit/4586809be71d56634a49a7888c6094405eac61c3))
* **export:** probe encoder availability with HEAD; honor loopCount via NETSCAPE patch ([#46](https://github.com/dennougorilla/glinfs/issues/46)) ([#82](https://github.com/dennougorilla/glinfs/issues/82)) ([2521683](https://github.com/dennougorilla/glinfs/commit/2521683af08c64659f18ed26831c1b9133464026))


### Performance Improvements

* **export:** reuse extraction canvas and throttle progress UI updates ([#81](https://github.com/dennougorilla/glinfs/issues/81)) ([7029858](https://github.com/dennougorilla/glinfs/commit/702985823831d12281ee15a620db609c0eb496d9))

## [0.4.0](https://github.com/dennougorilla/glinfs/compare/v0.3.1...v0.4.0) (2026-07-21)


### Features

* **security:** add Content-Security-Policy meta tag ([#71](https://github.com/dennougorilla/glinfs/issues/71)) ([62c5259](https://github.com/dennougorilla/glinfs/commit/62c52590f6fd34a6b7ba7ccc45c6fd8f5100cffc))


### Bug Fixes

* **editor:** frame-grid keyboard guard for interactive controls, min-size fallback, guaranteed modal close ([#68](https://github.com/dennougorilla/glinfs/issues/68)) ([30d69ff](https://github.com/dennougorilla/glinfs/commit/30d69ff51d21486f898b5816e1b49fb664541292))
* **export:** restore saved results on revisit, label jobs with selected encoder, sync play/pause UI ([#69](https://github.com/dennougorilla/glinfs/issues/69)) ([36b9db4](https://github.com/dennougorilla/glinfs/commit/36b9db4245360e34dbcbe63be7f8e8dbf8fca026))
* salvage verified reliability fixes from [#66](https://github.com/dennougorilla/glinfs/issues/66) (scene-detection, router, capture) ([#70](https://github.com/dennougorilla/glinfs/issues/70)) ([7ec3345](https://github.com/dennougorilla/glinfs/commit/7ec33458aa6bd532ee6d129972b2fb87a54b6a7d))


### Performance Improvements

* **capture:** O(1) ring-buffer eviction, capacity reconciliation on restart, fresh stats after buffer drain ([#67](https://github.com/dennougorilla/glinfs/issues/67)) ([833ea08](https://github.com/dennougorilla/glinfs/commit/833ea088b713e64d5b12988ac985ee14e2c58a35))
* **editor:** windowed virtualization for the frame grid ([#72](https://github.com/dennougorilla/glinfs/issues/72)) ([42c2f7f](https://github.com/dennougorilla/glinfs/commit/42c2f7fa6b3a32bae74578e3ce023146fb93a7e1))

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
