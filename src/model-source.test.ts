import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { createServer, type Server } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { resolveModelPathFromOptions } from "./catalog.js";
import { ensureModelUrlDownloaded, resolveModelFiles } from "./model-source.js";
import {
	mirrorDirForRepo,
	parsePiperHubSlug,
	piperHubFileUrl,
	selectMirrorFiles,
} from "./piperhub.js";

const ONNX_BYTES = Buffer.from("fake-onnx-bytes");
const CONFIG_TEXT = '{"audio":{"sample_rate":22050}}';
const ALT_CONFIG_TEXT = '{"audio":{"sample_rate":16000}}';

let server: Server;
let baseUrl = "";
let hits = 0;

beforeAll(async () => {
	server = createServer((req, res) => {
		hits += 1;
		if (req.url === "/voice.onnx") {
			res.writeHead(200, { "content-type": "application/octet-stream" });
			res.end(ONNX_BYTES);
		} else if (
			req.url === "/voice.onnx.json" ||
			req.url === "/other-config.json"
		) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(req.url === "/other-config.json" ? ALT_CONFIG_TEXT : CONFIG_TEXT);
		} else {
			res.writeHead(404);
			res.end("nope");
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;
	baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve, reject) =>
		server.close((err) => (err ? reject(err) : resolve())),
	);
});

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "piper-url-"));
}

describe("modelUrl download", () => {
	it("downloads .onnx + derived .json config, then serves from cache", async () => {
		const dir = tmpDir();
		const before = hits;
		const first = await ensureModelUrlDownloaded(
			`${baseUrl}/voice.onnx`,
			undefined,
			dir,
		);
		expect(fs.readFileSync(first.modelPath).equals(ONNX_BYTES)).toBe(true);
		expect(fs.readFileSync(first.configPath, "utf8")).toBe(CONFIG_TEXT);
		expect(hits - before).toBe(2);

		const cached = await ensureModelUrlDownloaded(
			`${baseUrl}/voice.onnx`,
			undefined,
			dir,
		);
		expect(cached).toEqual(first);
		expect(hits - before).toBe(2);
	});

	it("honors an explicit configUrl", async () => {
		const dir = tmpDir();
		const resolved = await ensureModelUrlDownloaded(
			`${baseUrl}/voice.onnx`,
			`${baseUrl}/other-config.json`,
			dir,
		);
		expect(fs.readFileSync(resolved.configPath, "utf8")).toBe(ALT_CONFIG_TEXT);
	});

	it("rejects non-http(s) URLs", async () => {
		await expect(
			ensureModelUrlDownloaded("ftp://example.com/m.onnx", undefined, tmpDir()),
		).rejects.toThrow("must use http(s)");
	});

	it("surfaces HTTP errors clearly", async () => {
		await expect(
			ensureModelUrlDownloaded(`${baseUrl}/missing.onnx`, undefined, tmpDir()),
		).rejects.toThrow("download failed (404)");
	});
});

describe("resolveModelFiles", () => {
	it("passes local modelPath through with default sibling config", async () => {
		const resolved = await resolveModelFiles({ modelPath: "./models/x.onnx" });
		expect(resolved.modelPath).toBe(path.resolve("./models/x.onnx"));
		expect(resolved.configPath).toBe(`${path.resolve("./models/x.onnx")}.json`);
	});

	it("resolves modelUrl end to end", async () => {
		const dir = tmpDir();
		const resolved = await resolveModelFiles({
			modelUrl: `${baseUrl}/voice.onnx`,
			modelsDir: dir,
		});
		expect(fs.existsSync(resolved.modelPath)).toBe(true);
		expect(fs.existsSync(resolved.configPath)).toBe(true);
	});

	it("local modelPath wins over modelUrl", async () => {
		const resolved = await resolveModelFiles({
			modelPath: "./models/x.onnx",
			modelUrl: `${baseUrl}/voice.onnx`,
		});
		expect(resolved.modelPath).toBe(path.resolve("./models/x.onnx"));
	});

	it("throws when no source is provided", async () => {
		await expect(resolveModelFiles({})).rejects.toThrow("provide modelPath");
	});

	it("resolveModelPathFromOptions accepts modelUrl", async () => {
		const dir = tmpDir();
		const modelPath = await resolveModelPathFromOptions({
			modelUrl: `${baseUrl}/voice.onnx`,
			modelsDir: dir,
		});
		expect(fs.existsSync(modelPath)).toBe(true);
		expect(fs.existsSync(`${modelPath}.json`)).toBe(true);
	});
});

describe("piperhub references (offline)", () => {
	it("parses slugs, prefixes, and page URLs", () => {
		expect(parsePiperHubSlug("hub:glados-french-medium-voice")).toBe(
			"glados-french-medium-voice",
		);
		expect(parsePiperHubSlug("piperhub:Siwis-French-FR-Medium")).toBe(
			"siwis-french-fr-medium",
		);
		expect(
			parsePiperHubSlug("https://piperhub.org/model/siwis-french-fr-medium/"),
		).toBe("siwis-french-fr-medium");
		expect(parsePiperHubSlug("en_US-lessac-medium")).toBeNull();
		expect(parsePiperHubSlug("")).toBeNull();
	});

	it("builds Hugging Face file URLs", () => {
		const entry = {
			slug: "siwis-french-fr-medium",
			name: "Siwis",
			repo: "rhasspy/piper-voices",
			onnx: "fr/fr_FR/siwis/medium/fr_FR-siwis-medium.onnx",
			json: "fr/fr_FR/siwis/medium/fr_FR-siwis-medium.onnx.json",
		};
		expect(piperHubFileUrl(entry, "onnx")).toBe(
			"https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR/siwis/medium/fr_FR-siwis-medium.onnx",
		);
		expect(
			piperHubFileUrl({ ...entry, onnx: "https://example.com/m.onnx" }, "onnx"),
		).toBe("https://example.com/m.onnx");
	});

	it("maps repos to mirror dirs", () => {
		expect(mirrorDirForRepo("simoniz0r/piper-voice-models")).toBe(
			"simoniz0r--piper-voice-models",
		);
	});

	it("selects mirror files despite the double .onnx extension", () => {
		const dir = "simoniz0r--piper-voice-models";
		const files = [
			`${dir}/en_US-bobby-medium.onnx.onnx`,
			`${dir}/en_US-bobby-medium.onnx.onnx.json`,
			`${dir}/en_US-carl-medium.onnx.onnx`,
			`${dir}/en_US-carl-medium.onnx.onnx.json`,
		];
		expect(selectMirrorFiles(files, dir, "en_US-carl-medium.onnx")).toEqual({
			onnx: `${dir}/en_US-carl-medium.onnx.onnx`,
			json: `${dir}/en_US-carl-medium.onnx.onnx.json`,
		});
	});

	it("selects mirror files with a plain single extension", () => {
		const dir = "owner--repo";
		const files = [`${dir}/voice-medium.onnx`, `${dir}/voice-medium.onnx.json`];
		expect(selectMirrorFiles(files, dir, "voice-medium.onnx")).toEqual({
			onnx: `${dir}/voice-medium.onnx`,
			json: `${dir}/voice-medium.onnx.json`,
		});
	});

	it("returns null when the mirror has no match", () => {
		expect(
			selectMirrorFiles(
				["owner--repo/other.onnx"],
				"owner--repo",
				"missing.onnx",
			),
		).toBeNull();
	});
});
