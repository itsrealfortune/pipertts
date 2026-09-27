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

export interface OrtLike {
	InferenceSession: {
		create(
			path: string,
			options?: unknown,
		): Promise<{
			run(feeds: Record<string, unknown>): Promise<Record<string, unknown>>;
		}>;
	};
	Tensor: new (type: string, data: unknown, dims: number[]) => unknown;
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

export interface NativeSession {
	run(feeds: {
		phonemeIds: number[];
		scales: [number, number, number];
		speakerId: number | null;
	}): Promise<Float32Array>;
	close?(): Promise<void>;
}

export async function createNativeSession(
	modelPath: string,
	options?: { numThreads?: number },
): Promise<NativeSession> {
	const ort = await loadOrt();
	const sessionOptions: Record<string, unknown> = {
		executionProviders: ["cpu"],
		graphOptimizationLevel: "all",
	};
	if (options?.numThreads !== undefined) {
		sessionOptions["intraOpNumThreads"] = options.numThreads;
	}
	const session = await ort.InferenceSession.create(modelPath, sessionOptions);

	return {
		async run({ phonemeIds, scales, speakerId }): Promise<Float32Array> {
			const feeds: Record<string, unknown> = {
				input: new ort.Tensor(
					"int64",
					BigInt64Array.from(phonemeIds.map((id) => BigInt(id))),
					[1, phonemeIds.length],
				),
				input_lengths: new ort.Tensor(
					"int64",
					BigInt64Array.from([BigInt(phonemeIds.length)]),
					[1],
				),
				scales: new ort.Tensor("float32", Float32Array.from(scales), [3]),
			};
			if (speakerId !== null) {
				feeds["sid"] = new ort.Tensor(
					"int64",
					BigInt64Array.from([BigInt(speakerId)]),
					[1],
				);
			}
			const results = await session.run(feeds);
			const audio =
				results["output"] ?? results["audio"] ?? Object.values(results)[0];
			const data = (audio as { data: ArrayLike<number> }).data;
			return Float32Array.from(data as ArrayLike<number>);
		},
	};
}
