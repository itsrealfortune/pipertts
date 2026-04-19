export type PiperOutputFormat = "raw" | "wav" | "mp3" | "ogg";

export type NoiseScale = number;
export type NoiseWScale = number;
export type LengthScale = number;
export type SentenceSilence = number;

export interface PiperInferenceOptions {
	modelPath?: string;
	configPath?: string;
	outputFile?: string;
	outputFormat?: PiperOutputFormat;
	speakerId?: number;
	noiseScale?: NoiseScale;
	noiseWScale?: NoiseWScale;
	lengthScale?: LengthScale;
	sentenceSilence?: SentenceSilence;
	jsonInput?: boolean;
	numThreads?: number;
	useCuda?: boolean;
	logLevel?: "debug" | "info" | "warn" | "error";
}

export interface PiperTTSOptions {
	modelPath?: string;
	model?: string;
	modelsDir?: string;
	piperBinaryPath?: string;
	warmUpText?: string;
	defaultOptions?: Omit<PiperInferenceOptions, "modelPath">;
}

export interface SynthesisResult {
	audio: Buffer;
	durationMs: number;
	text: string;
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
