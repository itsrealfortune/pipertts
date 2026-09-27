import { describe, expect, it } from "bun:test";
import {
	piperConfigFromDict,
	resolveSpeakerId,
	resolveSynthesisParams,
} from "./config.js";
import {
	BOS,
	DEFAULT_PHONEME_ID_MAP,
	EOS,
	PAD,
	phonemesToIds,
} from "./phoneme-ids.js";
import {
	applyVolumeAndClip,
	chunksToRaw,
	chunksToWav,
	floatToInt16Bytes,
	normalizeAudio,
	silenceBytes,
	writeWavHeader,
} from "./wav.js";

describe("phonemesToIds (espeak scheme)", () => {
	it("wraps BOS+PAD ... EOS with PAD after each phoneme", () => {
		const map = { "^": [1], _: [0], $: [2], a: [14] };
		expect(phonemesToIds(["a"], map).ids).toEqual([1, 0, 14, 0, 2]);
	});

	it("skips unknown phonemes and reports them", () => {
		const { ids, skipped } = phonemesToIds(["a", "ZZZ"], {
			"^": [1],
			_: [0],
			$: [2],
			a: [14],
		});
		expect(ids).toEqual([1, 0, 14, 0, 2]);
		expect(skipped).toEqual(["ZZZ"]);
	});

	it("falls back to the default map when empty", () => {
		const { ids, skipped } = phonemesToIds(["h", "ə"], {});
		expect(skipped).toEqual([]);
		expect(ids[0]).toBe(DEFAULT_PHONEME_ID_MAP[BOS]?.[0]);
		expect(ids[ids.length - 1]).toBe(DEFAULT_PHONEME_ID_MAP[EOS]?.[0]);
	});

	it("default map has 166 entries (0-165)", () => {
		expect(Object.keys(DEFAULT_PHONEME_ID_MAP).length).toBe(166);
		expect(DEFAULT_PHONEME_ID_MAP[PAD]).toEqual([0]);
	});
});

describe("piperConfigFromDict", () => {
	const base = {
		num_symbols: 10,
		num_speakers: 1,
		audio: { sample_rate: 22050 },
		espeak: { voice: "en-us" },
		phoneme_id_map: { "^": [1] },
	};

	it("applies inference defaults", () => {
		const cfg = piperConfigFromDict(base);
		expect(cfg.noiseScale).toBeCloseTo(0.667);
		expect(cfg.lengthScale).toBe(1.0);
		expect(cfg.noiseWScale).toBeCloseTo(0.8);
		expect(cfg.hopLength).toBe(256);
		expect(cfg.phonemeType).toBe("espeak");
		expect(cfg.defaultSpeakerId).toBe(0);
	});

	it("synthesis params prefer call values, then config", () => {
		const cfg = piperConfigFromDict({
			...base,
			inference: { noise_scale: 0.5, length_scale: 1.2, noise_w: 0.9 },
		});
		expect(resolveSynthesisParams(cfg, {})).toEqual({
			lengthScale: 1.2,
			noiseScale: 0.5,
			noiseWScale: 0.9,
		});
		expect(resolveSynthesisParams(cfg, { lengthScale: 0.8 }).lengthScale).toBe(
			0.8,
		);
	});

	it("resolves speaker ids", () => {
		const solo = piperConfigFromDict(base);
		expect(resolveSpeakerId(solo, 3)).toBeNull();
		const multi = piperConfigFromDict({ ...base, num_speakers: 4 });
		expect(resolveSpeakerId(multi, undefined)).toBe(0);
		expect(resolveSpeakerId(multi, 2)).toBe(2);
	});
});

describe("wav helpers", () => {
	it("writes a valid 44-byte header", () => {
		const header = writeWavHeader(22050, 100);
		expect(header.length).toBe(44);
		expect(header.subarray(0, 4).toString()).toBe("RIFF");
		expect(header.subarray(8, 12).toString()).toBe("WAVE");
		expect(header.readUInt32LE(24)).toBe(22050);
		expect(header.readUInt32LE(40)).toBe(200);
	});

	it("normalizes by max abs and zeroes silence", () => {
		expect([...normalizeAudio(new Float32Array([0, 0]))]).toEqual([0, 0]);
		expect([...normalizeAudio(new Float32Array([0.5, -0.25]))]).toEqual([
			1, -0.5,
		]);
	});

	it("clips volume-scaled samples", () => {
		expect([...applyVolumeAndClip(new Float32Array([0.5, 2]), 2)]).toEqual([
			1, 1,
		]);
	});

	it("converts float to int16 LE", () => {
		const bytes = floatToInt16Bytes(new Float32Array([0, 1, -1]));
		expect(bytes.length).toBe(6);
		expect(bytes.readInt16LE(0)).toBe(0);
		expect(bytes.readInt16LE(2)).toBe(32767);
		expect(bytes.readInt16LE(4)).toBe(-32767);
	});

	it("computes even silence bytes", () => {
		expect(silenceBytes(22050, 0).length).toBe(0);
		expect(silenceBytes(22050, 0.2).length).toBe(Math.floor(22050 * 0.2) * 2);
	});

	it("assembles wav with inter-chunk silence only", () => {
		const a = Buffer.from([1, 2]);
		const b = Buffer.from([3, 4]);
		const wav = chunksToWav([a, b], 22050, 0);
		expect(wav.subarray(0, 4).toString()).toBe("RIFF");
		expect(wav.length).toBe(44 + 4);
		const raw = chunksToRaw([a, b], 22050, 0);
		expect(raw).toEqual(Buffer.concat([a, b]));
	});

	it("fused processAudioToInt16 matches the staged pipeline (±1 LSB)", async () => {
		const { processAudioToInt16 } = await import("./wav.js");
		// Deterministic pseudo-random incl. edge values.
		let seed = 123456789;
		const rand = (): number => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
		const samples = new Float32Array(20000);
		for (let i = 0; i < samples.length; i++) {
			samples[i] = rand() * 4 - 2;
		}
		samples[0] = 0;
		samples[1] = 1;
		samples[2] = -1;
		samples[3] = 0.5;
		for (const volume of [0.5, 1.0, 1.7]) {
			for (const normalize of [true, false]) {
				const staged = floatToInt16Bytes(
					applyVolumeAndClip(
						normalize ? normalizeAudio(samples) : samples,
						volume,
					),
				);
				const fusedInt16 = processAudioToInt16(samples, { normalize, volume });
				const fused = Buffer.from(
					fusedInt16.buffer,
					fusedInt16.byteOffset,
					fusedInt16.byteLength,
				);
				// The fused path skips one intermediate float32 rounding, so
				// rare samples (only at high gain) differ by 1 LSB (-90dB).
				let maxDiff = 0;
				for (let i = 0; i < staged.length; i += 2) {
					maxDiff = Math.max(
						maxDiff,
						Math.abs(staged.readInt16LE(i) - fused.readInt16LE(i)),
					);
				}
				expect(maxDiff).toBeLessThanOrEqual(1);
			}
		}
	});
});
