import * as fs from "node:fs";
import * as path from "node:path";
import {
	getPiperModelMetadata,
	getPiperModelsByLanguage,
	listPiperModels,
	PiperTTS,
} from "../src/index.ts";

async function main(): Promise<void> {
	const outputPath = path.resolve("examples/output.wav");
	const selectedModel = process.env.PIPER_MODEL ?? "en_US-lessac-medium";

	const availableModels = await listPiperModels();
	console.log(`Catalog size: ${availableModels.length - 1} models (+ custom)`);

	const enModels = await getPiperModelsByLanguage("en");
	console.log(`English variants available: ${enModels.length}`);

	if (selectedModel !== "custom") {
		const metadata = await getPiperModelMetadata(selectedModel);
		console.log(
			`Selected model: ${metadata?.key} (${metadata?.languageCode}, ${metadata?.quality})`,
		);
	}

	const createOptions =
		selectedModel === "custom"
			? {
					model: "custom" as const,
					modelPath: path.resolve(
						process.env.PIPER_MODEL_PATH ?? "models/example.onnx",
					),
				}
			: {
					model: selectedModel,
					modelsDir: "models",
				};

	const tts = await PiperTTS.create({
		...createOptions,
		defaultOptions: {
			outputFormat: "wav",
			lengthScale: 0.95,
		},
	});

	const result = await tts.synthesize(
		"Hello, this is a test generated from example.ts.",
	);
	fs.writeFileSync(outputPath, result.audio);

	console.log(`Audio generated: ${outputPath}`);
	console.log(`Duration: ${result.durationMs}ms`);
	console.log(`Binary used: ${tts.getBinaryPath()}`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
