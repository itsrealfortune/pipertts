import { type SpawnOptions, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
	modelPath?: string;

	/**
	 * Model selector.
	 * - Use a catalog id (from {@link listPiperModels}) to auto-download to `modelsDir`.
	 * - Use `"custom"` to force local `modelPath` usage.
	 */
	model?: string;

	/**
	 * Target folder used when downloading catalog models.
	 * @default "models"
	 */
	modelsDir?: string;

	/**
	 * Optional explicit executable path or command name.
	 * When omitted, `python3 -m piper` is used (fallback: `python -m piper`).
	 *
	 * Examples: `/usr/bin/piper`, `C:\\tools\\piper.exe`, `python3`.
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

interface PiperVoicesManifestEntry {
	key: string;
	name?: string;
	quality?: string;
	num_speakers?: number;
	language?: {
		code?: string;
		family?: string;
		region?: string;
		name_native?: string;
		name_english?: string;
		country_english?: string;
	};
	aliases?: string[];
	files: Record<string, { size_bytes?: number; md5_digest?: string }>;
}

export interface PiperModelMetadata {
	key: string;
	name?: string;
	quality?: string;
	numSpeakers?: number;
	languageCode?: string;
	languageNameEnglish?: string;
	languageNameNative?: string;
	aliases: string[];
	filePaths: string[];
}

const PIPER_VOICES_URL =
	"https://huggingface.co/rhasspy/piper-voices/resolve/main/voices.json";
const PIPER_FILES_BASE_URL =
	"https://huggingface.co/rhasspy/piper-voices/resolve/main";
const PIPER_CUSTOM_MODEL = "custom";

let voicesManifestCache: Record<string, PiperVoicesManifestEntry> | null = null;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveBinaryFromPath(binaryName: string): string | null {
	const pathEnv = process.env.PATH ?? "";
	const pathDirs = pathEnv.split(path.delimiter).filter(Boolean);

	for (const dir of pathDirs) {
		const candidate = path.join(dir, binaryName);
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}

	return null;
}

async function fetchVoicesManifest(): Promise<
	Record<string, PiperVoicesManifestEntry>
> {
	if (voicesManifestCache) {
		return voicesManifestCache;
	}

	const response = await fetch(PIPER_VOICES_URL);
	if (!response.ok) {
		throw new Error(
			`PiperTTS: unable to fetch Piper voices manifest (${response.status}).`,
		);
	}

	const json = (await response.json()) as Record<
		string,
		PiperVoicesManifestEntry
	>;
	voicesManifestCache = json;
	return json;
}

/**
 * Returns all known Piper catalog model ids plus `"custom"`.
 */
export async function listPiperModels(): Promise<string[]> {
	const manifest = await fetchVoicesManifest();
	return [...Object.keys(manifest).sort(), PIPER_CUSTOM_MODEL];
}

/**
 * Returns catalog model ids filtered by language.
 *
 * Matching rules:
 * - exact code match (example: `en_US`)
 * - language family prefix (example: `en` matches `en_US`, `en_GB`, ...)
 */
export async function getPiperModelsByLanguage(
	languageCode: string,
): Promise<string[]> {
	const normalized = languageCode.trim();
	if (!normalized) {
		throw new Error("PiperTTS: languageCode must not be empty.");
	}

	const manifest = await fetchVoicesManifest();
	const codeLower = normalized.toLowerCase();

	return Object.values(manifest)
		.filter((entry) => {
			const entryCode = entry.language?.code?.toLowerCase();
			if (!entryCode) {
				return false;
			}

			return entryCode === codeLower || entryCode.startsWith(`${codeLower}_`);
		})
		.map((entry) => entry.key)
		.sort();
}

/**
 * Returns metadata for a catalog model id or alias.
 * Returns `null` for `"custom"`.
 */
export async function getPiperModelMetadata(
	modelId: string,
): Promise<PiperModelMetadata | null> {
	if (modelId === PIPER_CUSTOM_MODEL) {
		return null;
	}

	const manifest = await fetchVoicesManifest();
	const entry = resolveManifestEntry(manifest, modelId);
	if (!entry) {
		throw new Error(
			`PiperTTS: unknown model "${modelId}". Use listPiperModels() to inspect available ids.`,
		);
	}

	return {
		key: entry.key,
		name: entry.name,
		quality: entry.quality,
		numSpeakers: entry.num_speakers,
		languageCode: entry.language?.code,
		languageNameEnglish: entry.language?.name_english,
		languageNameNative: entry.language?.name_native,
		aliases: entry.aliases ?? [],
		filePaths: Object.keys(entry.files),
	};
}

function resolveManifestEntry(
	manifest: Record<string, PiperVoicesManifestEntry>,
	modelId: string,
): PiperVoicesManifestEntry | null {
	if (manifest[modelId]) {
		return manifest[modelId];
	}

	for (const entry of Object.values(manifest)) {
		if (entry.aliases?.includes(modelId)) {
			return entry;
		}
	}

	return null;
}

function selectModelFiles(entry: PiperVoicesManifestEntry): {
	onnxPath: string;
	jsonPath: string;
} {
	const files = Object.keys(entry.files);
	const onnxPath = files.find((file) => file.endsWith(".onnx"));
	const jsonPath = files.find((file) => file.endsWith(".onnx.json"));

	if (!onnxPath || !jsonPath) {
		throw new Error(
			`PiperTTS: model "${entry.key}" is missing .onnx or .onnx.json in voices manifest.`,
		);
	}

	return { onnxPath, jsonPath };
}

async function downloadToFile(url: string, filePath: string): Promise<void> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(
			`PiperTTS: download failed (${response.status}) for ${url}`,
		);
	}

	const bytes = Buffer.from(await response.arrayBuffer());
	fs.writeFileSync(filePath, bytes);
}

async function ensureCatalogModelDownloaded(
	modelId: string,
	modelsDir: string,
): Promise<string> {
	const manifest = await fetchVoicesManifest();
	const entry = resolveManifestEntry(manifest, modelId);

	if (!entry) {
		throw new Error(
			`PiperTTS: unknown model "${modelId}". Use listPiperModels() to inspect available ids, or use model="custom" with modelPath.`,
		);
	}

	const { onnxPath, jsonPath } = selectModelFiles(entry);
	const targetDir = path.resolve(modelsDir);
	const targetModelPath = path.join(targetDir, path.basename(onnxPath));
	const targetJsonPath = path.join(targetDir, path.basename(jsonPath));

	if (!fs.existsSync(targetDir)) {
		fs.mkdirSync(targetDir, { recursive: true });
	}

	if (!fs.existsSync(targetModelPath)) {
		await downloadToFile(
			`${PIPER_FILES_BASE_URL}/${onnxPath}`,
			targetModelPath,
		);
	}

	if (!fs.existsSync(targetJsonPath)) {
		await downloadToFile(`${PIPER_FILES_BASE_URL}/${jsonPath}`, targetJsonPath);
	}

	return targetModelPath;
}

async function resolveModelPathFromOptions(
	options: PiperTTSOptions,
): Promise<string> {
	if (options.model && options.model !== PIPER_CUSTOM_MODEL) {
		const modelsDir = options.modelsDir ?? "models";
		return ensureCatalogModelDownloaded(options.model, modelsDir);
	}

	if (!options.modelPath) {
		throw new Error(
			"PiperTTS: modelPath is required when model is not set to a catalog id.",
		);
	}

	return path.resolve(options.modelPath);
}

function resolveExecutable(commandOrPath: string): string {
	const hasPathSeparator =
		commandOrPath.includes(path.sep) ||
		(path.sep === "\\" && commandOrPath.includes("/"));

	if (hasPathSeparator || path.isAbsolute(commandOrPath)) {
		const resolved = path.resolve(commandOrPath);
		if (!fs.existsSync(resolved)) {
			throw new Error(`PiperTTS: executable not found at "${resolved}".`);
		}
		return resolved;
	}

	const fromPath = resolveBinaryFromPath(commandOrPath);
	if (!fromPath) {
		throw new Error(
			`PiperTTS: executable "${commandOrPath}" not found in PATH.`,
		);
	}

	return fromPath;
}

/**
 * Resolves the default command used to run Piper as a Python module.
 *
 * Preferred command is `python3 -m piper`, with `python -m piper` fallback.
 *
 * @throws {Error} When Python is not available in PATH.
 * @internal
 */
function resolveSystemCommand(): {
	command: string;
	commandPrefixArgs: string[];
} {
	const pythonCmd =
		resolveBinaryFromPath("python3") || resolveBinaryFromPath("python");

	if (!pythonCmd) {
		throw new Error(
			'PiperTTS: Python not found in PATH. Install Python and the Piper module, or pass "piperBinaryPath" explicitly.',
		);
	}

	return {
		command: pythonCmd,
		commandPrefixArgs: ["-m", "piper"],
	};
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
	outputFile: string,
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
 * import { PiperTTS } from "pipertts";
 * import * as fs from "node:fs";
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
 * - Install Piper as a Python module and ensure `python3 -m piper`
 *   works in your shell (or pass `piperBinaryPath` explicitly).
 * - Models are **not** bundled; download them from the Piper releases page.
 * - The constructor is private – always use the static {@link PiperTTS.create}
 *   factory so that async model validation is awaited properly.
 */
export class PiperTTS {
	/** Resolved path to the Piper CLI binary. */
	private readonly binaryPath: string;

	/** Prefix args injected before Piper CLI args (for example: `-m piper`). */
	private readonly commandPrefixArgs: string[];

	/** Resolved path to the default `.onnx` model. */
	private readonly modelPath: string;

	/** Default inference options merged into every {@link synthesize} call. */
	private readonly defaultOptions: PiperInferenceOptions;

	// Private constructor – use PiperTTS.create()
	private constructor(
		binaryPath: string,
		commandPrefixArgs: string[],
		modelPath: string,
		defaultOptions: PiperInferenceOptions,
	) {
		this.binaryPath = binaryPath;
		this.commandPrefixArgs = commandPrefixArgs;
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
			piperBinaryPath,
			warmUpText = "Hello, this is a warm-up test.",
			defaultOptions = {},
		} = options;

		// Resolve & validate model path
		const resolvedModel = await resolveModelPathFromOptions(options);
		if (!fs.existsSync(resolvedModel)) {
			throw new Error(`PiperTTS: model file not found at "${resolvedModel}".`);
		}

		// Resolve command
		let resolvedBinary: string;
		let commandPrefixArgs: string[];

		if (piperBinaryPath) {
			resolvedBinary = resolveExecutable(piperBinaryPath);
			commandPrefixArgs = [];
		} else {
			const systemCommand = resolveSystemCommand();
			resolvedBinary = systemCommand.command;
			commandPrefixArgs = systemCommand.commandPrefixArgs;
		}

		if (!fs.existsSync(resolvedBinary)) {
			throw new Error(`PiperTTS: executable not found at "${resolvedBinary}".`);
		}

		// Ensure explicit binary paths are executable (Linux/macOS)
		if (os.platform() !== "win32" && piperBinaryPath) {
			fs.chmodSync(resolvedBinary, 0o755);
		}

		const instance = new PiperTTS(
			resolvedBinary,
			commandPrefixArgs,
			resolvedModel,
			defaultOptions,
		);

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
		callOptions: PiperInferenceOptions = {},
	): Promise<SynthesisResult> {
		if (!text || text.trim().length === 0) {
			throw new Error("PiperTTS.synthesize: text must not be empty.");
		}

		// Merge default options with per-call overrides
		const effectiveOptions: PiperInferenceOptions = {
			...this.defaultOptions,
			...Object.fromEntries(
				Object.entries(callOptions).filter(([, v]) => v !== undefined),
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
				`piper_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`,
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
		options: Omit<PiperInferenceOptions, "outputFile"> = {},
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
	 * Returns the resolved executable path used to run Piper.
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

			const child = spawn(
				this.binaryPath,
				[...this.commandPrefixArgs, ...args],
				spawnOptions,
			);

			const stderrChunks: Buffer[] = [];

			child.stderr?.on("data", (chunk: Buffer) => {
				stderrChunks.push(chunk);
			});

			child.on("error", (err) => {
				reject(
					new Error(
						`PiperTTS: failed to spawn binary "${this.binaryPath}": ${err.message}`,
					),
				);
			});

			child.on("close", (code) => {
				if (code !== 0) {
					const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
					reject(
						new Error(
							`PiperTTS: process exited with code ${code}.\nStderr: ${stderr}`,
						),
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
