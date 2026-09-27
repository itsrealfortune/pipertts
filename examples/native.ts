import * as fs from "node:fs";
import * as path from "node:path";
import { PiperNativeTTS } from "../src/index.ts";

async function main(): Promise<void> {
	const outDir = path.resolve("examples");
	const tts = await PiperNativeTTS.load({
		modelPath: path.resolve("models/en_US-lessac-medium.onnx"),
	});

	const startTime = Date.now();

	console.log(`phoneme type: ${tts.getConfig().phonemeType}`);
	console.log(`sample rate: ${tts.getConfig().sampleRate}Hz`);

	const wav = await tts.synthesize("Hello from the native pipeline.", {
		outputFormat: "wav",
	});
	fs.writeFileSync(path.join(outDir, "native-output.wav"), wav.audio);
	console.log(`wav: ${wav.audio.length} bytes`);

	const mp3 = await tts.synthesize("Same line, compressed.", {
		outputFormat: "mp3",
	});
	fs.writeFileSync(path.join(outDir, "native-output.mp3"), mp3.audio);
	console.log(`mp3: ${mp3.audio.length} bytes`);

	const phonemes = await tts.phonemize("Hello world.");
	console.log(`phonemes: ${JSON.stringify(phonemes.map((s) => s.join("")))}`);
	console.log(`Execution time: ${Date.now() - startTime} ms`);
}

main().then(() => {
	console.log("Native TTS example completed successfully.");
}).catch((error) => {
	console.error(error);
	process.exit(1);
});
