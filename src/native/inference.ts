/**
 * ONNX inference (MVP).
 *
 * Mirrors `PiperVoice.phoneme_ids_to_audio` (`voice.py:498-575`):
 * inputs { input: int64[1,N], input_lengths: int64[1], scales: float32[3],
 *           sid?: int64[1] }, output audio float32.
 *
 * `onnxruntime-node` is imported lazily so pure-TS helpers remain usable
 * without the heavy native dependency installed.
 */

import * as fs from "node:fs";

/** Minimal structural type for onnxruntime-node (lazy import, mirrors piper1-gpl inference). */
export interface OrtLike {
	InferenceSession: {
		create(
			path: string,
			options?: unknown,
		): Promise<{
			run(feeds: Record<string, unknown>): Promise<Record<string, unknown>>;
			inputNames?: string[];
		}>;
	};
	Tensor: new (type: string, data: unknown, dims: number[]) => unknown;
	env?: { versions?: { node?: string; common?: string } };
}

async function loadOrt(): Promise<OrtLike> {
	try {
		return (await import("onnxruntime-node")) as unknown as OrtLike;
	} catch (error) {
		throw new Error(
			`PiperNative: "onnxruntime-node" is required for native inference but could not be loaded (${(error as Error).message}). Install it with: npm install onnxruntime-node`,
		);
	}
}

/** High-level inference session: phoneme ids + scales to float32 audio (voice.py:498-575). */
export interface NativeSession {
	/**
	 * Runs one inference and returns mono float32 audio samples.
	 *
	 * @param {number[]} feeds.phonemeIds - Phoneme ids including BOS/EOS padding.
	 * @param {[number, number, number]} feeds.scales - `[noiseScale, lengthScale, noiseWScale]`.
	 * @param {number | null} feeds.speakerId - Speaker index, or `null` for single-voice models.
	 * @returns {Promise<Float32Array>} Raw audio samples at the voice sample rate.
	 */
	run(feeds: {
		phonemeIds: number[];
		scales: [number, number, number];
		speakerId: number | null;
	}): Promise<Float32Array>;
	/** Releases native session resources, when supported. */
	close?(): Promise<void>;
}

/** Thin wrapper over a raw ONNX session exposing input names and untyped run. */
export interface RawOrtSession {
	inputNames: string[];
	run(
		feeds: Record<string, unknown>,
	): Promise<Record<string, { data: ArrayLike<number> }>>;
}

/** Options accepted by the session factories. */
export interface OrtSessionOptions {
	/** Intra-op thread count. Default: ORT default (all cores). */
	numThreads?: number;
	/** ONNX Runtime execution providers, in order of preference. Default: `["cpu"]`. */
	executionProviders?: string[];
	/**
	 * Cache the ORT-optimized model next to the source model and load from it
	 * on later calls (default: true). Cuts session load time by ~35% and
	 * slightly speeds up inference. Disable with `false` or `PIPER_ORT_CACHE=0`.
	 */
	cacheOptimizedModel?: boolean;
}

/** BigInt cache for small phoneme ids (avoids per-call BigInt allocation). */
const BIGINT_CACHE: bigint[] = [];
for (let i = 0; i < 512; i++) {
	BIGINT_CACHE[i] = BigInt(i);
}

function toBig(value: number): bigint {
	return BIGINT_CACHE[value] ?? BigInt(value);
}

function ortVersionTag(ort: OrtLike): string {
	const version = ort.env?.versions?.node ?? ort.env?.versions?.common;
	return (version ?? "unknown").replace(/[^\w.-]/g, "");
}

/**
 * Cache path for the ORT-optimized variant of `modelPath`, keyed by
 * platform/arch/ORT version (the serialized graph can contain
 * hardware-specific transforms such as NchwcTransformer).
 */
function optimizedModelCachePath(ort: OrtLike, modelPath: string): string {
	return `${modelPath}.ortopt-${process.platform}-${process.arch}-v${ortVersionTag(ort)}.onnx`;
}

function cacheEnabled(explicit: boolean | undefined): boolean {
	if (explicit !== undefined) {
		return explicit;
	}
	return process.env.PIPER_ORT_CACHE !== "0";
}

/**
 * Creates an InferenceSession, transparently caching ORT's optimized model.
 *
 * On a cache miss the session is created with `optimizedModelFilePath`
 * pointing at a temp file which is renamed into place once creation
 * succeeds; later calls load the cached file directly (same session
 * options), which skips most of the graph-optimization work at load time.
 * Every failure path degrades to a plain `InferenceSession.create`.
 */
async function createSessionWithCache(
	ort: OrtLike,
	modelPath: string,
	sessionOptions: Record<string, unknown>,
	useCache: boolean,
): Promise<Awaited<ReturnType<OrtLike["InferenceSession"]["create"]>>> {
	const cachePath = useCache ? optimizedModelCachePath(ort, modelPath) : null;
	if (cachePath !== null) {
		try {
			const cacheStat = fs.statSync(cachePath);
			const modelStat = fs.statSync(modelPath);
			if (cacheStat.isFile() && cacheStat.mtimeMs >= modelStat.mtimeMs) {
				return await ort.InferenceSession.create(cachePath, sessionOptions);
			}
		} catch {
			// Cache missing/unreadable: fall through and rebuild it.
		}
	}
	if (cachePath === null) {
		return ort.InferenceSession.create(modelPath, sessionOptions);
	}
	// Cache miss: write the optimized model to a temp file while creating the
	// session, then rename into place (atomic, safe under concurrent loaders).
	const tmpPath = `${cachePath}.tmp-${process.pid}`;
	try {
		const session = await ort.InferenceSession.create(modelPath, {
			...sessionOptions,
			optimizedModelFilePath: tmpPath,
		});
		try {
			fs.renameSync(tmpPath, cachePath);
		} catch {
			// Read-only model dir: keep the session, just skip the cache.
			try {
				fs.rmSync(tmpPath, { force: true });
			} catch {
				// best effort
			}
		}
		return session;
	} catch (error) {
		try {
			fs.rmSync(tmpPath, { force: true });
		} catch {
			// best effort
		}
		// Retry without the cache option so a cache-specific failure (for
		// example unwritable temp path) cannot mask a working plain load.
		try {
			return await ort.InferenceSession.create(modelPath, sessionOptions);
		} catch {
			throw error;
		}
	}
}

function buildSessionOptions(
	options: OrtSessionOptions | undefined,
): Record<string, unknown> {
	const sessionOptions: Record<string, unknown> = {
		executionProviders: options?.executionProviders ?? ["cpu"],
		graphOptimizationLevel: "all",
	};
	if (options?.numThreads !== undefined) {
		sessionOptions.intraOpNumThreads = options.numThreads;
	}
	return sessionOptions;
}

/** Creates a raw ONNX session with CPU provider and full graph optimization. */
export async function createRawOrtSession(
	modelPath: string,
	options?: OrtSessionOptions,
): Promise<{
	ort: OrtLike;
	session: RawOrtSession;
}> {
	const ort = await loadOrt();
	const raw = await createSessionWithCache(
		ort,
		modelPath,
		buildSessionOptions(options),
		cacheEnabled(options?.cacheOptimizedModel),
	);
	const inputNames = [...((raw as { inputNames: string[] }).inputNames ?? [])];
	const session: RawOrtSession = {
		inputNames,
		async run(feeds) {
			const results = await raw.run(feeds);
			const out: Record<string, { data: ArrayLike<number> }> = {};
			for (const [k, v] of Object.entries(results)) {
				out[k] = v as { data: ArrayLike<number> };
			}
			return out;
		},
	};
	return { ort, session };
}

/** Creates a NativeSession building piper1-gpl feeds (input, input_lengths, scales, sid). */
export async function createNativeSession(
	modelPath: string,
	options?: OrtSessionOptions,
): Promise<NativeSession> {
	const ort = await loadOrt();
	const session = await createSessionWithCache(
		ort,
		modelPath,
		buildSessionOptions(options),
		cacheEnabled(options?.cacheOptimizedModel),
	);

	return {
		async run({ phonemeIds, scales, speakerId }): Promise<Float32Array> {
			const length = phonemeIds.length;
			// Direct fill with a BigInt cache: avoids the intermediate BigInt
			// array that `BigInt64Array.from(ids.map(BigInt))` allocates.
			const ids = new BigInt64Array(length);
			for (let i = 0; i < length; i++) {
				ids[i] = toBig(phonemeIds[i] as number);
			}
			const feeds: Record<string, unknown> = {
				input: new ort.Tensor("int64", ids, [1, length]),
				input_lengths: new ort.Tensor(
					"int64",
					new BigInt64Array([toBig(length)]),
					[1],
				),
				scales: new ort.Tensor("float32", Float32Array.from(scales), [3]),
			};
			if (speakerId !== null) {
				feeds.sid = new ort.Tensor(
					"int64",
					new BigInt64Array([toBig(speakerId)]),
					[1],
				);
			}
			const results = await session.run(feeds);
			const audio =
				results.output ?? results.audio ?? Object.values(results)[0];
			const data = (audio as { data: ArrayLike<number> }).data;
			// ORT returns a Float32Array for float32 outputs: reuse it directly
			// instead of copying the whole audio buffer.
			return data instanceof Float32Array
				? data
				: Float32Array.from(data as ArrayLike<number>);
		},
	};
}
