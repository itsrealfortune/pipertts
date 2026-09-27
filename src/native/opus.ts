/**
 * Pure-JS Opus encoder (OggOpus) fallback.
 *
 * Used when ffmpeg is unavailable: resamples to 48kHz, encodes 20ms frames
 * with `opusscript` (libopus), and muxes a minimal OggOpus stream
 * (OpusHead + OpusTags + audio packets with correct granule positions).
 */

const OPUS_SAMPLE_RATE = 48000;
const OPUS_FRAME_SIZE = 960; // 20ms @ 48kHz

/** Linear-interpolation resampler for mono int16. */
export function resampleMonoInt16(
	samples: Int16Array,
	fromRate: number,
	toRate = OPUS_SAMPLE_RATE,
): Int16Array {
	if (fromRate === toRate) {
		return samples;
	}
	const ratio = fromRate / toRate;
	const outLen = Math.floor(samples.length / ratio);
	const out = new Int16Array(outLen);
	for (let i = 0; i < outLen; i++) {
		const pos = i * ratio;
		const lo = Math.floor(pos);
		const frac = pos - lo;
		const a = samples[lo] ?? 0;
		const b = samples[Math.min(lo + 1, samples.length - 1)] ?? 0;
		out[i] = Math.round(a + (b - a) * frac);
	}
	return out;
}

// Ogg CRC-32: non-reflected, poly 0x04C11DB7, init 0, no final xor.
const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = (n << 24) >>> 0;
		for (let k = 0; k < 8; k++) {
			c =
				(c & 0x80000000) !== 0 ? ((c << 1) ^ 0x04c11db7) >>> 0 : (c << 1) >>> 0;
		}
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(data: Uint8Array): number {
	let crc = 0;
	for (let i = 0; i < data.length; i++) {
		crc =
			((CRC_TABLE[((crc >>> 24) ^ (data[i] as number)) & 0xff] as number) ^
				((crc << 8) >>> 0)) >>>
			0;
	}
	return crc >>> 0;
}

function buildOggPage(
	packets: Uint8Array[],
	granule: bigint,
	serial: number,
	seqNo: number,
	headerType: number,
): Buffer {
	const lacing: number[] = [];
	for (const p of packets) {
		let remaining = p.length;
		while (remaining >= 255) {
			lacing.push(255);
			remaining -= 255;
		}
		lacing.push(remaining);
	}
	// A packet ending on exactly 255 needs a trailing 0 lacing value.
	// (packets here are small; handle the general case anyway)
	const header = Buffer.alloc(27 + lacing.length);
	header.write("OggS", 0);
	header.writeUInt8(0, 4);
	header.writeUInt8(headerType, 5);
	header.writeBigUInt64LE(granule, 6);
	header.writeUInt32LE(serial >>> 0, 14);
	header.writeUInt32LE(seqNo >>> 0, 18);
	header.writeUInt32LE(0, 22); // checksum placeholder
	header.writeUInt8(lacing.length, 26);
	lacing.forEach((v, i) => header.writeUInt8(v, 27 + i));
	const page = Buffer.concat([header, ...packets.map((p) => Buffer.from(p))]);
	page.writeUInt32LE(crc32(page), 22);
	return page;
}

function opusHead(channels = 1): Buffer {
	const head = Buffer.alloc(19);
	head.write("OpusHead", 0);
	head.writeUInt8(1, 8);
	head.writeUInt8(channels, 9);
	head.writeUInt16LE(0, 10); // pre-skip
	head.writeUInt32LE(OPUS_SAMPLE_RATE, 12);
	head.writeUInt16LE(0, 16);
	head.writeUInt8(0, 18);
	return head;
}

function opusTags(vendor = "pipertts"): Buffer {
	const vendorBytes = Buffer.from(vendor, "utf8");
	const tags = Buffer.alloc(8 + 4 + vendorBytes.length + 4);
	tags.write("OpusTags", 0);
	tags.writeUInt32LE(vendorBytes.length, 8);
	vendorBytes.copy(tags, 12);
	tags.writeUInt32LE(0, 12 + vendorBytes.length);
	return tags;
}

interface OpusEncoder {
	encode(buffer: Buffer, frameSize: number): Buffer;
	delete(): void;
}

/**
 * Encodes mono int16 PCM to an OggOpus buffer (pure JS fallback).
 */
export async function encodeOpusOgg(
	pcm16: Int16Array,
	sampleRate: number,
	bitrateKbps = 128,
): Promise<Buffer> {
	let OpusScript: new (
		rate: number,
		channels: number,
		application: number,
	) => OpusEncoder & { Application?: unknown };
	try {
		const { createRequire } = await import("node:module");
		const mod = createRequire(import.meta.url)("opusscript") as {
			Application: { AUDIO: number };
			new (rate: number, channels: number, app: number): OpusEncoder;
		};
		OpusScript = mod;
		var appAudio = mod.Application.AUDIO;
	} catch (error) {
		throw new Error(
			`PiperNative: opus without ffmpeg needs the "opusscript" package (${(error as Error).message}).`,
		);
	}
	const resampled = resampleMonoInt16(pcm16, sampleRate, OPUS_SAMPLE_RATE);
	const encoder = new OpusScript(OPUS_SAMPLE_RATE, 1, appAudio);
	void bitrateKbps; // opusscript uses libopus defaults (VBR); bitrate set is unsupported
	try {
		const serial = (Math.random() * 0xffffffff) >>> 0;
		const pages: Buffer[] = [];
		let seqNo = 0;
		pages.push(buildOggPage([opusHead(1)], 0n, serial, seqNo++, 0x02));
		pages.push(buildOggPage([opusTags()], 0n, serial, seqNo++, 0x00));
		let granule = 0n;
		const totalFrames = Math.ceil(resampled.length / OPUS_FRAME_SIZE);
		for (let f = 0; f < totalFrames; f++) {
			const start = f * OPUS_FRAME_SIZE;
			const frame = new Int16Array(OPUS_FRAME_SIZE);
			frame.set(resampled.subarray(start, start + OPUS_FRAME_SIZE));
			const pcmBytes = Buffer.from(
				frame.buffer,
				frame.byteOffset,
				frame.byteLength,
			);
			const packet = encoder.encode(pcmBytes, OPUS_FRAME_SIZE);
			granule += BigInt(Math.min(OPUS_FRAME_SIZE, resampled.length - start));
			const isLast = f === totalFrames - 1;
			pages.push(
				buildOggPage(
					[new Uint8Array(packet)],
					granule,
					serial,
					seqNo++,
					isLast ? 0x04 : 0x00,
				),
			);
		}
		return Buffer.concat(pages);
	} finally {
		encoder.delete();
	}
}
