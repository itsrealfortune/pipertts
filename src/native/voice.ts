/**
 * Native Piper voice (MVP).
 *
 * Mirrors `PiperVoice.synthesize` (`voice.py:344-453`) with a persistent
 * ONNX session: no per-call process spawn, one inference per sentence,
 * PCM chunks concatenated with inter-sentence silence.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	piperConfigFromDict,
	resolveSpeakerId,
	resolveSynthesisParams,
	type PiperConfig,
	type PiperConfigDict,
	type SynthesisConfig,
} from "./config.js";
import { ensureNativeDataBundle } from "./data.js";
import { HebrewPhonemizer } from "./hebrew.js";
import { createNativeSession, type NativeSession } from "./inference.js";
import { LithuanianPhonemizer } from "./lithuanian.js";
import { phonemesToIds } from "./phoneme-ids.js";
import {
	assertSupportedPhonemeType,
	espeakBridgePhonemizeWithRawBlocks,
	espeakCliPhonemize,
	textToPhonemes,
} from "./phonemizer.js";
import { getEspeakBridge } from "./espeak-bridge/loader.js";
import { TashkeelDiacritizer } from "./tashkeel.js";
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
	/** Base dir for auto-downloaded phonemizer data (tashkeel/hebrew/lithuanian). */
	nativeDataDir?: string;
	/** Explicit tashkeel model dir (skips download). */
	tashkeelModelDir?: string;
	/** Explicit Nakdimon model path or dir (skips download). */
	nakdimonModelPath?: string;
	/** Explicit Lithuanian data dir with lt_*.tsv (skips download). */
	lithuanianDataDir?: string;
	/** Enable Arabic diacritization for `ar` voices (default: true). */
	useTashkeel?: boolean;
	/** Logit threshold for taskeen, mirrors PiperVoice (default: 0.8). */
	taskeenThreshold?: number;
}

export interface NativeSynthesizeOptions extends SynthesisConfig {
	sentenceSilence?: number;
	outputFormat?: "wav" | "raw" | "mp3" | "ogg";
	/** When set, the final audio is also written to this path. */
	outputFile?: string;
}

async function resolveBundleDir(
	bundle: "tashkeel" | "hebrew" | "lithuanian",
	explicitDir: string | undefined,
	requiredFiles: string[],
	nativeDataDir: string,
): Promise<string> {
	if (explicitDir) {
		const missing = requiredFiles.filter(
			(f) => !fs.existsSync(path.join(explicitDir, f)),
		);
		if (missing.length === 0) {
			return explicitDir;
		}
		throw new Error(
			`PiperNative: explicit data dir "${explicitDir}" is missing: ${missing.join(", ")}`,
		);
	}
	const destDir = path.join(nativeDataDir, bundle);
	await ensureNativeDataBundle(bundle, destDir);
	return destDir;
}

export class PiperNativeTTS {
	private readonly config: PiperConfig;
	private readonly session: NativeSession;
	private readonly modelPath: string;
	private readonly espeakBinary: string;
	private readonly resourceOptions: {
		nativeDataDir: string;
		tashkeelModelDir?: string;
		nakdimonModelPath?: string;
		lithuanianDataDir?: string;
		useTashkeel: boolean;
		taskeenThreshold: number;
	};
	private tashkeel?: TashkeelDiacritizer | null;
	private hebrew?: HebrewPhonemizer | null;
	private lithuanian?: LithuanianPhonemizer | null;

	private constructor(
		config: PiperConfig,
		session: NativeSession,
		modelPath: string,
		espeakBinary: string,
		resourceOptions: {
			nativeDataDir: string;
			tashkeelModelDir?: string;
			nakdimonModelPath?: string;
			lithuanianDataDir?: string;
			useTashkeel: boolean;
			taskeenThreshold: number;
		},
	) {
		this.config = config;
		this.session = session;
		this.modelPath = modelPath;
		this.espeakBinary = espeakBinary;
		this.resourceOptions = resourceOptions;
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
			{
				nativeDataDir: options.nativeDataDir ?? path.resolve("piper-data"),
				tashkeelModelDir: options.tashkeelModelDir,
				nakdimonModelPath: options.nakdimonModelPath,
				lithuanianDataDir: options.lithuanianDataDir,
				useTashkeel: options.useTashkeel ?? true,
				taskeenThreshold: options.taskeenThreshold ?? 0.8,
			},
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
		if (this.config.phonemeType === "hebrew") {
			return this.getHebrew().then((h) => h.phonemize(text));
		}
		if (this.config.phonemeType === "lithuanian") {
			return this.getLithuanian().then((l) => l.phonemize(text));
		}
		const input =
			this.config.espeakVoice === "ar" && this.resourceOptions.useTashkeel
				? await this.applyTashkeel(text)
				: text;
		const bridge = getEspeakBridge();
		if (bridge) {
			return espeakBridgePhonemizeWithRawBlocks(
				input,
				this.config.espeakVoice,
				this.config.vowelClusters,
				bridge,
			);
		}
		return espeakCliPhonemize(
			input,
			this.config.espeakVoice,
			this.config.vowelClusters,
			{
				espeakBinary: this.espeakBinary,
			},
		);
	}

	private async applyTashkeel(text: string): Promise<string> {
		const parts = text.split(/(\[\[.*?\]\])/).filter((p) => p.length > 0);
		const diacritizer = await this.getTashkeel();
		const out: string[] = [];
		for (const part of parts) {
			if (part.startsWith("[[") && part.endsWith("]]")) {
				out.push(part);
			} else {
				out.push(
					await diacritizer.diacritize(
						part,
						this.resourceOptions.taskeenThreshold,
					),
				);
			}
		}
		return out.join("");
	}

	private async getTashkeel(): Promise<TashkeelDiacritizer> {
		if (!this.tashkeel) {
			const dir = await resolveBundleDir(
				"tashkeel",
				this.resourceOptions.tashkeelModelDir,
				[
					"model.onnx",
					"input_id_map.json",
					"target_id_map.json",
					"hint_id_map.json",
				],
				this.resourceOptions.nativeDataDir,
			);
			this.tashkeel = await TashkeelDiacritizer.load(dir);
		}
		return this.tashkeel;
	}

	private async getHebrew(): Promise<HebrewPhonemizer> {
		if (!this.hebrew) {
			const explicit = this.resourceOptions.nakdimonModelPath;
			let modelPath: string;
			if (explicit) {
				try {
					modelPath = fs.statSync(explicit).isDirectory()
						? path.join(explicit, "nakdimon.onnx")
						: explicit;
				} catch {
					modelPath = explicit;
				}
			} else {
				const dir = path.join(this.resourceOptions.nativeDataDir, "hebrew");
				const files = await ensureNativeDataBundle("hebrew", dir);
				modelPath = files["nakdimon.onnx"] as string;
			}
			this.hebrew = await HebrewPhonemizer.load(modelPath);
		}
		return this.hebrew;
	}

	private async getLithuanian(): Promise<LithuanianPhonemizer> {
		if (!this.lithuanian) {
			const dir = await resolveBundleDir(
				"lithuanian",
				this.resourceOptions.lithuanianDataDir,
				["lt_kirciai.tsv", "lt_kreipiniai.tsv", "lt_raides.tsv"],
				this.resourceOptions.nativeDataDir,
			);
			this.lithuanian = LithuanianPhonemizer.loadFromDir(
				dir,
				this.espeakBinary,
			);
		}
		return this.lithuanian;
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
		// Lithuanian voices append {"ˋ": [166]} to the default map; add it
		// when missing so ids resolve even with a bare default map.
		let idMap = this.config.phonemeIdMap;
		if (this.config.phonemeType === "lithuanian" && !idMap["ˋ"]) {
			idMap = { ...idMap, ˋ: [166] };
		}
		for (const phonemes of sentences) {
			if (phonemes.length === 0) {
				continue;
			}
			const { ids } = phonemesToIds(phonemes, idMap);
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
		let audio: Buffer;
		if (format === "raw") {
			audio = chunksToRaw(chunks, this.config.sampleRate, silence);
		} else if (format === "mp3" || format === "ogg") {
			const wav = chunksToWav(chunks, this.config.sampleRate, silence);
			const { transcodeAudio } = await import("./transcode.js");
			audio = await transcodeAudio(wav, format);
		} else {
			audio = chunksToWav(chunks, this.config.sampleRate, silence);
		}
		if (options.outputFile) {
			const { writeFile, mkdir } = await import("node:fs/promises");
			const outPath = path.resolve(options.outputFile);
			await mkdir(path.dirname(outPath), { recursive: true });
			await writeFile(outPath, audio);
		}
		return { audio, sampleRate: this.config.sampleRate, text };
	}
}
