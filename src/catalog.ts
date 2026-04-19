import * as fs from "node:fs";
import * as path from "node:path";
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

let voicesManifestCache: Record<string, PiperVoicesManifestEntry> | null = null;

async function fetchVoicesManifest(): Promise<
	Record<string, PiperVoicesManifestEntry>
> {
	if (voicesManifestCache) {
		return voicesManifestCache;
	}

	const response = await fetch(PIPER_VOICES_URL);
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
	return json;
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

async function downloadToFile(url: string, filePath: string): Promise<void> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(
			`PiperTTS: download failed (${response.status}) for ${url}`,
		);
	}

	const bytes = Buffer.from(await response.arrayBuffer());
	fs.writeFileSync(filePath, bytes);
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

	if (!fs.existsSync(targetModelPath)) {
		await downloadToFile(
			`${PIPER_FILES_BASE_URL}/${onnxPath}`,
			targetModelPath,
		);
	}

	if (!fs.existsSync(targetJsonPath)) {
		await downloadToFile(`${PIPER_FILES_BASE_URL}/${jsonPath}`, targetJsonPath);
	}

	return targetModelPath;
}

export async function listPiperModels(): Promise<string[]> {
	const manifest = await fetchVoicesManifest();
	return [...Object.keys(manifest).sort(), PIPER_CUSTOM_MODEL];
}

export async function getPiperModelsByLanguage(
	languageCode: string,
): Promise<string[]> {
	const normalized = languageCode.trim();
	if (!normalized) {
		throw new Error("PiperTTS: languageCode must not be empty.");
	}

	const manifest = await fetchVoicesManifest();
	const codeLower = normalized.toLowerCase();

	return Object.values(manifest)
		.filter((entry) => {
			const entryCode = entry.language?.code?.toLowerCase();
			if (!entryCode) {
				return false;
			}
			return entryCode === codeLower || entryCode.startsWith(`${codeLower}_`);
		})
		.map((entry) => entry.key)
		.sort();
}

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
