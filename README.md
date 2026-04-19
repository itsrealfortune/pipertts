# piper-tts-node

TypeScript wrapper for [PiperTTS](https://github.com/rhasspy/piper) — fast, local, neural text-to-speech.

## Features

- 🎙️ Full TypeScript API with JSDoc
- 📦 Bundled binary support (Windows x64 & Linux x64/arm64)
- 🔥 Warm-up inference on load to validate the model
- 🎛️ All PiperTTS inference parameters exposed
- 💾 Synthesize to `Buffer` or directly to a file

---

## Installation

```bash
npm install piper-tts-node
```

---

## Binary setup

You must place the Piper binary for your target platform under the `bin/` directory of this package **before** using it:

```
node_modules/piper-tts-node/bin/
  linux-x64/piper          ← Linux 64-bit
  linux-arm64/piper        ← Linux ARM64
  win32-x64/piper.exe      ← Windows 64-bit
```

Download the appropriate release from the [Piper releases page](https://github.com/rhasspy/piper/releases).

---

## Quick start

```typescript
import { PiperTTS } from "piper-tts-node";
import * as fs from "fs";

async function main() {
  // Create instance – performs a warm-up inference to validate the model
  const tts = await PiperTTS.create({
    modelPath: "./models/en_US-lessac-medium.onnx",
  });

  // Synthesize to a buffer
  const result = await tts.synthesize("Hello, world!");
  fs.writeFileSync("hello.wav", result.audio);
  console.log(`Done in ${result.durationMs}ms`);

  // Synthesize directly to a file
  await tts.synthesizeToFile("Saving to disk.", "./output.wav");
}

main().catch(console.error);
```

---

## API

### `PiperTTS.create(options)`

Static factory that creates and validates a `PiperTTS` instance.

| Option | Type | Default | Description |
|---|---|---|---|
| `modelPath` | `string` | **required** | Path to the `.onnx` model |
| `piperBinaryPath` | `string` | auto-detected | Override the bundled binary |
| `warmUpText` | `string` | `"Hello, this is a warm-up test."` | Text used for warm-up inference |
| `defaultOptions` | `PiperInferenceOptions` | `{}` | Default options for all calls |

---

### `tts.synthesize(text, options?)`

Synthesises speech and returns a `SynthesisResult`.

```typescript
const result = await tts.synthesize("Fast speech.", {
  lengthScale: 0.75,     // Speed up
  noiseScale: 0.4,       // Less variability
  speakerId: 0,          // Multi-speaker models
});

// result.audio    → Buffer (WAV by default)
// result.durationMs → number
// result.text     → string
// result.options  → effective PiperInferenceOptions
```

---

### `tts.synthesizeToFile(text, outputPath, options?)`

Convenience method – writes audio directly to a file.

```typescript
await tts.synthesizeToFile("Save me to disk.", "./out.wav", {
  lengthScale: 1.2,
});
```

---

### Inference options

| Option | Type | Default | Description |
|---|---|---|---|
| `outputFile` | `string` | — | Write audio to this path |
| `outputFormat` | `"raw" \| "wav" \| "mp3" \| "ogg"` | `"wav"` | Output format |
| `speakerId` | `number` | — | Speaker ID (multi-speaker models) |
| `noiseScale` | `number` | `0.667` | Audio variability (0–2) |
| `noiseWScale` | `number` | `0.8` | Duration variability (0–2) |
| `lengthScale` | `number` | `1.0` | Speed (>1 = slower, <1 = faster) |
| `sentenceSilence` | `number` | `0.2` | Silence after each sentence (seconds) |
| `jsonInput` | `boolean` | `false` | Enable phoneme JSON input mode |
| `numThreads` | `number` | CPU count | ONNX inference thread count |
| `useCuda` | `boolean` | `false` | Use CUDA GPU acceleration |
| `logLevel` | `"debug" \| "info" \| "warn" \| "error"` | `"warn"` | Piper log verbosity |

---

## Building from source

```bash
npm install
npm run build
```
