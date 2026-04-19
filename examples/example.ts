import * as fs from "node:fs";
import * as path from "node:path";
import { PiperTTS } from "../src/index.ts";

async function main(): Promise<void> {
	const modelPath = path.resolve("models/example.onnx");
	const configPath = `${modelPath}.json`;
	const outputPath = path.resolve("examples/output.wav");

	if (!fs.existsSync(modelPath)) {
		throw new Error(
			`Model file not found: ${modelPath}. Put your .onnx model in the models/ directory or edit examples/example.ts.`,
		);
	}

	if (!fs.existsSync(configPath)) {
		throw new Error(
			`Model config not found: ${configPath}. Piper requires a matching .onnx.json file next to the model.`,
		);
	}

	const tts = await PiperTTS.create({
		modelPath,
		defaultOptions: {
			outputFormat: "wav",
			lengthScale: 0.95,
		},
	});

	const result = await tts.synthesize("Bonjour, ceci est t'un test produit depuis example.ts.");
	fs.writeFileSync(outputPath, result.audio);

	console.log(`Audio generated: ${outputPath}`);
	console.log(`Duration: ${result.durationMs}ms`);
	console.log(`Binary used: ${tts.getBinaryPath()}`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
