import { type SpawnOptions, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveModelPathFromOptions } from "./catalog.js";
import { resolveExecutable, resolveSystemCommand } from "./runtime.js";
import type {
	PiperInferenceOptions,
	PiperTTSOptions,
	SynthesisResult,
} from "./types.js";

const DEFAULT_SYNTHESIS_TIMEOUT_MS = 60_000;

function validateInferenceOptions(options: PiperInferenceOptions): void {
	if (
		options.noiseScale !== undefined &&
		!(options.noiseScale >= 0 && options.noiseScale <= 2)
	) {
		throw new Error(
			`PiperTTS: noiseScale must be in range 0.0 - 2.0 (got ${options.noiseScale}).`,
		);
	}
	if (
		options.noiseWScale !== undefined &&
		!(options.noiseWScale >= 0 && options.noiseWScale <= 2)
	) {
		throw new Error(
			`PiperTTS: noiseWScale must be in range 0.0 - 2.0 (got ${options.noiseWScale}).`,
		);
	}
	if (
		options.lengthScale !== undefined &&
		!(options.lengthScale >= 0.1 && options.lengthScale <= 10)
	) {
		throw new Error(
			`PiperTTS: lengthScale must be in range 0.1 - 10.0 (got ${options.lengthScale}).`,
		);
	}
	if (
		options.sentenceSilence !== undefined &&
		!(options.sentenceSilence >= 0 && options.sentenceSilence <= 10)
	) {
		throw new Error(
			`PiperTTS: sentenceSilence must be in range 0.0 - 10.0 (got ${options.sentenceSilence}).`,
		);
	}
	if (
		options.speakerId !== undefined &&
		(!Number.isInteger(options.speakerId) || options.speakerId < 0)
	) {
		throw new Error(
			`PiperTTS: speakerId must be an integer >= 0 (got ${options.speakerId}).`,
		);
	}
	if (
		options.numThreads !== undefined &&
		(!Number.isInteger(options.numThreads) || options.numThreads < 1)
	) {
		throw new Error(
			`PiperTTS: numThreads must be an integer >= 1 (got ${options.numThreads}).`,
		);
	}
	if (
		options.timeoutMs !== undefined &&
		(!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0)
	) {
		throw new Error(
			`PiperTTS: timeoutMs must be a positive integer (got ${options.timeoutMs}).`,
		);
	}
}

function resolveConfigPath(
	modelPath: string,
	explicitConfigPath?: string,
): string | undefined {
	if (explicitConfigPath) {
		return explicitConfigPath;
	}
	const sibling = `${modelPath}.json`;
	try {
		const stat = fs.statSync(sibling);
		if (stat.isFile()) {
			return sibling;
		}
	} catch {
		// No sibling config, let Piper use its default lookup.
	}
	return undefined;
}

function buildArgs(
	modelPath: string,
	configPath: string | undefined,
	options: PiperInferenceOptions,
	output: { kind: "file"; file: string } | { kind: "raw" },
): string[] {
	const args: string[] = [];
	args.push("--model", modelPath);

	if (configPath) {
		args.push("--config", configPath);
	}

	if (output.kind === "raw") {
		args.push("--output-raw");
	} else {
		args.push("--output-file", output.file);
	}

	if (options.speakerId !== undefined) {
		args.push("--speaker", String(options.speakerId));
	}
	if (options.noiseScale !== undefined) {
		args.push("--noise-scale", String(options.noiseScale));
	}
	if (options.noiseWScale !== undefined) {
		args.push("--noise-w", String(options.noiseWScale));
	}
	if (options.lengthScale !== undefined) {
		args.push("--length-scale", String(options.lengthScale));
	}
	if (options.sentenceSilence !== undefined) {
		args.push("--sentence-silence", String(options.sentenceSilence));
	}
	if (options.jsonInput) {
		args.push("--json-input");
	}
	if (options.numThreads !== undefined) {
		args.push("--num-threads", String(options.numThreads));
	}
	if (options.useCuda) {
		args.push("--cuda");
	}
	// The Piper CLI only exposes a boolean --debug flag.
	if (options.logLevel === "debug") {
		args.push("--debug");
	}

	return args;
}

/**
 * High-level TypeScript wrapper around the Piper CLI.
 */
export class PiperTTS {
	private readonly binaryPath: string;
	private readonly commandPrefixArgs: string[];
	private readonly modelPath: string;
	private readonly defaultOptions: PiperInferenceOptions;
	private readonly defaultTimeoutMs: number;

	private constructor(
		binaryPath: string,
		commandPrefixArgs: string[],
		modelPath: string,
		defaultOptions: PiperInferenceOptions,
		defaultTimeoutMs: number,
	) {
		this.binaryPath = binaryPath;
		this.commandPrefixArgs = commandPrefixArgs;
		this.modelPath = modelPath;
		this.defaultOptions = defaultOptions;
		this.defaultTimeoutMs = defaultTimeoutMs;
	}

	/**
	 * Creates a new instance and performs a warm-up inference to validate setup.
	 *
	 * Pass `skipWarmup: true` to skip the validation inference.
	 *
	 * @param {PiperTTSOptions} options - Instance creation options.
	 * @returns {Promise<PiperTTS>} A fully initialized `PiperTTS` instance.
	 * @throws {Error} When model resolution, binary resolution, or warm-up fails.
	 */
	static async create(options: PiperTTSOptions): Promise<PiperTTS> {
		const {
			piperBinaryPath,
			warmUpText = "Hello, this is a warm-up test.",
			skipWarmup = false,
			synthesisTimeoutMs = DEFAULT_SYNTHESIS_TIMEOUT_MS,
			defaultOptions = {},
		} = options;

		if (!Number.isInteger(synthesisTimeoutMs) || synthesisTimeoutMs <= 0) {
			throw new Error(
				`PiperTTS: synthesisTimeoutMs must be a positive integer (got ${synthesisTimeoutMs}).`,
			);
		}

		const resolvedModel = await resolveModelPathFromOptions(options);
		if (!fs.existsSync(resolvedModel)) {
			throw new Error(`PiperTTS: model file not found at "${resolvedModel}".`);
		}

		let resolvedBinary: string;
		let commandPrefixArgs: string[];

		if (piperBinaryPath) {
			resolvedBinary = resolveExecutable(piperBinaryPath);
			commandPrefixArgs = [];
		} else {
			const systemCommand = resolveSystemCommand();
			resolvedBinary = systemCommand.command;
			commandPrefixArgs = systemCommand.commandPrefixArgs;
		}

		if (!fs.existsSync(resolvedBinary)) {
			throw new Error(`PiperTTS: executable not found at "${resolvedBinary}".`);
		}

		// Best-effort chmod, only for explicit file paths (not bare commands
		// resolved via PATH such as `python3`, where chmod would hit EPERM).
		if (os.platform() !== "win32" && piperBinaryPath) {
			const looksLikeFilePath =
				piperBinaryPath.includes(path.sep) || path.isAbsolute(piperBinaryPath);
			if (looksLikeFilePath) {
				try {
					fs.chmodSync(resolvedBinary, 0o755);
				} catch {
					// Best-effort: spawn will surface a clear error if not executable.
				}
			}
		}

		const instance = new PiperTTS(
			resolvedBinary,
			commandPrefixArgs,
			resolvedModel,
			defaultOptions,
			synthesisTimeoutMs,
		);

		if (!skipWarmup) {
			if (!warmUpText || warmUpText.trim().length === 0) {
				throw new Error(
					"PiperTTS: warmUpText must not be empty unless skipWarmup is true.",
				);
			}
			await instance.synthesize(warmUpText, { outputFormat: "wav" });
		}
		return instance;
	}

	/**
	 * Synthesizes speech for the given text and returns audio as `Buffer`.
	 *
	 * - `outputFormat: "wav"` (default): WAV bytes via a temp file
	 *   (or directly to `outputFile` when set).
	 * - `outputFormat: "raw"`: raw PCM bytes captured from stdout.
	 * - `outputFormat: "mp3" | "ogg" | "opus"`: WAV internally, transcoded via
	 *   ffmpeg (or pure-JS fallbacks: lamejs for mp3, opusscript for opus).
	 *
	 * @param {string} text - Input text to synthesize.
	 * @param {PiperInferenceOptions} callOptions - Optional inference options for this call.
	 * @returns {Promise<SynthesisResult>} Synthesis result with audio buffer and metadata.
	 * @throws {Error} When text is empty, options are invalid, or Piper fails.
	 */
	async synthesize(
		text: string,
		callOptions: PiperInferenceOptions = {},
	): Promise<SynthesisResult> {
		if (!text || text.trim().length === 0) {
			throw new Error("PiperTTS.synthesize: text must not be empty.");
		}

		const effectiveOptions: PiperInferenceOptions = {
			...this.defaultOptions,
			...Object.fromEntries(
				Object.entries(callOptions).filter(([, v]) => v !== undefined),
			),
		};
		validateInferenceOptions(effectiveOptions);

		const outputFormat = effectiveOptions.outputFormat ?? "wav";
		const needsTranscode =
			outputFormat === "mp3" ||
			outputFormat === "ogg" ||
			outputFormat === "opus";

		const modelPath = effectiveOptions.modelPath ?? this.modelPath;
		const configPath = resolveConfigPath(
			modelPath,
			effectiveOptions.configPath,
		);
		const timeoutMs = effectiveOptions.timeoutMs ?? this.defaultTimeoutMs;
		const useOutputFile = effectiveOptions.outputFile
			? path.resolve(effectiveOptions.outputFile)
			: null;

		const startMs = Date.now();

		if (outputFormat === "raw") {
			const args = buildArgs(modelPath, configPath, effectiveOptions, {
				kind: "raw",
			});
			const { stdout } = await this.runPiper(text, args, timeoutMs);
			if (useOutputFile) {
				await fsp.mkdir(path.dirname(useOutputFile), { recursive: true });
				await fsp.writeFile(useOutputFile, stdout);
			}
			return {
				audio: stdout,
				durationMs: Date.now() - startMs,
				text,
				options: { ...effectiveOptions, outputFormat },
			};
		}

		// WAV path: let Piper write a file, then read it back.
		// mp3/ogg: always via temp WAV, then transcode.
		let tmpDir: string | null = null;
		let targetFile: string;
		if (useOutputFile && !needsTranscode) {
			targetFile = useOutputFile;
			await fsp.mkdir(path.dirname(targetFile), { recursive: true });
		} else {
			tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "piper-"));
			targetFile = path.join(tmpDir, `piper_${randomUUID()}.wav`);
		}

		try {
			const args = buildArgs(modelPath, configPath, effectiveOptions, {
				kind: "file",
				file: targetFile,
			});
			await this.runPiper(text, args, timeoutMs);
			const wavAudio = await fsp.readFile(targetFile);
			let audio: Buffer = wavAudio as Buffer;
			if (needsTranscode) {
				const { transcodeAudio } = await import("./native/transcode.js");
				audio = await transcodeAudio(
					wavAudio,
					outputFormat as "mp3" | "ogg" | "opus",
				);
				if (useOutputFile) {
					await fsp.mkdir(path.dirname(useOutputFile), { recursive: true });
					await fsp.writeFile(useOutputFile, audio);
				}
			}
			return {
				audio,
				durationMs: Date.now() - startMs,
				text,
				options: { ...effectiveOptions, outputFormat },
			};
		} finally {
			if (tmpDir) {
				try {
					await fsp.rm(tmpDir, { recursive: true, force: true });
				} catch {
					// Best-effort cleanup
				}
			}
		}
	}

	/**
	 * Convenience helper that synthesizes directly to a file.
	 *
	 * @param {string} text - Input text to synthesize.
	 * @param {string} outputPath - Destination file path.
	 * @param {Omit<PiperInferenceOptions, "outputFile">} options - Optional inference options for this call.
	 * @returns {Promise<void>} Promise resolved when the output file has been written.
	 */
	async synthesizeToFile(
		text: string,
		outputPath: string,
		options: Omit<PiperInferenceOptions, "outputFile"> = {},
	): Promise<void> {
		await this.synthesize(text, { ...options, outputFile: outputPath });
	}

	/**
	 * Returns the resolved model path used by this instance.
	 *
	 * @returns {string} Absolute model path.
	 */
	getModelPath(): string {
		return this.modelPath;
	}

	/**
	 * Returns the resolved executable path used to run Piper.
	 *
	 * @returns {string} Absolute executable path.
	 */
	getBinaryPath(): string {
		return this.binaryPath;
	}

	/**
	 * Returns a copy of default inference options.
	 *
	 * @returns {Readonly<PiperInferenceOptions>} Read-only default inference options.
	 */
	getDefaultOptions(): Readonly<PiperInferenceOptions> {
		return { ...this.defaultOptions };
	}

	private runPiper(
		text: string,
		args: string[],
		timeoutMs: number,
	): Promise<{ stdout: Buffer; stderr: string }> {
		return new Promise((resolve, reject) => {
			const spawnOptions: SpawnOptions = {
				stdio: ["pipe", "pipe", "pipe"],
			};

			const child = spawn(
				this.binaryPath,
				[...this.commandPrefixArgs, ...args],
				spawnOptions,
			);

			const stdoutChunks: Buffer[] = [];
			const stderrChunks: Buffer[] = [];
			let settled = false;

			const timer = setTimeout(() => {
				if (settled) {
					return;
				}
				settled = true;
				try {
					child.kill("SIGKILL");
				} catch {
					// Best effort
				}
				const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
				reject(
					new Error(
						`PiperTTS: synthesis timed out after ${timeoutMs}ms.\nStderr: ${stderr}`,
					),
				);
			}, timeoutMs);
			timer.unref?.();

			const settleResolve = (value: { stdout: Buffer; stderr: string }) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				resolve(value);
			};
			const settleReject = (error: Error) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				reject(error);
			};

			child.stdout?.on("data", (chunk: Buffer) => {
				stdoutChunks.push(chunk);
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				stderrChunks.push(chunk);
			});

			child.on("error", (err) => {
				settleReject(
					new Error(
						`PiperTTS: failed to spawn binary "${this.binaryPath}": ${err.message}`,
					),
				);
			});

			child.on("close", (code) => {
				if (code !== 0) {
					const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
					settleReject(
						new Error(
							`PiperTTS: process exited with code ${code}.\nStderr: ${stderr}`,
						),
					);
				} else {
					settleResolve({
						stdout: Buffer.concat(stdoutChunks),
						stderr: Buffer.concat(stderrChunks).toString("utf8").trim(),
					});
				}
			});

			if (child.stdin) {
				child.stdin.on("error", (err) => {
					settleReject(
						new Error(
							`PiperTTS: failed to write to Piper stdin: ${err.message}`,
						),
					);
				});
				child.stdin.write(text, "utf8");
				child.stdin.end();
			} else {
				settleReject(
					new Error("PiperTTS: stdin is not available on child process."),
				);
			}
		});
	}
}
