/**
 * PiperHub catalog (piperhub.org).
 *
 * PiperHub is a community index of ~500 Piper voices backed by the
 * `fox3000foxy/piper-bank` repo. The site itself is static (no JSON API),
 * but its data source of truth (`src/data/models.json`) is fetchable raw
 * from GitHub. Each entry points at a Hugging Face repo holding the actual
 * `.onnx` + `.onnx.json` files, so downloads go straight to Hugging Face.
 */

import * as path from "node:path";
import { downloadToFile } from "./catalog.js";

/** Raw PiperHub model entry (`src/data/models.json` in piper-bank). */
export interface PiperHubModelEntry {
	/** URL slug, also used as the local cache basename (`<slug>.onnx`). */
	slug: string;
	/** Display name (for example, `"GLaDOS - French Medium Voice"`). */
	name: string;
	/** Hugging Face repo holding the files (for example, `"rhasspy/piper-voices"`). */
	repo: string;
	/** Model path inside the repo, or a bare filename for single-file repos. */
	onnx: string;
	/** Config path inside the repo, or a bare filename. */
	json: string;
	/** Model author. */
	author?: string;
	/** Quality tier (`low` / `medium` / `high`). */
	quality?: string;
	/** ISO-ish language code (for example, `"fr"`, `"en"`). */
	lang?: string;
	/** Human-readable language name. */
	langName?: string;
	/** Number of speakers/voices. */
	voices?: number;
	/** Speaker names for synthesis. */
	voiceNames?: string[];
	/** Sample rate in Hz. */
	sampleRate?: number;
	/** License string (often empty — check the HF repo). */
	license?: string;
	/** Last-update date (`YYYY-MM-DD`). */
	updated?: string;
}

/** Public metadata shape returned by the PiperHub helpers. */
export interface PiperHubModelMetadata extends PiperHubModelEntry {
	/** Direct download URL for the `.onnx` file. */
	onnxUrl: string;
	/** Direct download URL for the `.onnx.json` config. */
	jsonUrl: string;
	/** Canonical PiperHub page for this voice. */
	pageUrl: string;
}

const PIPERHUB_MODELS_URL =
	"https://raw.githubusercontent.com/fox3000foxy/piper-bank/main/src/data/models.json";
const PIPERHUB_PAGE_BASE = "https://piperhub.org/model";
const PIPERHUB_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

let piperHubCache: PiperHubModelEntry[] | null = null;
let piperHubFetchedAt = 0;

/** Clears the in-memory PiperHub catalog cache (mainly useful for tests). */
export function clearPiperHubCache(): void {
	piperHubCache = null;
	piperHubFetchedAt = 0;
}

async function fetchPiperHubModels(): Promise<PiperHubModelEntry[]> {
	if (piperHubCache && Date.now() - piperHubFetchedAt < PIPERHUB_TTL_MS) {
		return piperHubCache;
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(PIPERHUB_MODELS_URL, {
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(
				`PiperHub: unable to fetch model catalog (${response.status}).`,
			);
		}
		const json = (await response.json()) as PiperHubModelEntry[];
		if (!Array.isArray(json)) {
			throw new Error("PiperHub: unexpected catalog shape (expected array).");
		}
		piperHubCache = json;
		piperHubFetchedAt = Date.now();
		return json;
	} catch (error) {
		if ((error as Error).name === "AbortError") {
			throw new Error(
				`PiperHub: request timed out after ${FETCH_TIMEOUT_MS}ms.`,
			);
		}
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Extracts a PiperHub slug from the accepted model reference forms.
 *
 * Accepted: bare slug (`glados-french-medium-voice`), `hub:<slug>`,
 * `piperhub:<slug>`, or a full page URL
 * (`https://piperhub.org/model/<slug>/`).
 *
 * @param {string} input - Model reference to parse.
 * @returns {string | null} The slug, or `null` when the input is not a PiperHub reference.
 */
export function parsePiperHubSlug(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) {
		return null;
	}
	const pageMatch = trimmed.match(
		/^https?:\/\/(?:www\.)?piperhub\.org\/model\/([^/?#]+)\/?(?:[?#].*)?$/i,
	);
	if (pageMatch?.[1]) {
		return pageMatch[1].toLowerCase();
	}
	const prefixMatch = trimmed.match(/^(?:hub|piperhub):(.+)$/i);
	if (prefixMatch?.[1]) {
		const slug = prefixMatch[1].trim().toLowerCase();
		return slug || null;
	}
	return null;
}

/** Builds a direct Hugging Face download URL for a repo-relative file. */
export function piperHubFileUrl(
	entry: PiperHubModelEntry,
	kind: "onnx" | "json",
): string {
	const rel = kind === "onnx" ? entry.onnx : entry.json;
	if (/^https?:\/\//i.test(rel)) {
		return rel;
	}
	return `https://huggingface.co/${entry.repo}/resolve/main/${rel}`;
}

/**
 * Lists all PiperHub model slugs.
 *
 * @returns {Promise<string[]>} Sorted slugs (for example, `"glados-french-medium-voice"`).
 */
export async function listPiperHubModels(): Promise<string[]> {
	const models = await fetchPiperHubModels();
	return models.map((m) => m.slug).sort();
}

/**
 * Returns metadata for a PiperHub voice.
 *
 * @param {string} slugOrRef - Bare slug, `hub:<slug>`, or full piperhub.org page URL.
 * @returns {Promise<PiperHubModelMetadata>} Model metadata with download URLs.
 * @throws {Error} When the slug is unknown.
 */
export async function getPiperHubModelMetadata(
	slugOrRef: string,
): Promise<PiperHubModelMetadata> {
	const slug = parsePiperHubSlug(slugOrRef) ?? slugOrRef.trim().toLowerCase();
	const models = await fetchPiperHubModels();
	const entry = models.find((m) => m.slug.toLowerCase() === slug);
	if (!entry) {
		throw new Error(
			`PiperHub: unknown model "${slugOrRef}". Use listPiperHubModels() to inspect available slugs.`,
		);
	}
	return {
		...entry,
		onnxUrl: piperHubFileUrl(entry, "onnx"),
		jsonUrl: piperHubFileUrl(entry, "json"),
		pageUrl: `${PIPERHUB_PAGE_BASE}/${entry.slug}/`,
	};
}

/**
 * Returns PiperHub slugs filtered by language.
 *
 * Matching rules: exact code match (`fr`) or family prefix (`en` matches
 * `en`, entries store short codes like `fr` / `en` / `zh`).
 *
 * @param {string} languageCode - Language code (for example, `"fr"` or `"en"`).
 * @returns {Promise<string[]>} Sorted slugs matching the language.
 * @throws {Error} When `languageCode` is empty.
 */
export async function getPiperHubModelsByLanguage(
	languageCode: string,
): Promise<string[]> {
	const normalized = languageCode.trim().toLowerCase().replace(/-/g, "_");
	if (!normalized) {
		throw new Error("PiperHub: languageCode must not be empty.");
	}
	const models = await fetchPiperHubModels();
	return models
		.filter((entry) => {
			const code = (entry.lang ?? "").trim().toLowerCase().replace(/-/g, "_");
			if (!code) {
				return false;
			}
			return code === normalized || code.startsWith(`${normalized}_`);
		})
		.map((entry) => entry.slug)
		.sort();
}

/**
 * Downloads a PiperHub voice (`.onnx` + `.onnx.json`) into `modelsDir`.
 * Files are cached as `<slug>.onnx` / `<slug>.onnx.json` and skipped when
 * already present and non-empty.
 *
 * @param {string} slugOrRef - Bare slug, `hub:<slug>`, or full piperhub.org page URL.
 * @param {string} modelsDir - Destination directory.
 * @returns {Promise<string>} Absolute path to the local `.onnx` file.
 */
export async function ensurePiperHubModelDownloaded(
	slugOrRef: string,
	modelsDir: string,
): Promise<string> {
	const meta = await getPiperHubModelMetadata(slugOrRef);
	const dir = path.resolve(modelsDir);
	const targetModelPath = path.join(dir, `${meta.slug}.onnx`);
	const targetJsonPath = path.join(dir, `${meta.slug}.onnx.json`);
	const { statSync, existsSync } = await import("node:fs");
	const valid = (p: string): boolean => {
		try {
			return existsSync(p) && statSync(p).size > 0;
		} catch {
			return false;
		}
	};
	if (!valid(targetModelPath)) {
		await downloadToFile(meta.onnxUrl, targetModelPath);
	}
	if (!valid(targetJsonPath)) {
		await downloadToFile(meta.jsonUrl, targetJsonPath);
	}
	return targetModelPath;
}
