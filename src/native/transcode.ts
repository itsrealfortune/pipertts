/**
 * WAV -> mp3/ogg transcoding (native).
 *
 * Strategy: `ffmpeg` CLI when available (best quality, both formats),
 * pure-JS `lamejs` fallback for mp3, explicit error otherwise.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";

export type TranscodeFormat = "mp3" | "ogg";

function findFfmpeg(): string | null {
	const explicit = process.env.FFMPEG_PATH;
	if (explicit && fs.existsSync(explicit)) {
		return explicit;
	}
	const pathEnv = process.env.PATH ?? "";
	const sep = process.platform === "win32" ? ";" : ":";
	for (const dir of pathEnv.split(sep).filter(Boolean)) {
		for (const name of process.platform === "win32"
			? ["ffmpeg.exe", "ffmpeg"]
			: ["ffmpeg"]) {
			const candidate = `${dir}/${name}`;
			if (fs.existsSync(candidate)) {
				return candidate;
			}
		}
	}
	return null;
}

export function isFfmpegAvailable(): boolean {
	return findFfmpeg() !== null;
}

function ffmpegTranscode(
	wav: Buffer,
	format: TranscodeFormat,
	ffmpeg: string,
	bitrate = "128k",
	timeoutMs = 60_000,
): Promise<Buffer> {
	const args =
		format === "mp3"
			? [
					"-hide_banner",
					"-loglevel",
					"error",
					"-i",
					"pipe:0",
					"-f",
					"mp3",
					"-b:a",
					bitrate,
					"pipe:1",
				]
			: [
					"-hide_banner",
					"-loglevel",
					"error",
					"-i",
					"pipe:0",
					"-ar",
					"44100",
					"-f",
					"ogg",
					"-c:a",
					"libvorbis",
					"-b:a",
					bitrate,
					"pipe:1",
				];
	return new Promise((resolve, reject) => {
		const child = execFile(
			ffmpeg,
			args,
			{ encoding: "buffer", maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs },
			(error, stdout, stderr) => {
				if (error) {
					reject(
						new Error(
							`PiperNative: ffmpeg transcode to ${format} failed: ${String(stderr || error.message).trim()}`,
						),
					);
					return;
				}
				resolve(stdout as Buffer);
			},
		);
		if (child.stdin) {
			child.stdin.on("error", () => {});
			child.stdin.write(wav);
			child.stdin.end();
		}
	});
}

function wavToInt16Mono(wav: Buffer): {
	samples: Int16Array;
	sampleRate: number;
} {
	if (wav.length < 44 || wav.subarray(0, 4).toString() !== "RIFF") {
		throw new Error("PiperNative: lamejs fallback needs a WAV buffer.");
	}
	const channels = wav.readUInt16LE(22);
	const sampleRate = wav.readUInt32LE(24);
	const bits = wav.readUInt16LE(34);
	if (bits !== 16) {
		throw new Error(
			`PiperNative: lamejs fallback needs 16-bit WAV (got ${bits}).`,
		);
	}
	const data = wav.subarray(44);
	const frames = data.length / (2 * channels);
	const samples = new Int16Array(frames);
	for (let i = 0; i < frames; i++) {
		if (channels === 1) {
			samples[i] = data.readInt16LE(i * 2);
		} else {
			let sum = 0;
			for (let ch = 0; ch < channels; ch++) {
				sum += data.readInt16LE((i * channels + ch) * 2);
			}
			samples[i] = Math.round(sum / channels);
		}
	}
	return { samples, sampleRate };
}

async function lamejsMp3(wav: Buffer, bitrateKbps = 128): Promise<Buffer> {
	let lamejs: {
		Mp3Encoder: new (
			channels: number,
			sampleRate: number,
			kbps: number,
		) => {
			encodeBuffer(samples: Int16Array): Int8Array;
			flush(): Int8Array;
		};
	};
	try {
		const mod = (await import("@breezystack/lamejs")) as unknown as {
			Mp3Encoder: new (
				channels: number,
				sampleRate: number,
				kbps: number,
			) => {
				encodeBuffer(samples: Int16Array): Int8Array;
				flush(): Int8Array;
			};
		};
		lamejs = mod;
	} catch (error) {
		throw new Error(
			`PiperNative: mp3 without ffmpeg needs the "@breezystack/lamejs" package (${(error as Error).message}).`,
		);
	}
	const { samples, sampleRate } = wavToInt16Mono(wav);
	const encoder = new lamejs.Mp3Encoder(1, sampleRate, bitrateKbps);
	const parts: Buffer[] = [];
	const CHUNK = 1152;
	for (let i = 0; i < samples.length; i += CHUNK) {
		const frame = encoder.encodeBuffer(samples.subarray(i, i + CHUNK));
		if (frame.length > 0) {
			parts.push(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
		}
	}
	const end = encoder.flush();
	if (end.length > 0) {
		parts.push(Buffer.from(end.buffer, end.byteOffset, end.byteLength));
	}
	return Buffer.concat(parts);
}

/**
 * Transcodes a WAV buffer to mp3 or ogg.
 * Uses ffmpeg when available, else lamejs (mp3 only).
 */
export async function transcodeAudio(
	wav: Buffer,
	format: TranscodeFormat,
	options?: { bitrateKbps?: number; timeoutMs?: number },
): Promise<Buffer> {
	const ffmpeg = findFfmpeg();
	if (ffmpeg) {
		return ffmpegTranscode(
			wav,
			format,
			ffmpeg,
			`${options?.bitrateKbps ?? 128}k`,
			options?.timeoutMs ?? 60_000,
		);
	}
	if (format === "mp3") {
		return lamejsMp3(wav, options?.bitrateKbps ?? 128);
	}
	throw new Error(
		"PiperNative: ogg without ffmpeg is not supported. Install ffmpeg or set FFMPEG_PATH.",
	);
}
