/**
 * Loader for the native espeak-ng bridge (N-API).
 *
 * Search order: prebuilds (`prebuilds/<platform>-<arch>/`, napi-prefixed
 * first), then local `build/Release` (dev `node-gyp rebuild`). Returns
 * `null` so callers fall back to the `espeak-ng` CLI. The bridge call is
 * fully synchronous (setVoice + getPhonemes in one tick), which preserves
 * the process-global voice atomicity that Python achieves with ESPEAK_LOCK.
 */

import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** One espeak-ng clause: phoneme string plus terminator and sentence-end flag. */
export interface EspeakClause {
	phonemes: string;
	terminator: string;
	endOfSentence: boolean;
}

/** N-API espeak-ng bridge with atomic phonemize (mirrors piper1-gpl ESPEAK_LOCK). */
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

function candidatePaths(): string[] {
	const here = path.dirname(fileURLToPath(import.meta.url));
	// Package root from src/native/espeak-bridge (tsc layout) or dist equivalent.
	const pkgRoot = path.resolve(here, "..", "..", "..");
	const prebuildDir = path.join(
		pkgRoot,
		"prebuilds",
		`${process.platform}-${process.arch}`,
	);
	return [
		path.join(prebuildDir, "espeak_bridge.napi.node"),
		path.join(prebuildDir, "espeak_bridge.node"),
		path.join(pkgRoot, "build", "Release", "espeak_bridge.node"),
	];
}

function tryLoadAddon(): Omit<EspeakBridge, "phonemize"> | null {
	try {
		const require = createRequire(import.meta.url);
		for (const candidate of candidatePaths()) {
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

/**
 * Returns the cached bridge, loading and initializing it on first call.
 * `null` when disabled (`PIPER_ESPEAK_BRIDGE=0`), missing, or init fails.
 */
export function getEspeakBridge(): EspeakBridge | null {
	if (cached !== undefined) {
		return cached;
	}
	// Escape hatch: PIPER_ESPEAK_BRIDGE=0 forces the espeak-ng CLI fallback
	// (useful if a locally built addon misbehaves on an exotic toolchain).
	if (process.env.PIPER_ESPEAK_BRIDGE === "0") {
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

/**
 * True when the native bridge is usable (false → CLI fallback).
 */
export function isEspeakBridgeAvailable(): boolean {
	return getEspeakBridge() !== null;
}
