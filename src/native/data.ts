/**
 * On-demand data files for native phonemizers (MVP).
 *
 * Large resources (ONNX diacritizers, stress dictionaries) are NOT bundled
 * with the npm package. They are downloaded once from the piper1-gpl
 * repository (matching licenses kept alongside, see SOURCES below) into a
 * local cache directory and reused afterwards.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const PIPER_GPL_RAW =
	"https://raw.githubusercontent.com/OHF-Voice/piper1-gpl/main/src/piper";

export interface NativeDataBundle {
	/** Files relative to `src/piper/` in piper1-gpl. */
	files: string[];
	/** License note for the bundle. */
	license: string;
}

export const NATIVE_DATA_BUNDLES: Record<string, NativeDataBundle> = {
	tashkeel: {
		files: [
			"tashkeel/model.onnx",
			"tashkeel/input_id_map.json",
			"tashkeel/target_id_map.json",
			"tashkeel/hint_id_map.json",
		],
		license: "GPL-3.0-or-later (piper1-gpl, ported from libtashkeel)",
	},
	hebrew: {
		files: ["hebrew/nakdimon.onnx"],
		license:
			"GPL-3.0-or-later (piper1-gpl) + MIT (nakdimon model, elazarg/nakdimon)",
	},
	lithuanian: {
		files: [
			"lithuanian/lt_kirciai.tsv",
			"lithuanian/lt_kreipiniai.tsv",
			"lithuanian/lt_raides.tsv",
		],
		license: "CC-BY-4.0 (liepa-tts + svogunas/g2p-lt-lexicon, via piper1-gpl)",
	},
};

async function fetchWithTimeout(
	url: string,
	timeoutMs: number,
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { signal: controller.signal });
	} catch (error) {
		if ((error as Error).name === "AbortError") {
			throw new Error(
				`PiperNative: download timed out after ${timeoutMs}ms for ${url}`,
			);
		}
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Ensures one data file exists in `destDir`, downloading it if needed.
 * Verifies `expectedSize` when provided. Atomic via temp file + rename.
 */
export async function ensureNativeDataFile(
	relativePath: string,
	destDir: string,
	expectedSize?: number,
): Promise<string> {
	const destPath = path.join(destDir, path.basename(relativePath));
	try {
		const stat = fs.statSync(destPath);
		if (
			stat.isFile() &&
			(expectedSize === undefined || stat.size === expectedSize)
		) {
			return destPath;
		}
	} catch {
		// missing, download below
	}

	const url = `${PIPER_GPL_RAW}/${relativePath}`;
	const response = await fetchWithTimeout(url, 300_000);
	if (!response.ok || !response.body) {
		throw new Error(
			`PiperNative: data download failed (${response.status}) for ${url}`,
		);
	}
	if (!fs.existsSync(destDir)) {
		fs.mkdirSync(destDir, { recursive: true });
	}
	const tmpPath = `${destPath}.part-${process.pid}-${Date.now()}`;
	try {
		await pipeline(
			Readable.fromWeb(
				response.body as import("node:stream/web").ReadableStream,
			),
			fs.createWriteStream(tmpPath),
		);
		if (expectedSize !== undefined) {
			const actualSize = fs.statSync(tmpPath).size;
			if (actualSize !== expectedSize) {
				throw new Error(
					`PiperNative: size mismatch for ${url} (expected ${expectedSize}, got ${actualSize}).`,
				);
			}
		}
		fs.renameSync(tmpPath, destPath);
	} catch (error) {
		try {
			if (fs.existsSync(tmpPath)) {
				fs.unlinkSync(tmpPath);
			}
		} catch {
			// best effort
		}
		throw error;
	}
	return destPath;
}

/** Ensures all files of a bundle exist. Returns paths keyed by basename. */
export async function ensureNativeDataBundle(
	bundle: keyof typeof NATIVE_DATA_BUNDLES,
	destDir: string,
): Promise<Record<string, string>> {
	const spec = NATIVE_DATA_BUNDLES[bundle];
	if (!spec) {
		throw new Error(`PiperNative: unknown data bundle "${bundle}".`);
	}
	const out: Record<string, string> = {};
	for (const file of spec.files) {
		out[path.basename(file)] = await ensureNativeDataFile(file, destDir);
	}
	return out;
}
