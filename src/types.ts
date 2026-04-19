/**
 * Supported output audio formats for PiperTTS.
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
	/** Output audio format. */
	outputFormat?: PiperOutputFormat;
	/** Speaker ID for multi-speaker models. */
	speakerId?: number;
	/** Controls audio variability / expressiveness. */
	noiseScale?: NoiseScale;
	/** Controls duration/timing variability. */
	noiseWScale?: NoiseWScale;
	/** Speech rate multiplier (higher = slower). */
	lengthScale?: LengthScale;
	/** Silence appended after each sentence, in seconds. */
	sentenceSilence?: SentenceSilence;
	/** Enable Piper JSON phoneme input mode. */
	jsonInput?: boolean;
	/** Number of ONNX inference threads. */
	numThreads?: number;
	/** Use CUDA GPU acceleration if available. */
	useCuda?: boolean;
	/** Piper log level. */
	logLevel?: "debug" | "info" | "warn" | "error";
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
