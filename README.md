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
| `outputFormat` | `"raw" \| "wav" \| "mp3" \| "ogg"` | `"wav"` | Audio format |
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
```
