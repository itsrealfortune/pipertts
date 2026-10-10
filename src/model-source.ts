/**
 * Shared model resolution: local path, direct URL, or catalog reference.
 *
 * Resolution order:
 * 1. Explicit local `modelPath`.
 * 2. Direct `modelUrl` (downloaded once into `modelsDir`, then cached).
 * 3. `model` catalog reference: rhasspy id/alias, `hub:<slug>`, piperhub.org
 *    page URL, or bare PiperHub slug.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { downloadToFile } from "./catalog.js";
import {
	ensurePiperHubModelDownloaded,
	parsePiperHubSlug,
} from "./piperhub.js";

/** Model source options accepted by `resolveModelFiles`. */
export interface ModelSourceOptions {
	/** Catalog reference: rhasspy id/alias, `hub:<slug>`, page URL, or bare hub slug. */
	model?: string;
	/** Local `.onnx` file path. Takes precedence over `model` / `modelUrl`. */
	modelPath?: string;
	/** Direct URL to a `.onnx` file (any host, including Hugging Face). */
	modelUrl?: string;
	/** Local `.onnx.json` config path (defaults to `<model>.json`). */
	configPath?: string;
	/** Direct URL to a `.onnx.json` config (defaults to `<modelUrl>.json`). */
	configUrl?: string;
	/** Directory used for downloaded models. Default: `"models"`. */
	modelsDir?: string;
}

/** Resolved local model + config file paths. */
export interface ResolvedModelFiles {
	/** Absolute path to the local `.onnx` file. */
	modelPath: string;
	/** Absolute path to the local `.onnx.json` config file. */
	configPath: string;
}

function assertHttpUrl(value: string, label: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`PiperTTS: ${label} is not a valid URL (got "${value}").`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`PiperTTS: ${label} must use http(s) (got "${value}").`);
	}
	return url;
}

function cacheNameForUrl(modelUrl: string, fallback: string): string {
	const pathname = new URL(modelUrl).pathname;
	const base = path.basename(pathname) || fallback;
	return base.endsWith(".onnx") ? base : `${base}.onnx`;
}

/**
 * Downloads a `.onnx` model (plus its config) from arbitrary URLs into a
 * content-addressed cache dir. Files are skipped when already present and
 * non-empty, so repeated loads are free.
 *
 * @param {string} modelUrl - Direct URL to the `.onnx` file.
 * @param {string | undefined} configUrl - Direct URL to the config. Defaults to `<modelUrl>.json`.
 * @param {string} modelsDir - Cache root directory.
 * @returns {Promise<ResolvedModelFiles>} Local model + config paths.
 */
export async function ensureModelUrlDownloaded(
	modelUrl: string,
	configUrl: string | undefined,
	modelsDir: string,
): Promise<ResolvedModelFiles> {
	assertHttpUrl(modelUrl, "modelUrl");
	const resolvedConfigUrl = configUrl ?? `${modelUrl}.json`;
	if (configUrl) {
		assertHttpUrl(configUrl, "configUrl");
	} else {
		assertHttpUrl(resolvedConfigUrl, "configUrl");
	}
	const dir = path.join(
		path.resolve(modelsDir),
		`url-${createHash("sha1").update(modelUrl).digest("hex").slice(0, 12)}`,
	);
	const targetModelPath = path.join(
		dir,
		cacheNameForUrl(modelUrl, "model.onnx"),
	);
	const targetJsonPath = `${targetModelPath}.json`;
	const valid = (p: string): boolean => {
		try {
			return fs.existsSync(p) && fs.statSync(p).size > 0;
		} catch {
			return false;
		}
	};
	if (!valid(targetModelPath)) {
		await downloadToFile(modelUrl, targetModelPath);
	}
	if (!valid(targetJsonPath)) {
		await downloadToFile(resolvedConfigUrl, targetJsonPath);
	}
	return { modelPath: targetModelPath, configPath: targetJsonPath };
}

/**
 * Resolves usable local model + config paths from any supported source.
 *
 * @param {ModelSourceOptions} options - Model source options.
 * @returns {Promise<ResolvedModelFiles>} Absolute local model + config paths.
 * @throws {Error} When no usable source is provided or resolution fails.
 */
export async function resolveModelFiles(
	options: ModelSourceOptions,
): Promise<ResolvedModelFiles> {
	if (options.modelPath) {
		const modelPath = path.resolve(options.modelPath);
		return {
			modelPath,
			configPath: options.configPath
				? path.resolve(options.configPath)
				: `${modelPath}.json`,
		};
	}

	if (options.modelUrl) {
		const resolved = await ensureModelUrlDownloaded(
			options.modelUrl,
			options.configUrl,
			options.modelsDir ?? "models",
		);
		if (options.configPath) {
			return {
				modelPath: resolved.modelPath,
				configPath: path.resolve(options.configPath),
			};
		}
		return resolved;
	}

	if (options.model && options.model !== "custom") {
		const modelsDir = options.modelsDir ?? "models";
		// PiperHub references first (cheap string match, no network on miss).
		if (parsePiperHubSlug(options.model)) {
			const modelPath = await ensurePiperHubModelDownloaded(
				options.model,
				modelsDir,
			);
			return { modelPath, configPath: `${modelPath}.json` };
		}
		// Rhasspy catalog, with transparent fallback to a bare PiperHub slug.
		const { ensureCatalogModelDownloaded } = await import("./catalog.js");
		try {
			const modelPath = await ensureCatalogModelDownloaded(
				options.model,
				modelsDir,
			);
			return { modelPath, configPath: `${modelPath}.json` };
		} catch (error) {
			const message = (error as Error).message ?? "";
			if (!message.startsWith("PiperTTS: unknown model")) {
				throw error;
			}
			try {
				const modelPath = await ensurePiperHubModelDownloaded(
					options.model,
					modelsDir,
				);
				return { modelPath, configPath: `${modelPath}.json` };
			} catch {
				throw error;
			}
		}
	}

	if (!options.modelPath) {
		throw new Error(
			'PiperTTS: provide modelPath, modelUrl, or a catalog model id (rhasspy id or PiperHub slug, e.g. model: "hub:glados-french-medium-voice").',
		);
	}
	// Unreachable (modelPath handled above), kept for exhaustiveness.
	throw new Error("PiperTTS: unable to resolve model files.");
}
