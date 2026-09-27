# pipertts

Lightweight TypeScript wrapper around [Piper](https://github.com/rhasspy/piper) for local, offline text-to-speech.

`pipertts` handles process spawning, option mapping, and file/buffer output so you can use Piper from Node.js with a typed API.

## What you get

- Typed API (`PiperTTS`, `PiperInferenceOptions`, `SynthesisResult`)
- Uses `python3 -m piper` as the default runtime command
- Catalog model selection via Hugging Face (`listPiperModels()`)
- Auto-download of selected catalog model (`.onnx` + `.onnx.json`) into `models/`
- Cross-platform support for:
  - Linux x64
  - Linux arm64
  - Windows x64
- Startup warm-up inference to fail fast if model/binary is invalid
- Audio output as `Buffer` or direct file write

## Platform support

| OS | Architecture | Requirement |
|---|---|---|
| Linux | x64 | `python3` (or `python`) + Piper Python module |
| Linux | arm64 | `python3` (or `python`) + Piper Python module |
| Windows | x64 | `python3` (or `python`) + Piper Python module |

If you prefer not to use `PATH`, pass `piperBinaryPath` to `PiperTTS.create(...)`.

## Install

```bash
npm install pipertts
```

## Required setup

`pipertts` does not ship Piper voice models.

This package also does not download or bundle the Piper executable.

1. Download a `.onnx` model (and its `.onnx.json`) from the Piper project.
2. Install Python and the Piper module locally.
3. Verify `python3 -m piper --help` works (or `python -m piper --help`).
4. Optional: pass `piperBinaryPath` in code if you want to use a custom executable.

Piper releases: <https://github.com/rhasspy/piper/releases>

## Quick start

```ts
import { PiperTTS } from "pipertts";
import * as fs from "node:fs";

async function main() {
  const tts = await PiperTTS.create({
    modelPath: "./models/en_US-lessac-medium.onnx",
    defaultOptions: {
      outputFormat: "wav",
      lengthScale: 0.9,
    },
  });

  const result = await tts.synthesize("Hello from Piper.");
  fs.writeFileSync("./hello.wav", result.audio);
  console.log(`Synthesis took ${result.durationMs}ms`);

  await tts.synthesizeToFile("Saved directly to disk.", "./direct.wav", {
    speakerId: 0,
  });
}

main().catch(console.error);
```

## Catalog models (Hugging Face) and custom mode

```ts
import {
  PiperTTS,
  getPiperModelMetadata,
  getPiperModelsByLanguage,
  listPiperModels,
} from "pipertts";

const models = await listPiperModels();
console.log(models.slice(0, 5)); // first catalog ids + "custom"

const metadata = await getPiperModelMetadata("en_US-lessac-medium");
console.log(metadata?.languageCode, metadata?.quality, metadata?.numSpeakers);

const englishModels = await getPiperModelsByLanguage("en");
const frenchModels = await getPiperModelsByLanguage("fr_FR");
console.log(englishModels.length, frenchModels.length);

// Auto-downloads model + .json into ./models by default
const tts = await PiperTTS.create({
  model: "en_US-lessac-medium",
  modelsDir: "./models",
});

// For your own local model path:
const customTts = await PiperTTS.create({
  model: "custom",
  modelPath: "./models/my-voice.onnx",
});
```

`getPiperModelMetadata("custom")` returns `null`.
`getPiperModelsByLanguage("en")` matches all variants like `en_US`, `en_GB`, etc.

## Native inference (`PiperNativeTTS`)

In-process synthesis: no per-call Python spawn, the ONNX session stays warm.
Measured on `en_US-lessac-medium`: ~2.2s/line (wrapper) vs ~0.4s/line (native).

```ts
import { PiperNativeTTS } from "pipertts";

const tts = await PiperNativeTTS.load({
  modelPath: "./models/en_US-lessac-medium.onnx",
});

const wav = await tts.synthesize("Hello from the native pipeline.");
const mp3 = await tts.synthesize("Compressed.", { outputFormat: "mp3" });
```

Run the example: `npx tsx examples/native.ts` (needs a model in `models/`).

Supported `phoneme_type`: `espeak`, `text`, `hebrew` (Nakdimon ONNX + rules),
`lithuanian` (espeak + stress dictionary), `pinyin` (g2pw BERT ONNX +
WordPiece, ~280MB download on first use into `./piper-data/g2pw/`),
`thai` (real TLTK under Pyodide/WASM, ~20MB data into `./piper-data/tltk/`,
first call takes a few seconds, later calls are fast),
`japanese` (lindera-wasm + UniDic, ~200MB data into `./piper-data/unidic/`;
segments exact, **no lexical pitch accent** — UniDic ships no accent data).

All 7 `phoneme_type` values are now supported natively; no Python needed.

Phonemizer data (Nakdimon, tashkeel, Lithuanian TSVs) auto-downloads once
into `./piper-data/` (override with `nativeDataDir` or explicit paths).
Arabic `ar` voices are diacritized with tashkeel automatically.

Output formats: `wav`, `raw`, `mp3`, `ogg`, `opus`. `mp3`/`ogg`/`opus`
transcode from WAV via `ffmpeg` when available, else pure-JS fallbacks
(lamejs for `mp3`, opusscript + Ogg muxer for `opus`; `ogg` needs ffmpeg).

Espeak bridge: `src/native/espeak-bridge/` is an N-API port of
`espeakbridge.c` (byte-identical phonemes). Prebuilds ship with the package
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
import { PiperTTS } from "pipertts";

const tts = await PiperTTS.create({
  modelPath: "./models/en_US-lessac-medium.onnx",
});
```

CommonJS:

```js
const { PiperTTS } = require("pipertts");

async function boot() {
  const tts = await PiperTTS.create({
    modelPath: "./models/en_US-lessac-medium.onnx",
  });

  await tts.synthesizeToFile("Hello from CommonJS", "./cjs.wav");
}

boot().catch(console.error);
```

## API

### `PiperTTS.create(options)`

Creates an instance, resolves the binary path, validates the model path, and runs a warm-up inference.

| Option | Type | Required | Default |
|---|---|---|---|
| `model` | `string` | no | - |
| `modelPath` | `string` | no | required when `model` is `"custom"` or omitted |
| `modelsDir` | `string` | no | `"models"` |
| `piperBinaryPath` | `string` | no | `python3 -m piper` (fallback: `python -m piper`) |
| `warmUpText` | `string` | no | `"Hello, this is a warm-up test."` |
| `defaultOptions` | `Omit<PiperInferenceOptions, "modelPath">` | no | `{}` |

### `tts.synthesize(text, options?)`

Synthesizes text and returns:

- `audio: Buffer`
- `durationMs: number`
- `text: string`
- `options: PiperInferenceOptions` (effective merged options)

Example:

```ts
const result = await tts.synthesize("Fast speech", {
  lengthScale: 0.75,
  noiseScale: 0.5,
  speakerId: 1,
});
```

### `tts.synthesizeToFile(text, outputPath, options?)`

Convenience wrapper around `synthesize` that writes to `outputPath`.

```ts
await tts.synthesizeToFile("Write to file", "./output.wav", {
  sentenceSilence: 0.1,
});
```

## Inference options

| Option | Type | Default | Notes |
|---|---|---|---|
| `modelPath` | `string` | instance model | Per-call model override |
| `configPath` | `string` | auto (`<model>.json`) | Explicit model config path |
| `outputFile` | `string` | temp file | If set, writes directly there |
| `outputFormat` | `"raw" \| "wav" \| "mp3" \| "ogg" \| "opus"` | `"wav"` | `mp3`/`ogg`/`opus` transcode from WAV (ffmpeg, else pure-JS fallbacks) |
| `speakerId` | `number` | - | For multi-speaker models |
| `noiseScale` | `number` | `0.667` | Voice variability |
| `noiseWScale` | `number` | `0.8` | Timing variability |
| `lengthScale` | `number` | `1.0` | `>1` slower, `<1` faster |
| `sentenceSilence` | `number` | `0.2` | Seconds |
| `jsonInput` | `boolean` | `false` | Enables Piper `--json-input` |
| `numThreads` | `number` | CPU count | ONNX threads |
| `useCuda` | `boolean` | `false` | GPU acceleration |
| `logLevel` | `"debug" \| "info" \| "warn" \| "error"` | `"warn"` | Piper logging verbosity |

## Common failures

- `model file not found`: verify `modelPath` is correct.
- `unknown model "..."`: call `listPiperModels()` and use one of returned ids, or set `model: "custom"`.
- `Python not found in PATH`: install Python 3 and verify `python3 --version`.
- `No module named piper`: install Piper Python module and verify `python3 -m piper --help`.
- Process exits with code non-zero: inspect stderr in the thrown error for missing model/config or unsupported flags.

## Version compatibility

| Component | Supported |
|---|---|
| Node.js | 18+ |
| TypeScript | 5+ |
| Runtime | Linux x64/arm64, Windows x64 |

Notes:

- This package wraps the Piper CLI and requires an external Piper model file (`.onnx`).
- Actual CUDA availability depends on your Piper binary build and host GPU setup.

## Development

```bash
npm install
npm run build
npm run typecheck
npm test
```

## Changelog

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
