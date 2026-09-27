/**
 * Native Piper config (MVP).
 *
 * TypeScript port of `PiperConfig` / `SynthesisConfig` from
 * piper1-gpl (`src/piper/config.py`), licensed GPL-3.0-or-later.
 * See https://github.com/OHF-Voice/piper1-gpl
 */

export const DEFAULT_NOISE_SCALE = 0.667;
export const DEFAULT_LENGTH_SCALE = 1.0;
export const DEFAULT_NOISE_W_SCALE = 0.8;
export const DEFAULT_HOP_LENGTH = 256;

export type PhonemeType =
	| "espeak"
	| "text"
	| "pinyin"
	| "hebrew"
	| "japanese"
	| "thai"
	| "lithuanian";

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

export interface PiperConfig {
	numSymbols: number;
	numSpeakers: number;
	sampleRate: number;
	espeakVoice: string;
	phonemeIdMap: Record<string, number[]>;
	phonemeType: PhonemeType;
	speakerIdMap: Record<string, number>;
	piperVersion?: string;
	lengthScale: number;
	noiseScale: number;
	noiseWScale: number;
	hopLength: number;
	vowelClusters: Set<string> | null;
	defaultSpeakerId: number;
}

export interface SynthesisConfig {
	speakerId?: number;
	lengthScale?: number;
	noiseScale?: number;
	noiseWScale?: number;
	normalizeAudio?: boolean;
	volume?: number;
}

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

export function resolveSpeakerId(
	config: PiperConfig,
	speakerId?: number,
): number | null {
	if (config.numSpeakers <= 1) {
		return null;
	}
	return speakerId ?? config.defaultSpeakerId;
}
