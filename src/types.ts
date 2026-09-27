/**
 * Supported output audio formats for PiperTTS.
 *
 * `wav` and `raw` are produced natively by the Piper CLI.
 * `mp3` / `ogg` require external transcoding (e.g. ffmpeg) and are
 * rejected explicitly by `synthesize()` instead of silently returning WAV.
 */
export type PiperOutputFormat = "raw" | "wav" | "mp3" | "ogg";

/**
 * Noise scale controls the variability in the generated audio.
 * Higher values produce more expressive (but potentially less stable) output.
 * Range: 0.0 - 2.0 (default: 0.667)
 */
export type NoiseScale = number;

/**
 * Noise W scale (duration noise) controls timing variability.
 * Range: 0.0 - 2.0 (default: 0.8)
 */
export type NoiseWScale = number;

/**
 * Length scale controls the speaking speed.
 * Values > 1.0 slow down speech; values < 1.0 speed it up.
 * Range: 0.1 - 10.0 (default: 1.0)
 */
export type LengthScale = number;

/**
 * Sentence silence duration in seconds appended after each sentence.
 * Range: 0.0 - 10.0 (default: 0.2)
 */
export type SentenceSilence = number;

/**
 * Full set of inference parameters accepted by PiperTTS.
 */
export interface PiperInferenceOptions {
	/** Path to the `.onnx` voice model file. */
	modelPath?: string;
	/** Path to the model configuration JSON file (`.onnx.json`). */
	configPath?: string;
	/** Output file path written by Piper. */
	outputFile?: string;
	/**
	 * Output audio format.
	 * - `wav`: standard WAV file (default).
	 * - `raw`: raw PCM captured from stdout (no file written by Piper).
	 * - `mp3` / `ogg`: transcoded from WAV (ffmpeg when available,
	 *   pure-JS lamejs fallback for mp3).
	 */
	outputFormat?: PiperOutputFormat;
	/** Speaker ID for multi-speaker models. Must be an integer >= 0. */
	speakerId?: number;
	/** Controls audio variability / expressiveness. Range: 0.0 - 2.0. */
	noiseScale?: NoiseScale;
	/** Controls duration/timing variability. Range: 0.0 - 2.0. */
	noiseWScale?: NoiseWScale;
	/** Speech rate multiplier (higher = slower). Range: 0.1 - 10.0. */
	lengthScale?: LengthScale;
	/** Silence appended after each sentence, in seconds. Range: 0.0 - 10.0. */
	sentenceSilence?: SentenceSilence;
	/** Enable Piper JSON phoneme input mode. */
	jsonInput?: boolean;
	/** Number of ONNX inference threads. Must be an integer >= 1. */
	numThreads?: number;
	/** Use CUDA GPU acceleration if available. */
	useCuda?: boolean;
	/**
	 * Piper log verbosity.
	 * The Piper CLI only exposes a `--debug` flag, so only `"debug"`
	 * changes the spawned arguments. Other levels are accepted for
	 * forward-compatibility and recorded in the result options.
	 */
	logLevel?: "debug" | "info" | "warn" | "error";
	/** Per-call synthesis timeout in milliseconds (positive integer). */
	timeoutMs?: number;
}

/**
 * Constructor options for {@link PiperTTS}.
 */
export interface PiperTTSOptions {
	/** Path to the `.onnx` model when using custom/local mode. */
	modelPath?: string;
	/**
	 * Model selector.
	 * - Catalog id: auto-downloads model files into `modelsDir`.
	 * - `"custom"`: use `modelPath`.
	 */
	model?: string;
	/** Directory used for auto-downloaded catalog models. */
	modelsDir?: string;
	/** Optional explicit executable path or command name. */
	piperBinaryPath?: string;
	/** Warm-up text used during startup validation. */
	warmUpText?: string;
	/** Skip the warm-up inference during `create()`. Default: `false`. */
	skipWarmup?: boolean;
	/** Default synthesis timeout in ms applied when a call omits `timeoutMs`. */
	synthesisTimeoutMs?: number;
	/** Default options merged into every synthesis call. */
	defaultOptions?: Omit<PiperInferenceOptions, "modelPath">;
}

/**
 * Result returned by {@link PiperTTS.synthesize}.
 */
export interface SynthesisResult {
	/** Raw output audio data. */
	audio: Buffer;
	/** Synthesis duration in milliseconds. */
	durationMs: number;
	/** Text that was synthesized. */
	text: string;
	/** Effective options used for this synthesis call. */
	options: PiperInferenceOptions;
}

export interface PiperVoicesManifestEntry {
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
	/** Canonical model key in the voices manifest. */
	key: string;
	/** Model name (for example, lessac). */
	name?: string;
	/** Model quality tier (low/medium/high). */
	quality?: string;
	/** Number of speakers supported by the model. */
	numSpeakers?: number;
	/** Language code (for example, en_US). */
	languageCode?: string;
	/** Language name in English. */
	languageNameEnglish?: string;
	/** Language name in native script. */
	languageNameNative?: string;
	/** Optional aliases accepted for this model. */
	aliases: string[];
	/** File paths listed in the manifest for this model. */
	filePaths: string[];
}
