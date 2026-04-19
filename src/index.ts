import { spawn, SpawnOptions } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ---------------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------------

/**
 * Supported output audio formats for PiperTTS.
 */
export type PiperOutputFormat = "raw" | "wav" | "mp3" | "ogg";

/**
 * Noise scale controls the variability in the generated audio.
 * Higher values produce more expressive (but potentially less stable) output.
 * Range: 0.0 – 2.0 (default: 0.667)
 */
export type NoiseScale = number;

/**
 * Noise W scale (duration noise) controls timing variability.
 * Range: 0.0 – 2.0 (default: 0.8)
 */
export type NoiseWScale = number;

/**
 * Length scale controls the speaking speed.
 * Values > 1.0 slow down speech; values < 1.0 speed it up.
 * Range: 0.1 – 10.0 (default: 1.0)
 */
export type LengthScale = number;

/**
 * Sentence silence duration in seconds appended after each sentence.
 * Range: 0.0 – 10.0 (default: 0.2)
 */
export type SentenceSilence = number;

/**
 * Full set of inference parameters accepted by PiperTTS.
 */
export interface PiperInferenceOptions {
  /**
   * Path to the `.onnx` voice model file.
   * If omitted, the model path provided at construction time is used.
   */
  modelPath?: string;

  /**
   * Path to the model configuration JSON file (`.onnx.json`).
   * If omitted, Piper will look for `<modelPath>.json` automatically.
   */
  configPath?: string;

  /**
   * Output file path. When provided, Piper writes the audio directly to
   * this file. Mutually exclusive with streaming to a buffer.
   * @example "/tmp/output.wav"
   */
  outputFile?: string;

  /**
   * Output audio format.
   * @default "wav"
   */
  outputFormat?: PiperOutputFormat;

  /**
   * Speaker ID for multi-speaker models.
   * Ignored for single-speaker models.
   */
  speakerId?: number;

  /**
   * Controls audio variability / expressiveness.
   * @default 0.667
   */
  noiseScale?: NoiseScale;

  /**
   * Controls duration/timing variability.
   * @default 0.8
   */
  noiseWScale?: NoiseWScale;

  /**
   * Speech rate multiplier (higher = slower).
   * @default 1.0
   */
  lengthScale?: LengthScale;

  /**
   * Silence appended after each sentence, in seconds.
   * @default 0.2
   */
  sentenceSilence?: SentenceSilence;

  /**
   * JSON string or object specifying phoneme-level overrides.
   * Passed as-is to the `--json-input` flag when enabled.
   */
  jsonInput?: boolean;

  /**
   * Number of threads used for ONNX inference.
   * Defaults to the number of logical CPU cores.
   */
  numThreads?: number;

  /**
   * Use CUDA GPU acceleration if available.
   * @default false
   */
  useCuda?: boolean;

  /**
   * Log level passed to Piper: "debug" | "info" | "warn" | "error".
   * @default "warn"
   */
  logLevel?: "debug" | "info" | "warn" | "error";
}

/**
 * Constructor options for {@link PiperTTS}.
 */
export interface PiperTTSOptions {
  /**
   * Path to the `.onnx` voice model file to load at construction time.
   * A warm-up inference is performed to validate the model.
   */
  modelPath: string;

  /**
   * Optional explicit path to the Piper binary.
   * When omitted the bundled binary for the current platform is used.
   */
  piperBinaryPath?: string;

  /**
   * Text used for the warm-up inference that validates the model.
   * @default "Hello, this is a warm-up test."
   */
  warmUpText?: string;

  /**
   * Default inference options applied to every {@link PiperTTS.synthesize} call
   * unless overridden per-call.
   */
  defaultOptions?: Omit<PiperInferenceOptions, "modelPath">;
}

/**
 * Result returned by {@link PiperTTS.synthesize}.
 */
export interface SynthesisResult {
  /** Raw audio buffer (PCM/WAV/MP3/OGG depending on `outputFormat`). */
  audio: Buffer;
  /** Duration of the synthesis process in milliseconds. */
  durationMs: number;
  /** The text that was synthesised. */
  text: string;
  /** Effective options used for this synthesis. */
  options: PiperInferenceOptions;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns the absolute path to the bundled Piper binary for the current
 * platform/architecture.
 *
 * Expected layout inside the package:
 * ```
 * bin/
 *   linux-x64/piper
 *   linux-arm64/piper
 *   win32-x64/piper.exe
 * ```
 *
 * @throws {Error} When the current platform is not supported.
 * @internal
 */
function resolveBundledBinary(): string {
  const platform = os.platform(); // "linux" | "win32" | "darwin" …
  const arch = os.arch(); // "x64" | "arm64" …

  const dirMap: Record<string, Record<string, string>> = {
    linux: {
      x64: "linux-x64",
      arm64: "linux-arm64",
    },
    win32: {
      x64: "win32-x64",
    },
  };

  const platformDirs = dirMap[platform];
  if (!platformDirs) {
    throw new Error(
      `PiperTTS: unsupported platform "${platform}". ` +
        `Supported platforms: linux (x64, arm64), win32 (x64).`
    );
  }

  const dirName = platformDirs[arch];
  if (!dirName) {
    throw new Error(
      `PiperTTS: unsupported architecture "${arch}" on platform "${platform}".`
    );
  }

  const binaryName = platform === "win32" ? "piper.exe" : "piper";

  // __dirname points to dist/ at runtime; bin/ is at the package root.
  const packageRoot = path.resolve(__dirname, "..");
  const binaryPath = path.join(packageRoot, "bin", dirName, binaryName);

  if (!fs.existsSync(binaryPath)) {
    throw new Error(
      `PiperTTS: bundled binary not found at "${binaryPath}". ` +
        `Please place the Piper binary for "${platform}-${arch}" in that location.`
    );
  }

  return binaryPath;
}

/**
 * Builds the CLI argument array for a Piper invocation.
 *
 * @param modelPath  - Resolved path to the `.onnx` model.
 * @param options    - Inference options.
 * @param outputFile - Temporary or final output file path (or `-` for stdout).
 * @internal
 */
function buildArgs(
  modelPath: string,
  options: PiperInferenceOptions,
  outputFile: string
): string[] {
  const args: string[] = [];

  // Model
  args.push("--model", modelPath);

  // Config (optional – Piper auto-discovers `<model>.json` when omitted)
  if (options.configPath) {
    args.push("--config", options.configPath);
  }

  // Output
  if (outputFile === "-") {
    args.push("--output-raw"); // raw PCM to stdout
  } else {
    args.push("--output-file", outputFile);
  }

  // Speaker
  if (options.speakerId !== undefined) {
    args.push("--speaker", String(options.speakerId));
  }

  // Synthesis parameters
  if (options.noiseScale !== undefined) {
    args.push("--noise-scale", String(options.noiseScale));
  }
  if (options.noiseWScale !== undefined) {
    args.push("--noise-w", String(options.noiseWScale));
  }
  if (options.lengthScale !== undefined) {
    args.push("--length-scale", String(options.lengthScale));
  }
  if (options.sentenceSilence !== undefined) {
    args.push("--sentence-silence", String(options.sentenceSilence));
  }

  // JSON phoneme input
  if (options.jsonInput) {
    args.push("--json-input");
  }

  // Threading
  if (options.numThreads !== undefined) {
    args.push("--num-threads", String(options.numThreads));
  }

  // CUDA
  if (options.useCuda) {
    args.push("--cuda");
  }

  // Log level
  if (options.logLevel) {
    args.push("--debug"); // Piper only has --debug; map "debug" → flag, rest → silence
    // Real Piper builds use --log-level; adjust if your binary supports it.
  }

  return args;
}

// ---------------------------------------------------------------------------
// Main class
// ---------------------------------------------------------------------------

/**
 * High-level TypeScript wrapper around the PiperTTS CLI binary.
 *
 * ## Quick start
 * ```typescript
 * import { PiperTTS } from "piper-tts-node";
 * import * as fs from "fs";
 *
 * const tts = await PiperTTS.create({
 *   modelPath: "./models/en_US-lessac-medium.onnx",
 * });
 *
 * const result = await tts.synthesize("Hello, world!");
 * fs.writeFileSync("hello.wav", result.audio);
 * ```
 *
 * ## Notes
 * - Place your Piper binaries under `bin/<platform>-<arch>/piper[.exe]`.
 * - Models are **not** bundled; download them from the Piper releases page.
 * - The constructor is private – always use the static {@link PiperTTS.create}
 *   factory so that async model validation is awaited properly.
 */
export class PiperTTS {
  /** Resolved path to the Piper CLI binary. */
  private readonly binaryPath: string;

  /** Resolved path to the default `.onnx` model. */
  private readonly modelPath: string;

  /** Default inference options merged into every {@link synthesize} call. */
  private readonly defaultOptions: PiperInferenceOptions;

  // Private constructor – use PiperTTS.create()
  private constructor(
    binaryPath: string,
    modelPath: string,
    defaultOptions: PiperInferenceOptions
  ) {
    this.binaryPath = binaryPath;
    this.modelPath = modelPath;
    this.defaultOptions = defaultOptions;
  }

  // -------------------------------------------------------------------------
  // Static factory
  // -------------------------------------------------------------------------

  /**
   * Creates a new {@link PiperTTS} instance and validates the model by
   * running a warm-up inference.
   *
   * @param options - Construction options. At minimum `modelPath` is required.
   * @returns A fully initialised `PiperTTS` instance.
   *
   * @example
   * ```typescript
   * const tts = await PiperTTS.create({
   *   modelPath: "./models/en_US-lessac-medium.onnx",
   *   defaultOptions: { lengthScale: 0.9, noiseScale: 0.5 },
   * });
   * ```
   *
   * @throws {Error} When the model file is not found.
   * @throws {Error} When the Piper binary cannot be located.
   * @throws {Error} When the warm-up inference fails.
   */
  static async create(options: PiperTTSOptions): Promise<PiperTTS> {
    const {
      modelPath,
      piperBinaryPath,
      warmUpText = "Hello, this is a warm-up test.",
      defaultOptions = {},
    } = options;

    // Resolve & validate model path
    const resolvedModel = path.resolve(modelPath);
    if (!fs.existsSync(resolvedModel)) {
      throw new Error(`PiperTTS: model file not found at "${resolvedModel}".`);
    }

    // Resolve binary
    const resolvedBinary = piperBinaryPath
      ? path.resolve(piperBinaryPath)
      : resolveBundledBinary();

    if (!fs.existsSync(resolvedBinary)) {
      throw new Error(
        `PiperTTS: binary not found at "${resolvedBinary}".`
      );
    }

    // Ensure the binary is executable (Linux/macOS)
    if (os.platform() !== "win32") {
      fs.chmodSync(resolvedBinary, 0o755);
    }

    const instance = new PiperTTS(resolvedBinary, resolvedModel, defaultOptions);

    // Warm-up inference
    await instance.synthesize(warmUpText, { outputFormat: "wav" });

    return instance;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Synthesises speech for the given text and returns the audio as a
   * {@link Buffer}.
   *
   * Per-call options are merged on top of the default options provided at
   * construction time. Explicit `undefined` values in `callOptions` do **not**
   * override defaults.
   *
   * @param text        - The text to synthesise. Must not be empty.
   * @param callOptions - Inference options that override the instance defaults
   *                      for this call only.
   * @returns A {@link SynthesisResult} containing the audio buffer and metadata.
   *
   * @example
   * ```typescript
   * // Basic usage
   * const result = await tts.synthesize("Good morning!");
   * fs.writeFileSync("morning.wav", result.audio);
   *
   * // With per-call overrides
   * const fast = await tts.synthesize("Fast speech.", { lengthScale: 0.7 });
   *
   * // Different speaker on a multi-speaker model
   * const s2 = await tts.synthesize("Speaker two.", { speakerId: 1 });
   *
   * // Write directly to a file (no in-memory buffer)
   * await tts.synthesize("Save to disk.", { outputFile: "./out.wav" });
   * ```
   *
   * @throws {Error} When `text` is empty.
   * @throws {Error} When Piper exits with a non-zero status code.
   */
  async synthesize(
    text: string,
    callOptions: PiperInferenceOptions = {}
  ): Promise<SynthesisResult> {
    if (!text || text.trim().length === 0) {
      throw new Error("PiperTTS.synthesize: text must not be empty.");
    }

    // Merge default options with per-call overrides
    const effectiveOptions: PiperInferenceOptions = {
      ...this.defaultOptions,
      ...Object.fromEntries(
        Object.entries(callOptions).filter(([, v]) => v !== undefined)
      ),
    };

    const modelPath = effectiveOptions.modelPath ?? this.modelPath;
    const useOutputFile = effectiveOptions.outputFile;

    // If the caller wants a specific output file we write there directly,
    // otherwise we use a temp file and load it into a buffer.
    let tmpFile: string | null = null;
    let targetFile: string;

    if (useOutputFile) {
      targetFile = path.resolve(useOutputFile);
    } else {
      tmpFile = path.join(
        os.tmpdir(),
        `piper_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`
      );
      targetFile = tmpFile;
    }

    const args = buildArgs(modelPath, effectiveOptions, targetFile);

    const startMs = Date.now();

    await this._runPiper(text, args);

    const durationMs = Date.now() - startMs;

    // Read output
    const audio = fs.readFileSync(targetFile);

    // Clean up temp file
    if (tmpFile) {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // Best-effort cleanup
      }
    }

    return {
      audio,
      durationMs,
      text,
      options: effectiveOptions,
    };
  }

  /**
   * Synthesises speech and writes the result directly to `outputPath`.
   *
   * This is a convenience wrapper around {@link synthesize} when you only
   * care about the file on disk and not the in-memory buffer.
   *
   * @param text       - The text to synthesise.
   * @param outputPath - Destination file path (e.g. `"./output.wav"`).
   * @param options    - Additional inference options.
   *
   * @example
   * ```typescript
   * await tts.synthesizeToFile("Save me.", "./saved.wav");
   * ```
   */
  async synthesizeToFile(
    text: string,
    outputPath: string,
    options: Omit<PiperInferenceOptions, "outputFile"> = {}
  ): Promise<void> {
    await this.synthesize(text, { ...options, outputFile: outputPath });
  }

  /**
   * Returns the resolved path of the default model loaded at construction.
   */
  getModelPath(): string {
    return this.modelPath;
  }

  /**
   * Returns the resolved path of the Piper binary in use.
   */
  getBinaryPath(): string {
    return this.binaryPath;
  }

  /**
   * Returns a copy of the default inference options.
   */
  getDefaultOptions(): Readonly<PiperInferenceOptions> {
    return { ...this.defaultOptions };
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Spawns the Piper binary, writes `text` to its stdin, and resolves when
   * the process exits successfully.
   *
   * @param text - Input text fed to Piper's stdin.
   * @param args - CLI arguments array.
   * @internal
   */
  private _runPiper(text: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const spawnOptions: SpawnOptions = {
        stdio: ["pipe", "pipe", "pipe"],
      };

      const child = spawn(this.binaryPath, args, spawnOptions);

      const stderrChunks: Buffer[] = [];

      child.stderr?.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });

      child.on("error", (err) => {
        reject(
          new Error(
            `PiperTTS: failed to spawn binary "${this.binaryPath}": ${err.message}`
          )
        );
      });

      child.on("close", (code) => {
        if (code !== 0) {
          const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
          reject(
            new Error(
              `PiperTTS: process exited with code ${code}.\nStderr: ${stderr}`
            )
          );
        } else {
          resolve();
        }
      });

      // Write text to stdin and close the stream
      if (child.stdin) {
        child.stdin.write(text, "utf8");
        child.stdin.end();
      } else {
        reject(new Error("PiperTTS: stdin is not available on child process."));
      }
    });
  }
}
