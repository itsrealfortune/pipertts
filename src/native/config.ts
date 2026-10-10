/**
 * Native Piper config (MVP).
 *
 * TypeScript port of `PiperConfig` / `SynthesisConfig` from
 * piper1-gpl (`src/piper/config.py`), licensed GPL-3.0-or-later.
 * See https://github.com/OHF-Voice/piper1-gpl
 */

/** Default inference noise scale from `config.py`. */
export const DEFAULT_NOISE_SCALE = 0.667;
/** Default length (speech-rate) scale from `config.py`. */
export const DEFAULT_LENGTH_SCALE = 1.0;
/** Default phoneme-width noise scale from `config.py`. */
export const DEFAULT_NOISE_W_SCALE = 0.8;
/** Default STFT hop length from `config.py`. */
export const DEFAULT_HOP_LENGTH = 256;

/** Phoneme back-end type. Port of `PhonemeType` in `config.py`. */
export type PhonemeType =
	| "espeak"
	| "text"
	| "pinyin"
	| "hebrew"
	| "japanese"
	| "thai"
	| "lithuanian";

/** Raw voice config JSON shape. Port of `PiperConfig` in `config.py`. */
export interface PiperConfigDict {
	num_symbols: number;
	num_speakers: number;
	audio: { sample_rate: number };
	espeak: { voice: string };
	phoneme_id_map: Record<string, number[]>;
	phoneme_type?: PhonemeType;
	speaker_id_map?: Record<string, number>;
	inference?: {
		noise_scale?: number;
		length_scale?: number;
		noise_w?: number;
	};
	piper_version?: string;
	hop_length?: number;
	vowel_clusters?: string[][];
	default_speaker_id?: number;
}

/** Normalized voice config with defaults applied. Port of `PiperConfig` in `config.py`. */
export interface PiperConfig {
	/** Number of phoneme symbols. */
	numSymbols: number;
	/** Number of speakers (1 for single-voice models). */
	numSpeakers: number;
	/** Output sample rate in Hz. */
	sampleRate: number;
	/** espeak-ng voice identifier (for example, `"fr"`). */
	espeakVoice: string;
	/** Phoneme string to ONNX id list mapping. */
	phonemeIdMap: Record<string, number[]>;
	/** Phonemizer back-end used by this voice. */
	phonemeType: PhonemeType;
	/** Named speaker to id mapping (multi-speaker models). */
	speakerIdMap: Record<string, number>;
	/** Piper version that trained the model, when recorded. */
	piperVersion?: string;
	/** Default speech-rate multiplier (>1 slower, <1 faster). */
	lengthScale: number;
	/** Default voice variability. */
	noiseScale: number;
	/** Default timing variability. */
	noiseWScale: number;
	/** STFT hop length used for chunk sizing. */
	hopLength: number;
	/** Vowel clusters treated as single phonemes, if any. */
	vowelClusters: Set<string> | null;
	/** Fallback speaker id when none is requested. */
	defaultSpeakerId: number;
}

/** Per-utterance synthesis overrides. Port of `SynthesisConfig` in `config.py`. */
export interface SynthesisConfig {
	/** Speaker index for multi-speaker/style models. */
	speakerId?: number;
	/** Speech-rate multiplier (>1 slower, <1 faster). */
	lengthScale?: number;
	/** Voice variability (output is stochastic). */
	noiseScale?: number;
	/** Timing variability. */
	noiseWScale?: number;
	/** Scale PCM to peak before output. Default: `true`. */
	normalizeAudio?: boolean;
	/** Gain multiplier applied after normalization. Default: `1.0`. */
	volume?: number;
}

/** Converts a raw config dict to a normalized config, filling defaults from `config.py`. */
export function piperConfigFromDict(dict: PiperConfigDict): PiperConfig {
	const inference = dict.inference ?? {};
	const clusters = dict.vowel_clusters;
	return {
		numSymbols: dict.num_symbols,
		numSpeakers: dict.num_speakers,
		sampleRate: dict.audio.sample_rate,
		espeakVoice: dict.espeak.voice,
		phonemeIdMap: dict.phoneme_id_map,
		phonemeType: dict.phoneme_type ?? "espeak",
		speakerIdMap: dict.speaker_id_map ?? {},
		piperVersion: dict.piper_version,
		lengthScale: inference.length_scale ?? DEFAULT_LENGTH_SCALE,
		noiseScale: inference.noise_scale ?? DEFAULT_NOISE_SCALE,
		noiseWScale: inference.noise_w ?? DEFAULT_NOISE_W_SCALE,
		hopLength: dict.hop_length ?? DEFAULT_HOP_LENGTH,
		vowelClusters: clusters?.length
			? new Set(clusters.map((vc) => vc.join("")))
			: null,
		defaultSpeakerId: dict.default_speaker_id ?? 0,
	};
}

/** Resolves effective length/noise scales, preferring per-synthesis overrides over voice defaults. */
export function resolveSynthesisParams(
	config: PiperConfig,
	syn: SynthesisConfig,
): { lengthScale: number; noiseScale: number; noiseWScale: number } {
	return {
		lengthScale: syn.lengthScale ?? config.lengthScale,
		noiseScale: syn.noiseScale ?? config.noiseScale,
		noiseWScale: syn.noiseWScale ?? config.noiseWScale,
	};
}

/** Resolves the speaker id, or null for single-speaker voices. Port of speaker handling in `voice.py`. */
export function resolveSpeakerId(
	config: PiperConfig,
	speakerId?: number,
): number | null {
	if (config.numSpeakers <= 1) {
		return null;
	}
	return speakerId ?? config.defaultSpeakerId;
}
