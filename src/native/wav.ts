/**
 * PCM / WAV helpers (MVP, pure TS).
 *
 * Mirrors the audio post-processing in piper1-gpl `src/piper/voice.py`:
 * normalize (÷ max abs) -> volume -> clip [-1, 1] -> int16 (×32767),
 * WAV 16-bit mono, sentence silence inserted between chunks.
 */

const MAX_WAV_VALUE = 32767;

/** Scales samples so the peak absolute value is 1; returns zeros for silence. Port of `voice.py` normalization. */
export function normalizeAudio(samples: Float32Array): Float32Array {
	let max = 0;
	for (let i = 0; i < samples.length; i++) {
		const abs = Math.abs(samples[i] ?? 0);
		if (abs > max) {
			max = abs;
		}
	}
	if (max < 1e-8) {
		return new Float32Array(samples.length);
	}
	const out = new Float32Array(samples.length);
	for (let i = 0; i < samples.length; i++) {
		out[i] = (samples[i] ?? 0) / max;
	}
	return out;
}

/** Applies volume gain and clips samples to [-1, 1]. Port of `voice.py` audio post-processing. */
export function applyVolumeAndClip(
	samples: Float32Array,
	volume: number,
): Float32Array {
	const out = new Float32Array(samples.length);
	for (let i = 0; i < samples.length; i++) {
		const v = (samples[i] ?? 0) * volume;
		out[i] = v > 1 ? 1 : v < -1 ? -1 : v;
	}
	return out;
}

/** Converts float samples to little-endian int16 PCM bytes (x32767). Port of `voice.py` int16 conversion. */
export function floatToInt16Bytes(samples: Float32Array): Buffer {
	const int16 = floatToInt16(samples);
	return Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength);
}

function floatToInt16(samples: Float32Array): Int16Array {
	const out = new Int16Array(samples.length);
	for (let i = 0; i < samples.length; i++) {
		const v = samples[i] ?? 0;
		const clamped = v > 1 ? 1 : v < -1 ? -1 : v;
		const scaled = Math.round(clamped * MAX_WAV_VALUE);
		out[i] =
			scaled > MAX_WAV_VALUE
				? MAX_WAV_VALUE
				: scaled < -MAX_WAV_VALUE
					? -MAX_WAV_VALUE
					: scaled;
	}
	return out;
}

/**
 * Fused post-processing: normalize (÷ peak) -> volume -> clip -> int16.
 * Matches normalizeAudio + applyVolumeAndClip + floatToInt16Bytes within
 * 1 LSB (the fused path skips one intermediate float32 rounding; inaudible),
 * in two passes with one allocation instead of four passes with three.
 */
export function processAudioToInt16(
	audio: Float32Array,
	options: { normalize: boolean; volume?: number },
): Int16Array {
	let norm: Float32Array;
	if (options.normalize) {
		let peak = 0;
		for (let i = 0; i < audio.length; i++) {
			const abs = Math.abs(audio[i] ?? 0);
			if (abs > peak) {
				peak = abs;
			}
		}
		if (peak < 1e-8) {
			return new Int16Array(audio.length);
		}
		norm = new Float32Array(audio.length);
		for (let i = 0; i < audio.length; i++) {
			norm[i] = (audio[i] ?? 0) / peak;
		}
	} else {
		norm = audio;
	}
	const volume = options.volume ?? 1;
	const out = new Int16Array(norm.length);
	for (let i = 0; i < norm.length; i++) {
		const v = (norm[i] ?? 0) * volume;
		const clamped = v > 1 ? 1 : v < -1 ? -1 : v;
		const scaled = Math.round(clamped * MAX_WAV_VALUE);
		out[i] =
			scaled > MAX_WAV_VALUE
				? MAX_WAV_VALUE
				: scaled < -MAX_WAV_VALUE
					? -MAX_WAV_VALUE
					: scaled;
	}
	return out;
}

/** Silence bytes for `seconds` at `sampleRate` (16-bit mono). Mirrors `__main__.py`. */
export function silenceBytes(sampleRate: number, seconds: number): Buffer {
	if (!(seconds > 0)) {
		return Buffer.alloc(0);
	}
	return Buffer.alloc(Math.floor(sampleRate * seconds) * 2);
}

/** Builds a 44-byte WAV header for PCM audio. */
export function writeWavHeader(
	sampleRate: number,
	numFrames: number,
	numChannels = 1,
	bitsPerSample = 16,
): Buffer {
	const header = Buffer.alloc(44);
	const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
	const blockAlign = numChannels * (bitsPerSample / 8);
	const dataSize = numFrames * numChannels * (bitsPerSample / 8);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + dataSize, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(numChannels, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(byteRate, 28);
	header.writeUInt16LE(blockAlign, 32);
	header.writeUInt16LE(bitsPerSample, 34);
	header.write("data", 36);
	header.writeUInt32LE(dataSize, 40);
	return header;
}

/** Concatenates per-sentence PCM chunks with inter-sentence silence into one WAV. */
export function chunksToWav(
	chunks: Buffer[],
	sampleRate: number,
	sentenceSilenceSeconds: number,
): Buffer {
	const silence = silenceBytes(sampleRate, sentenceSilenceSeconds);
	const parts: Buffer[] = [];
	let totalFrames = 0;
	chunks.forEach((chunk, index) => {
		if (index > 0 && silence.length > 0) {
			parts.push(silence);
			totalFrames += silence.length / 2;
		}
		parts.push(chunk);
		totalFrames += chunk.length / 2;
	});
	const header = writeWavHeader(sampleRate, totalFrames);
	return Buffer.concat([header, ...parts]);
}

/** Concatenates per-sentence PCM chunks with silence into raw PCM. */
export function chunksToRaw(
	chunks: Buffer[],
	sampleRate: number,
	sentenceSilenceSeconds: number,
): Buffer {
	const silence = silenceBytes(sampleRate, sentenceSilenceSeconds);
	const parts: Buffer[] = [];
	chunks.forEach((chunk, index) => {
		if (index > 0 && silence.length > 0) {
			parts.push(silence);
		}
		parts.push(chunk);
	});
	return Buffer.concat(parts);
}
