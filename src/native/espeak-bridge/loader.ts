/**
 * Loader for the native espeak-ng bridge (N-API).
 *
 * Tries the compiled addon first, falls back to `null` so callers can use
 * the `espeak-ng` CLI fallback. The bridge call is fully synchronous
 * (setVoice + getPhonemes in one tick), which preserves the process-global
 * voice atomicity that Python achieves with ESPEAK_LOCK.
 */

import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface EspeakClause {
	phonemes: string;
	terminator: string;
	endOfSentence: boolean;
}

export interface EspeakBridge {
	initialize(dataDir: string): void;
	setVoice(voice: string): void;
	getPhonemes(text: string): EspeakClause[];
	/** Atomic: set voice + return clauses (no interleaving possible). */
	phonemize(voice: string, text: string): EspeakClause[];
}

const DEFAULT_DATA_DIRS = [
	"/usr/lib/x86_64-linux-gnu/espeak-ng-data",
	"/usr/share/espeak-ng-data",
	"/usr/local/share/espeak-ng-data",
];

function tryLoadAddon(): Omit<EspeakBridge, "phonemize"> | null {
	try {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const candidates = [
			path.join(
				here,
				"..",
				"..",
				"..",
				"build",
				"Release",
				"espeak_bridge.node",
			),
			path.join(here, "build", "Release", "espeak_bridge.node"),
		];
		const require = createRequire(import.meta.url);
		for (const candidate of candidates) {
			try {
				return require(candidate) as Omit<EspeakBridge, "phonemize">;
			} catch {
				// try next candidate
			}
		}
		return null;
	} catch {
		return null;
	}
}

let cached: EspeakBridge | null | undefined;

export function getEspeakBridge(): EspeakBridge | null {
	if (cached !== undefined) {
		return cached;
	}
	// Opt-in: local-toolchain builds segfault at process exit on some
	// systems (e.g. Debian Node 22 + g++14, reproducible with hello-world
	// addons). Default stays on the espeak-ng CLI fallback.
	if (process.env.PIPER_ESPEAK_BRIDGE !== "1") {
		cached = null;
		return cached;
	}
	const raw = tryLoadAddon();
	if (!raw) {
		cached = null;
		return cached;
	}
	try {
		const dataDir =
			process.env.ESPEAK_NG_DATA ??
			DEFAULT_DATA_DIRS.find((dir) => {
				try {
					return fs.existsSync(dir);
				} catch {
					return false;
				}
			}) ??
			DEFAULT_DATA_DIRS[0];
		raw.initialize(dataDir as string);
	} catch {
		cached = null;
		return cached;
	}
	cached = {
		...raw,
		phonemize: (voice: string, text: string) => {
			raw.setVoice(voice);
			return raw.getPhonemes(text);
		},
	};
	return cached;
}

export function isEspeakBridgeAvailable(): boolean {
	return getEspeakBridge() !== null;
}
