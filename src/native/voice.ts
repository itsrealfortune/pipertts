/**
 * Native Piper voice (MVP).
 *
 * Mirrors `PiperVoice.synthesize` (`voice.py:344-453`) with a persistent
 * ONNX session: no per-call process spawn, one inference per sentence,
 * PCM chunks concatenated with inter-sentence silence.
 */

import * as fs from "node:fs";
import {
	piperConfigFromDict,
	resolveSpeakerId,
	resolveSynthesisParams,
	type PiperConfig,
	type PiperConfigDict,
	type SynthesisConfig,
} from "./config.js";
import { createNativeSession, type NativeSession } from "./inference.js";
import { phonemesToIds } from "./phoneme-ids.js";
import {
	assertSupportedPhonemeType,
	espeakBridgePhonemizeWithRawBlocks,
	espeakCliPhonemize,
	textToPhonemes,
} from "./phonemizer.js";
import { getEspeakBridge } from "./espeak-bridge/loader.js";
import {
	applyVolumeAndClip,
	chunksToRaw,
	chunksToWav,
	floatToInt16Bytes,
	normalizeAudio,
} from "./wav.js";

export interface NativeAudioChunk {
	sampleRate: number;
	phonemes: string[];
	phonemeIds: number[];
	pcm16: Buffer;
}

export interface NativeTtsOptions {
	modelPath: string;
	configPath?: string;
	numThreads?: number;
	espeakBinary?: string;
	session?: NativeSession;
}

export interface NativeSynthesizeOptions extends SynthesisConfig {
	sentenceSilence?: number;
	outputFormat?: "wav" | "raw";
}

export class PiperNativeTTS {
	private readonly config: PiperConfig;
	private readonly session: NativeSession;
	private readonly modelPath: string;
	private readonly espeakBinary: string;

	private constructor(
		config: PiperConfig,
		session: NativeSession,
		modelPath: string,
		espeakBinary: string,
	) {
		this.config = config;
		this.session = session;
		this.modelPath = modelPath;
		this.espeakBinary = espeakBinary;
	}

	static async load(options: NativeTtsOptions): Promise<PiperNativeTTS> {
		const modelPath = options.modelPath;
		if (!fs.existsSync(modelPath)) {
			throw new Error(`PiperNative: model file not found at "${modelPath}".`);
		}
		const configPath = options.configPath ?? `${modelPath}.json`;
		if (!fs.existsSync(configPath)) {
			throw new Error(`PiperNative: config file not found at "${configPath}".`);
		}
		const dict = JSON.parse(
			fs.readFileSync(configPath, "utf8"),
		) as PiperConfigDict;
		const config = piperConfigFromDict(dict);
		assertSupportedPhonemeType(config.phonemeType);

		const session =
			options.session ??
			(await createNativeSession(modelPath, {
				numThreads: options.numThreads,
			}));
		return new PiperNativeTTS(
			config,
			session,
			modelPath,
			options.espeakBinary ?? "espeak-ng",
		);
	}

	getConfig(): PiperConfig {
		return this.config;
	}

	getModelPath(): string {
		return this.modelPath;
	}

	async phonemize(text: string): Promise<string[][]> {
		if (this.config.phonemeType === "text") {
			return [textToPhonemes(text)];
		}
		const bridge = getEspeakBridge();
		if (bridge) {
			return espeakBridgePhonemizeWithRawBlocks(
				text,
				this.config.espeakVoice,
				this.config.vowelClusters,
				bridge,
			);
		}
		return espeakCliPhonemize(
			text,
			this.config.espeakVoice,
			this.config.vowelClusters,
			{
				espeakBinary: this.espeakBinary,
			},
		);
	}

	async *synthesizeChunks(
		text: string,
		options: NativeSynthesizeOptions = {},
	): AsyncGenerator<NativeAudioChunk> {
		if (!text || text.trim().length === 0) {
			throw new Error("PiperNative.synthesize: text must not be empty.");
		}
		const { lengthScale, noiseScale, noiseWScale } = resolveSynthesisParams(
			this.config,
			options,
		);
		const normalizeAudioFlag = options.normalizeAudio ?? true;
		const volume = options.volume ?? 1.0;

		const sentences = await this.phonemize(text);
		for (const phonemes of sentences) {
			if (phonemes.length === 0) {
				continue;
			}
			const { ids } = phonemesToIds(phonemes, this.config.phonemeIdMap);
			const speakerId = resolveSpeakerId(this.config, options.speakerId);
			let audio = await this.session.run({
				phonemeIds: ids,
				scales: [noiseScale, lengthScale, noiseWScale],
				speakerId,
			});
			if (normalizeAudioFlag) {
				audio = normalizeAudio(audio);
			}
			if (volume !== 1.0) {
				audio = applyVolumeAndClip(audio, volume);
			} else {
				audio = applyVolumeAndClip(audio, 1.0);
			}
			yield {
				sampleRate: this.config.sampleRate,
				phonemes,
				phonemeIds: ids,
				pcm16: floatToInt16Bytes(audio),
			};
		}
	}

	async synthesize(
		text: string,
		options: NativeSynthesizeOptions = {},
	): Promise<{ audio: Buffer; sampleRate: number; text: string }> {
		const chunks: Buffer[] = [];
		for await (const chunk of this.synthesizeChunks(text, options)) {
			chunks.push(chunk.pcm16);
		}
		if (chunks.length === 0) {
			throw new Error("PiperNative: no audio produced (empty phonemization?).");
		}
		const silence = options.sentenceSilence ?? 0;
		const format = options.outputFormat ?? "wav";
		const audio =
			format === "raw"
				? chunksToRaw(chunks, this.config.sampleRate, silence)
				: chunksToWav(chunks, this.config.sampleRate, silence);
		return { audio, sampleRate: this.config.sampleRate, text };
	}
}
