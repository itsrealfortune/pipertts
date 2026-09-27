import * as fs from "node:fs";
import * as path from "node:path";
import {
	getPiperModelMetadata,
	getPiperModelsByLanguage,
	listPiperModels,
	PiperNativeTTS,
	resolveModelPathFromOptions,
} from "../src/index.ts";

async function main(): Promise<void> {
	const outputPath = path.resolve("examples/output-native.wav");
	const selectedModel = process.env.PIPER_MODEL ?? "en_US-lessac-medium";

	const availableModels = await listPiperModels();
	console.log(`Catalog size: ${availableModels.length - 1} models (+ custom)`);

	const enModels = await getPiperModelsByLanguage("en");
	console.log(`English variants available: ${enModels.length}`);

	let modelPath: string;
	if (selectedModel !== "custom") {
		const metadata = await getPiperModelMetadata(selectedModel);
		console.log(
			`Selected model: ${metadata?.key} (${metadata?.languageCode}, ${metadata?.quality})`,
		);
		modelPath = await resolveModelPathFromOptions({
			model: selectedModel,
			modelsDir: "models",
		});
	} else {
		modelPath = path.resolve(
			process.env.PIPER_MODEL_PATH ?? "models/example.onnx",
		);
	}

	const tts = await PiperNativeTTS.load({ modelPath });
	console.log(`Phoneme type: ${tts.getConfig().phonemeType}`);
	console.log(`Sample rate: ${tts.getConfig().sampleRate}Hz`);

	const sentences = await tts.phonemize("Hello, this is a test generated from example-native.ts.");
	console.log(`Phonemes: ${JSON.stringify(sentences.map((s) => s.join("")))}`);

	const startMs = Date.now();
	const result = await tts.synthesize(
		"Hello, this is a test generated from example-native.ts.",
		{ outputFormat: "wav", lengthScale: 0.95 },
	);
	fs.writeFileSync(outputPath, result.audio);

	console.log(`Audio generated: ${outputPath}`);
	console.log(`Synthesis took ${Date.now() - startMs}ms (in-process, no Python)`);
	console.log(`Model used: ${tts.getModelPath()}`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
