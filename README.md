# pipertts

In-process [Piper](https://github.com/rhasspy/piper) text-to-speech for Node.js. No Python required.

`pipertts` runs Piper neural voices directly inside Node via `onnxruntime-node`: the ONNX session stays warm, so synthesis runs ~10x faster than spawning the Piper CLI per call (~0.22s/line vs ~2.2s/line on `en_US-lessac-medium`).

## What you get

- Native inference (`PiperNativeTTS`): persistent ONNX session, streaming per-sentence chunks
- All 7 Piper `phoneme_type` values: `espeak`, `text`, `hebrew`, `lithuanian`, `pinyin`, `thai`, `japanese`
- Multi-speaker voices (`speakerId`, incl. multi-style models)
- Output as `Buffer` or direct file write: `wav`, `raw`, `mp3`, `ogg`, `opus`
- Catalog model selection via Hugging Face with auto-download (`listPiperModels()`)
- Cross-platform support for:
  - Linux x64
  - Linux arm64
  - Windows x64
- Typed API with startup validation and a 71-test suite

## Platform support

| OS | Architecture | Requirement |
|---|---|---|
| Linux | x64 | None beyond npm install (espeak prebuild bundled) |
| Linux | arm64 | None beyond npm install (espeak prebuild bundled) |
| Windows | x64 | `espeak-ng` CLI (falls back automatically, e.g. via choco) |

`onnxruntime-node`, `lindera-wasm`, `pyodide`, and the pure-JS audio encoders ship as npm dependencies. `ffmpeg` is optional: when present it handles `mp3`/`ogg`/`opus` transcoding, otherwise pure-JS fallbacks cover `mp3` (lamejs) and `opus` (opusscript); `ogg` needs `ffmpeg`.

## Install

```bash
npm install pipertts
```

## Required setup

`pipertts` does not ship Piper voice models. Get a `.onnx` model (and its `.onnx.json`) from the Piper project, or let the catalog helpers download one for you:

```ts
import { PiperNativeTTS, resolveModelPathFromOptions } from "pipertts";

const modelPath = await resolveModelPathFromOptions({
  model: "en_US-lessac-medium",
  modelsDir: "./models",
});

const tts = await PiperNativeTTS.load({ modelPath });
```

Phonemizer data (g2pw ~280MB, UniDic ~200MB, TLTK ~20MB, smaller tables for Hebrew/Arabic/Lithuanian) downloads once into `./piper-data/` on first use. Override with `nativeDataDir` or per-bundle paths (`g2pwModelDir`, `unidicDir`, `tltkDataDir`, `nakdimonModelPath`, `tashkeelModelDir`, `lithuanianDataDir`).

Piper releases: <https://github.com/rhasspy/piper/releases>

## Quick start

```ts
import { PiperNativeTTS } from "pipertts";
import * as fs from "node:fs";

async function main() {
  const tts = await PiperNativeTTS.load({
    modelPath: "./models/en_US-lessac-medium.onnx",
  });

  const result = await tts.synthesize("Hello from Piper.", {
    outputFormat: "wav",
    lengthScale: 0.9,
  });
  fs.writeFileSync("./hello.wav", result.audio);

  // Multi-speaker / multi-style voices:
  const excited = await tts.synthesize("What wonderful news!", {
    speakerId: 1,
  });
  fs.writeFileSync("./excited.wav", excited.audio);
}

main().catch(console.error);
```

See `examples/example-native.ts` (run with `npx tsx examples/example-native.ts`).

## Catalog models (Hugging Face) and custom mode

```ts
import {
  getPiperModelMetadata,
  getPiperModelsByLanguage,
  listPiperModels,
  PiperNativeTTS,
} from "pipertts";

const models = await listPiperModels();
console.log(models.slice(0, 5)); // first catalog ids + "custom"

const metadata = await getPiperModelMetadata("en_US-lessac-medium");
console.log(metadata?.languageCode, metadata?.quality, metadata?.numSpeakers);

const englishModels = await getPiperModelsByLanguage("en");
const frenchModels = await getPiperModelsByLanguage("fr_FR");
console.log(englishModels.length, frenchModels.length);
```

`getPiperModelMetadata("custom")` returns `null`.
`getPiperModelsByLanguage("en")` matches all variants like `en_US`, `en_GB`, etc.

## Phonemizers

Every Piper `phoneme_type` is supported, verified against the Python reference:

| Type | Engine | Notes |
|---|---|---|
| `espeak` | N-API espeak-ng bridge (prebuilds) or CLI fallback | Byte-identical clauses |
| `text` | Codepoint passthrough | Trivial |
| `hebrew` | Nakdimon ONNX + rule-based IPA | Identical outputs |
| `lithuanian` | espeak + 189k-entry stress dictionary | Identical outputs |
| `pinyin` | g2pW BERT ONNX + WordPiece | Polyphonic disambiguation works (`银行→yínháng`) |
| `thai` | Real TLTK unmodified under Pyodide/WASM | 7/7 identical; first call takes seconds, later calls are fast |
| `japanese` | lindera-wasm + UniDic + TS morae engine | Segments exact; **no lexical pitch accent** — UniDic ships no accent data |

Arabic `ar` voices are diacritized with tashkeel automatically (disable with `useTashkeel: false`).

Inspect phonemization without synthesizing:

```ts
const phonemes = await tts.phonemize("Hello world.");
```

## Output formats

`wav` (default), `raw` PCM, `mp3`, `ogg`, `opus` — set via `outputFormat`
per call, or write straight to disk:

```ts
await tts.synthesize("Saved directly.", {
  outputFormat: "mp3",
  outputFile: "./direct.mp3",
});
```

## Espeak bridge

`src/native/espeak-bridge/` is an N-API port of `espeakbridge.c`
(byte-identical phonemes). Prebuilds ship with the package
(`npm run build:prebuilds`, CI in `prebuilds.yml`); local build with
`npm run build:espeak-bridge` (needs `libespeak-ng-dev`). Without an addon
it falls back to the `espeak-ng` CLI (~15ms/sentence). Set
`PIPER_ESPEAK_BRIDGE=0` to force the CLI.

> License note: `src/native/` ports piper1-gpl (GPL-3.0-or-later);
> `src/native/chinese.ts` ports g2pw (Apache-2.0, Yi-Chang Chen);
> Thai runs TLTK (BSD-3-Clause, Chulalongkorn University) unmodified;
> Japanese segments with lindera-wasm + UniDic (MIT, no accent data);
> the phonemizer data bundles keep their own licenses (tashkeel/hebrew:
> GPL/MIT, Lithuanian TSVs: CC-BY-4.0, g2pw model: Apache-2.0).

## Module usage (ESM and CommonJS)

ESM:

```js
import { PiperNativeTTS } from "pipertts";

const tts = await PiperNativeTTS.load({
  modelPath: "./models/en_US-lessac-medium.onnx",
});
```

CommonJS:

```js
const { PiperNativeTTS } = require("pipertts");

async function boot() {
  const tts = await PiperNativeTTS.load({
    modelPath: "./models/en_US-lessac-medium.onnx",
  });

  await tts.synthesize("Hello from CommonJS", {
    outputFile: "./cjs.wav",
  });
}

boot().catch(console.error);
```

## API

### `PiperNativeTTS.load(options)`

Loads the ONNX model and resolves phonemizer resources (downloading data on first use).

| Option | Type | Required | Default |
|---|---|---|---|
| `modelPath` | `string` | yes | - |
| `configPath` | `string` | no | auto (`<model>.json`) |
| `numThreads` | `number` | no | ONNX default |
| `espeakBinary` | `string` | no | `espeak-ng` |
| `session` | `NativeSession` | no | created from `modelPath` |
| `nativeDataDir` | `string` | no | `"./piper-data"` |
| `tashkeelModelDir` / `nakdimonModelPath` / `g2pwModelDir` / `lithuanianDataDir` / `tltkDataDir` / `unidicDir` | `string` | no | auto-downloaded |
| `useTashkeel` | `boolean` | no | `true` |
| `taskeenThreshold` | `number` | no | `0.8` |

### `tts.synthesize(text, options?)`

Synthesizes speech and returns `{ audio: Buffer, sampleRate, text }`.
Audio arrives sentence by sentence from `synthesizeChunks()`; chunks are
concatenated with `sentenceSilence` gaps, then optionally transcoded.

| Option | Type | Default | Notes |
|---|---|---|---|
| `speakerId` | `number` | config default | Multi-speaker/style index |
| `noiseScale` | `number` | `0.667` | Voice variability (output is stochastic) |
| `noiseWScale` | `number` | `0.8` | Timing variability |
| `lengthScale` | `number` | `1.0` | `>1` slower, `<1` faster |
| `sentenceSilence` | `number` | `0` | Gap between sentences, in seconds |
| `outputFormat` | `"wav" \| "raw" \| "mp3" \| "ogg" \| "opus"` | `"wav"` | Transcoded when needed |
| `outputFile` | `string` | - | Also writes the final audio there |
| `normalizeAudio` | `boolean` | `true` | Scale to peak |
| `volume` | `number` | `1.0` | Gain multiplier |

### `tts.phonemize(text)` / `tts.synthesizeChunks(text, options?)`

Lower-level access: `phonemize` returns phonemes grouped by sentence;
`synthesizeChunks` is an async generator yielding `{ sampleRate, phonemes, phonemeIds, pcm16 }` per sentence.

### `tts.getConfig()` / `tts.getModelPath()`

Introspect the resolved voice config and model path.

## Legacy CLI wrapper (`PiperTTS`)

`PiperTTS` shells out to `python3 -m piper` (one process per synthesis).
It stays available for environments where the native engine cannot run,
but it is ~10x slower and needs Python plus the Piper module installed:

```ts
import { PiperTTS } from "pipertts";

const tts = await PiperTTS.create({
  modelPath: "./models/en_US-lessac-medium.onnx",
});
// or: piperBinaryPath, warmUpText/skipWarmup, synthesisTimeoutMs,
// defaultOptions (PiperInferenceOptions: modelPath, configPath, outputFile,
// outputFormat, speakerId, noiseScale, noiseWScale, lengthScale,
// sentenceSilence, jsonInput, numThreads, useCuda, logLevel, timeoutMs)
```

`PiperTTS.create` performs a warm-up inference unless `skipWarmup` is set.
See `examples/example.ts`.

## Common failures

- `model file not found`: verify `modelPath` is correct.
- `unknown model "..."`: call `listPiperModels()` and use one of returned ids, or set `model: "custom"`.
- `onnxruntime-node could not be loaded`: reinstall dependencies (`npm install`).
- `No module named piper` / `Python not found` (wrapper only): install Python 3 and the Piper module, verify `python3 -m piper --help`.
- Process exits with code non-zero (wrapper only): inspect stderr in the thrown error.

## Version compatibility

| Component | Supported |
|---|---|
| Node.js | 18+ |
| TypeScript | 5+ |
| Runtime | Linux x64/arm64, Windows x64 |

Notes:

- Native inference needs no Python; only the legacy wrapper does.
- Actual CUDA availability depends on your Piper model and host GPU setup.

## Development

```bash
npm install
npm run build
npm run typecheck
npm test
```

## Changelog

### 1.2.0 — Native-first README

- README rewritten around `PiperNativeTTS`: the CLI wrapper moves to a
  clearly-labeled legacy section; no Python in setup, platform, or API docs.

### 1.1.6 — Examples and hot-loop audit

- `examples/example-native.ts`: same flow as `example.ts`, fully in-process.
- `resolveModelPathFromOptions` now public (catalog ids for native users).
- Performance audit: g2pw label building O(n²)→O(n), char lookups → Map/Set,
  index-based wordize, bulk int16 writes, fused audio pipeline (≤1 LSB),
  `matchAll` Thai runs, zero-copy WAV parse. Inference was already 99%+.

### 1.1.5 — Install fix

- `npm i` failed: the `install` script was absent from the tarball.
  `files` now ships `scripts/install-bridge.js`, `binding.gyp`, and the
  bridge C source (verified with a blank-dir end-user install).

### 1.1.4 — Build and CI fixes

- espeak bridge compiles on strict glibc (`_GNU_SOURCE` for `RTLD_DEFAULT`).
- `lint`/`check`/`typecheck` battery green: root `biome.json`
  (`useNamingConvention` off — public API and upstream `snake_case` must
  stay), all other violations fixed, no logic changes.
- CI cache key `bun.lockb` → `bun.lock`, real `tsc --noEmit` step,
  `bun.lock` synced (missing `opusscript`/`lindera`/`pyodide` broke CI tests).
- Prebuild matrix: linux x64/arm64 + mac arm64 green; Windows dropped
  (choco ships no dev headers — CLI fallback covers it).

### 1.1.3 — Package contents

- Compiled `*.test.js` no longer ships in the npm tarball
  (`tsconfig.build.json`; typecheck still covers tests).
- linux-x64 bridge prebuild ships inside the tarball (built in CI).

### 1.1.2 — Portable bridge build

- espeak bridge resolves `espeak_TextToPhonemesWithTerminator` at runtime
  (`dlsym`/`GetProcAddress`): old headers compile, pre-1.52 libraries
  degrade to single-clause output.
- `prebuild` script renamed to `build:prebuilds` (npm treated it as a
  pre-hook of `build`, running prebuildify on every build).

### 1.1.1 — Optional bridge install

- npm auto-runs `node-gyp rebuild` for packages with a root `binding.gyp`;
  the new tolerant `scripts/install-bridge.js` prefers prebuilds, tries a
  source build, and warns instead of failing (CLI fallback).

### 1.1.0 — Native inference (no Python required)

Measured on `en_US-lessac-medium`: ~2.2s/line (CLI wrapper) vs ~0.22s/line
(native) — roughly 10x, from killing the per-call Python spawn + model reload.

Added:

- `PiperNativeTTS` — persistent in-process ONNX session (`onnxruntime-node`),
  one inference per sentence, streaming chunks.
- All 7 `phoneme_type` values ported and verified byte-identical (or
  equivalent) against the Python reference:
  - `espeak`/`text` — N-API bridge (byte-identical clauses) with CLI fallback.
  - `hebrew` — Nakdimon ONNX + 494 lines of IPA rules, identical outputs.
  - `lithuanian` — espeak + 189k-entry stress dictionary, identical outputs.
  - `pinyin` — full g2pW BERT port (WordPiece, features, 159MB graph);
    polyphonic disambiguation works (`银行→yínháng`).
  - `thai` — real TLTK unmodified under Pyodide/WASM, 7/7 identical.
  - `japanese` — lindera-wasm + UniDic segmentation with a TS morae engine,
    4/4 segment-identical to pyopenjtalk (no lexical pitch accent — UniDic
    ships no accent data; documented limitation).
  - Arabic `ar` voices get tashkeel diacritization automatically.
- Output formats `wav`/`raw`/`mp3`/`ogg`/`opus` in both engines: ffmpeg when
  present, otherwise pure-JS fallbacks (lamejs for mp3, opusscript + Ogg
  muxer for opus — 0.993 correlation vs source).
- Phonemizer data downloads on demand into `./piper-data/` (g2pw ~280MB,
  UniDic ~200MB, TLTK ~20MB, others small).
- espeak bridge prebuilds (`prebuildify`, CI matrix linux/win/macos).
- `bun test` suite: 71 tests (RBNF tables, transformer vectors, Ogg CRC,
  gated real-model e2e). `npm test` was broken (`biome test` does not exist).
- Wrapper hardening: honest `outputFormat`, numeric range validation,
  synthesis timeouts, streaming catalog downloads with size/md5 checks,
  executable checks with PATHEXT support, skippable warm-up.

Not ported (documented): `marine` accent model, Pyodide-independent Thai,
lexical Japanese pitch accent.

### 1.0.3 and earlier

Thin TypeScript wrapper around `python3 -m piper`: process spawn per call,
WAV-or-tempfile output, Hugging Face catalog helpers.
