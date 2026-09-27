import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
	PiperModelMetadata,
	PiperTTSOptions,
	PiperVoicesManifestEntry,
} from "./types.js";

const PIPER_VOICES_URL =
	"https://huggingface.co/rhasspy/piper-voices/resolve/main/voices.json";
const PIPER_FILES_BASE_URL =
	"https://huggingface.co/rhasspy/piper-voices/resolve/main";
const PIPER_CUSTOM_MODEL = "custom";
const MANIFEST_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 300_000;

let voicesManifestCache: Record<string, PiperVoicesManifestEntry> | null = null;
let voicesManifestFetchedAt = 0;

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
				`PiperTTS: request timed out after ${timeoutMs}ms for ${url}`,
			);
		}
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

async function fetchVoicesManifest(): Promise<
	Record<string, PiperVoicesManifestEntry>
> {
	if (
		voicesManifestCache &&
		Date.now() - voicesManifestFetchedAt < MANIFEST_TTL_MS
	) {
		return voicesManifestCache;
	}

	const response = await fetchWithTimeout(PIPER_VOICES_URL, FETCH_TIMEOUT_MS);
	if (!response.ok) {
		throw new Error(
			`PiperTTS: unable to fetch Piper voices manifest (${response.status}).`,
		);
	}

	const json = (await response.json()) as Record<
		string,
		PiperVoicesManifestEntry
	>;
	voicesManifestCache = json;
	voicesManifestFetchedAt = Date.now();
	return json;
}

/**
 * Clears the in-memory voices manifest cache.
 * Mainly useful for tests or long-running processes.
 */
export function clearPiperManifestCache(): void {
	voicesManifestCache = null;
	voicesManifestFetchedAt = 0;
}

function resolveManifestEntry(
	manifest: Record<string, PiperVoicesManifestEntry>,
	modelId: string,
): PiperVoicesManifestEntry | null {
	if (manifest[modelId]) {
		return manifest[modelId];
	}

	for (const entry of Object.values(manifest)) {
		if (entry.aliases?.includes(modelId)) {
			return entry;
		}
	}

	return null;
}

function selectModelFiles(entry: PiperVoicesManifestEntry): {
	onnxPath: string;
	jsonPath: string;
} {
	const files = Object.keys(entry.files);
	const onnxPath = files.find((file) => file.endsWith(".onnx"));
	const jsonPath = files.find((file) => file.endsWith(".onnx.json"));

	if (!onnxPath || !jsonPath) {
		throw new Error(
			`PiperTTS: model "${entry.key}" is missing .onnx or .onnx.json in voices manifest.`,
		);
	}

	return { onnxPath, jsonPath };
}

async function downloadToFile(
	url: string,
	filePath: string,
	expectedMd5?: string,
	expectedSize?: number,
): Promise<void> {
	const response = await fetchWithTimeout(url, DOWNLOAD_TIMEOUT_MS);
	if (!response.ok || !response.body) {
		throw new Error(
			`PiperTTS: download failed (${response.status}) for ${url}`,
		);
	}

	const targetDir = path.dirname(filePath);
	if (!fs.existsSync(targetDir)) {
		fs.mkdirSync(targetDir, { recursive: true });
	}

	const tmpPath = `${filePath}.part-${process.pid}-${Date.now()}`;
	const hash = expectedMd5 ? createHash("md5") : null;

	async function* tap(
		source: AsyncIterable<Uint8Array>,
	): AsyncGenerator<Uint8Array> {
		for await (const chunk of source) {
			hash?.update(chunk);
			yield chunk;
		}
	}

	try {
		const webStream = Readable.fromWeb(
			response.body as import("node:stream/web").ReadableStream,
		);
		await pipeline(tap(webStream), fs.createWriteStream(tmpPath));

		if (expectedSize !== undefined) {
			const actualSize = fs.statSync(tmpPath).size;
			if (actualSize !== expectedSize) {
				throw new Error(
					`PiperTTS: size mismatch for ${url} (expected ${expectedSize}, got ${actualSize}).`,
				);
			}
		}

		if (hash && expectedMd5) {
			const actualMd5 = hash.digest("hex");
			if (actualMd5.toLowerCase() !== expectedMd5.toLowerCase()) {
				throw new Error(
					`PiperTTS: checksum mismatch for ${url} (expected md5 ${expectedMd5}, got ${actualMd5}).`,
				);
			}
		}

		fs.renameSync(tmpPath, filePath);
	} catch (error) {
		try {
			if (fs.existsSync(tmpPath)) {
				fs.unlinkSync(tmpPath);
			}
		} catch {
			// Best-effort cleanup
		}
		throw error;
	}
}

function existingFileLooksValid(
	filePath: string,
	expectedSize?: number,
): boolean {
	try {
		const stat = fs.statSync(filePath);
		if (!stat.isFile()) {
			return false;
		}
		if (expectedSize !== undefined && stat.size !== expectedSize) {
			return false;
		}
		return true;
	} catch {
		return false;
	}
}

async function ensureCatalogModelDownloaded(
	modelId: string,
	modelsDir: string,
): Promise<string> {
	const manifest = await fetchVoicesManifest();
	const entry = resolveManifestEntry(manifest, modelId);

	if (!entry) {
		throw new Error(
			`PiperTTS: unknown model "${modelId}". Use listPiperModels() to inspect available ids, or use model="custom" with modelPath.`,
		);
	}

	const { onnxPath, jsonPath } = selectModelFiles(entry);
	const targetDir = path.resolve(modelsDir);
	const targetModelPath = path.join(targetDir, path.basename(onnxPath));
	const targetJsonPath = path.join(targetDir, path.basename(jsonPath));

	if (!fs.existsSync(targetDir)) {
		fs.mkdirSync(targetDir, { recursive: true });
	}

	const onnxMeta = entry.files[onnxPath];
	const jsonMeta = entry.files[jsonPath];

	if (!existingFileLooksValid(targetModelPath, onnxMeta?.size_bytes)) {
		await downloadToFile(
			`${PIPER_FILES_BASE_URL}/${onnxPath}`,
			targetModelPath,
			onnxMeta?.md5_digest,
			onnxMeta?.size_bytes,
		);
	}

	if (!existingFileLooksValid(targetJsonPath, jsonMeta?.size_bytes)) {
		await downloadToFile(
			`${PIPER_FILES_BASE_URL}/${jsonPath}`,
			targetJsonPath,
			jsonMeta?.md5_digest,
			jsonMeta?.size_bytes,
		);
	}

	return targetModelPath;
}

/**
 * Lists all catalog model ids from the Piper voices manifest.
 *
 * @returns {Promise<string[]>} Sorted model ids plus the special `"custom"` entry.
 */
export async function listPiperModels(): Promise<string[]> {
	const manifest = await fetchVoicesManifest();
	return [...Object.keys(manifest).sort(), PIPER_CUSTOM_MODEL];
}

function normalizeLanguageCode(code: string): string {
	return code.trim().toLowerCase().replace(/-/g, "_");
}

/**
 * Returns catalog model ids filtered by language.
 *
 * Matching rules:
 * - exact code match (example: `en_US`, also accepts `en-US`)
 * - family prefix match (example: `en` matches `en_US`, `en_GB`, ...)
 *
 * @param {string} languageCode - Exact locale (`en_US`) or family prefix (`en`).
 * @returns {Promise<string[]>} Sorted catalog model ids matching the requested language.
 * @throws {Error} When `languageCode` is empty.
 */
export async function getPiperModelsByLanguage(
	languageCode: string,
): Promise<string[]> {
	const normalized = normalizeLanguageCode(languageCode);
	if (!normalized) {
		throw new Error("PiperTTS: languageCode must not be empty.");
	}

	const manifest = await fetchVoicesManifest();

	return Object.values(manifest)
		.filter((entry) => {
			const entryCode = entry.language?.code
				? normalizeLanguageCode(entry.language.code)
				: "";
			if (!entryCode) {
				return false;
			}
			return entryCode === normalized || entryCode.startsWith(`${normalized}_`);
		})
		.map((entry) => entry.key)
		.sort();
}

/**
 * Returns metadata for a catalog model id or alias.
 * Returns `null` for `"custom"`.
 *
 * @param {string} modelId - Catalog id, alias, or `"custom"`.
 * @returns {Promise<PiperModelMetadata | null>} Model metadata, or `null` for `"custom"`.
 * @throws {Error} When the model id is unknown.
 */
export async function getPiperModelMetadata(
	modelId: string,
): Promise<PiperModelMetadata | null> {
	if (modelId === PIPER_CUSTOM_MODEL) {
		return null;
	}

	const manifest = await fetchVoicesManifest();
	const entry = resolveManifestEntry(manifest, modelId);
	if (!entry) {
		throw new Error(
			`PiperTTS: unknown model "${modelId}". Use listPiperModels() to inspect available ids.`,
		);
	}

	return {
		key: entry.key,
		name: entry.name,
		quality: entry.quality,
		numSpeakers: entry.num_speakers,
		languageCode: entry.language?.code,
		languageNameEnglish: entry.language?.name_english,
		languageNameNative: entry.language?.name_native,
		aliases: entry.aliases ?? [],
		filePaths: Object.keys(entry.files),
	};
}

/**
 * Resolves a usable local model path from `PiperTTSOptions`.
 *
 * - Catalog model id: ensures `.onnx` and `.onnx.json` are downloaded.
 * - `custom`/unset model: uses `modelPath`.
 *
 * @param {PiperTTSOptions} options - Creation options passed to `PiperTTS.create`.
 * @returns {Promise<string>} Absolute path to a local `.onnx` model file.
 * @throws {Error} When options are invalid or model resolution fails.
 */
export async function resolveModelPathFromOptions(
	options: PiperTTSOptions,
): Promise<string> {
	if (options.model && options.model !== PIPER_CUSTOM_MODEL) {
		const modelsDir = options.modelsDir ?? "models";
		return ensureCatalogModelDownloaded(options.model, modelsDir);
	}

	if (!options.modelPath) {
		throw new Error(
			"PiperTTS: modelPath is required when model is not set to a catalog id.",
		);
	}

	return path.resolve(options.modelPath);
}
