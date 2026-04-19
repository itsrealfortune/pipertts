import { type SpawnOptions, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveModelPathFromOptions } from "./catalog.js";
import { resolveExecutable, resolveSystemCommand } from "./runtime.js";
import type {
	PiperInferenceOptions,
	PiperTTSOptions,
	SynthesisResult,
} from "./types.js";

function buildArgs(
	modelPath: string,
	options: PiperInferenceOptions,
	outputFile: string,
): string[] {
	const args: string[] = [];
	args.push("--model", modelPath);

	if (options.configPath) {
		args.push("--config", options.configPath);
	}

	if (outputFile === "-") {
		args.push("--output-raw");
	} else {
		args.push("--output-file", outputFile);
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
	if (options.logLevel) {
		args.push("--debug");
	}

	return args;
}

export class PiperTTS {
	private readonly binaryPath: string;
	private readonly commandPrefixArgs: string[];
	private readonly modelPath: string;
	private readonly defaultOptions: PiperInferenceOptions;

	private constructor(
		binaryPath: string,
		commandPrefixArgs: string[],
		modelPath: string,
		defaultOptions: PiperInferenceOptions,
	) {
		this.binaryPath = binaryPath;
		this.commandPrefixArgs = commandPrefixArgs;
		this.modelPath = modelPath;
		this.defaultOptions = defaultOptions;
	}

	static async create(options: PiperTTSOptions): Promise<PiperTTS> {
		const {
			piperBinaryPath,
			warmUpText = "Hello, this is a warm-up test.",
			defaultOptions = {},
		} = options;

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

		if (os.platform() !== "win32" && piperBinaryPath) {
			fs.chmodSync(resolvedBinary, 0o755);
		}

		const instance = new PiperTTS(
			resolvedBinary,
			commandPrefixArgs,
			resolvedModel,
			defaultOptions,
		);

		await instance.synthesize(warmUpText, { outputFormat: "wav" });
		return instance;
	}

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

		const modelPath = effectiveOptions.modelPath ?? this.modelPath;
		const useOutputFile = effectiveOptions.outputFile;

		let tmpFile: string | null = null;
		let targetFile: string;

		if (useOutputFile) {
			targetFile = path.resolve(useOutputFile);
		} else {
			tmpFile = path.join(
				os.tmpdir(),
				`piper_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`,
			);
			targetFile = tmpFile;
		}

		const args = buildArgs(modelPath, effectiveOptions, targetFile);
		const startMs = Date.now();
		await this.runPiper(text, args);
		const durationMs = Date.now() - startMs;

		const audio = fs.readFileSync(targetFile);
		if (tmpFile) {
			try {
				fs.unlinkSync(tmpFile);
			} catch {
				// Best-effort cleanup
			}
		}

		return {
			audio,
			durationMs,
			text,
			options: effectiveOptions,
		};
	}

	async synthesizeToFile(
		text: string,
		outputPath: string,
		options: Omit<PiperInferenceOptions, "outputFile"> = {},
	): Promise<void> {
		await this.synthesize(text, { ...options, outputFile: outputPath });
	}

	getModelPath(): string {
		return this.modelPath;
	}

	getBinaryPath(): string {
		return this.binaryPath;
	}

	getDefaultOptions(): Readonly<PiperInferenceOptions> {
		return { ...this.defaultOptions };
	}

	private runPiper(text: string, args: string[]): Promise<void> {
		return new Promise((resolve, reject) => {
			const spawnOptions: SpawnOptions = {
				stdio: ["pipe", "pipe", "pipe"],
			};

			const child = spawn(
				this.binaryPath,
				[...this.commandPrefixArgs, ...args],
				spawnOptions,
			);

			const stderrChunks: Buffer[] = [];
			child.stderr?.on("data", (chunk: Buffer) => {
				stderrChunks.push(chunk);
			});

			child.on("error", (err) => {
				reject(
					new Error(
						`PiperTTS: failed to spawn binary "${this.binaryPath}": ${err.message}`,
					),
				);
			});

			child.on("close", (code) => {
				if (code !== 0) {
					const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
					reject(
						new Error(
							`PiperTTS: process exited with code ${code}.\nStderr: ${stderr}`,
						),
					);
				} else {
					resolve();
				}
			});

			if (child.stdin) {
				child.stdin.write(text, "utf8");
				child.stdin.end();
			} else {
				reject(new Error("PiperTTS: stdin is not available on child process."));
			}
		});
	}
}
