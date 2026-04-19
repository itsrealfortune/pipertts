# pipertts

Lightweight TypeScript wrapper around [Piper](https://github.com/rhasspy/piper) for local, offline text-to-speech.

`pipertts` handles process spawning, option mapping, and file/buffer output so you can use Piper from Node.js with a typed API.

## What you get

- Typed API (`PiperTTS`, `PiperInferenceOptions`, `SynthesisResult`)
- Cross-platform binary resolution for:
  - Linux x64
  - Linux arm64
  - Windows x64
- Startup warm-up inference to fail fast if model/binary is invalid
- Audio output as `Buffer` or direct file write

## Platform support

| OS | Architecture | Auto-detected binary path |
|---|---|---|
| Linux | x64 | `bin/linux-x64/piper` |
| Linux | arm64 | `bin/linux-arm64/piper` |
| Windows | x64 | `bin/win32-x64/piper.exe` |

If you need a custom location, pass `piperBinaryPath` to `PiperTTS.create(...)`.

## Install

```bash
npm install pipertts
```

## Required setup

`pipertts` does not ship Piper voice models.

By default, `npm install pipertts` runs a `postinstall` step that downloads the matching Piper binary for your current platform and stores it under `bin/<platform-arch>/`.

1. Download a `.onnx` model (and its `.onnx.json`) from the Piper project.
2. Keep the auto-downloaded binary, or place your own binary manually in the same target path.

Expected layout:

```text
node_modules/pipertts/bin/
  linux-x64/piper
  linux-arm64/piper
  win32-x64/piper.exe
```

Piper releases: <https://github.com/rhasspy/piper/releases>

Postinstall controls:

- `PIPERTTS_SKIP_POSTINSTALL=1`: skip binary download.
- `PIPERTTS_PIPER_VERSION=vX.Y.Z`: pin a specific Piper release tag instead of latest.

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
| `modelPath` | `string` | yes | - |
| `piperBinaryPath` | `string` | no | auto-detected from `bin/` |
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
- `bundled binary not found`: verify binary exists in the expected `bin/<platform>-<arch>/` path.
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
