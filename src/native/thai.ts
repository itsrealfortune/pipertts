/**
 * Thai phonemizer (th branch).
 *
 * TypeScript port of piper1-gpl `src/piper/phonemize_thai.py`
 * (GPL-3.0-or-later). Normalization, numbers, sentences, and transcription
 * parsing are pure TS; the `th2ipa` engine itself (TLTK, BSD-3-Clause,
 * Chulalongkorn University) runs unmodified under Pyodide (WASM, offline
 * after install) — a pure-TS port of its trigram segmenter would not
 * reach parity.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_PHONEME_ID_MAP } from "./phoneme-ids.js";

/** Tone digits 1=mid, 2=low, 3=falling, 4=high, 5=rising. */
export const THAI_TONES = new Set("12345");

const THAI_TLTK_TO_IPA: Record<string, string> = { ᴐ: "ɔ" };
const THAI_CHUNK_MARKER = "<s/>";
const THAI_RUN = /[ก-ฮะ-ฺเ-๎]+/gu;
const THAI_ET_CETERA: [string, string] = ["ฯลฯ", "ละ"];
const THAI_SILENT = /[ฯ๏๚๛​﻿]|‌|‍/gu;
const THAI_OBSOLETE = new Map([
	["ฃ", "ข"],
	["ฅ", "ค"],
]);
const THAI_DIGITS = new Map([..."๐๑๒๓๔๕๖๗๘๙"].map((d, i) => [d, String(i)]));
const THAI_SARA_AM = /ํ([่-๋]?)า/gu;
const THAI_GROUPED_NUMBER = /(?<=\d),(?=\d{3}(?![\p{L}\p{N}_]))/gu;
const THAI_NUMBER = /(?<![\p{L}\p{N}_])-?\d+(?:\.\d+)?/gu;
const THAI_BAHT = /฿\s*(-?[\d.]+)/gu;
const THAI_PERCENT = /(-?[\d.]+)\s*%/gu;
const THAI_PUNCTUATION = new Set(".,?!:;-");
const THAI_SENTENCE_SPLIT = /(?<=[.?!])\s+|\n+/gu;
const THAI_WORD_BREAK = " ";

// ---------- Thai numerals (mirrors RbnfEngine th) ----------

const THAI_DIGIT_WORDS = [
	"ศูนย์",
	"หนึ่ง",
	"สอง",
	"สาม",
	"สี่",
	"ห้า",
	"หก",
	"เจ็ด",
	"แปด",
	"เก้า",
];

function thBelowMillion(num: number): string[] {
	// 1 <= num < 1000000
	const words: string[] = [];
	const units: [number, string][] = [
		[100000, "แสน"],
		[10000, "หมื่น"],
		[1000, "พัน"],
		[100, "ร้อย"],
	];
	let rest = num;
	for (const [value, word] of units) {
		const d = Math.floor(rest / value);
		rest %= value;
		if (d === 0) {
			continue;
		}
		words.push(d === 1 ? "หนึ่ง" : (THAI_DIGIT_WORDS[d] as string), word);
	}
	const tens = Math.floor(rest / 10);
	const ones = rest % 10;
	if (tens === 1) {
		words.push("สิบ");
	} else if (tens === 2) {
		words.push("ยี่", "สิบ");
	} else if (tens >= 3) {
		words.push(THAI_DIGIT_WORDS[tens] as string, "สิบ");
	}
	if (ones === 1) {
		words.push(tens > 0 ? "เอ็ด" : "หนึ่ง");
	} else if (ones > 1) {
		words.push(THAI_DIGIT_WORDS[ones] as string);
	}
	return words;
}

function thHigh(num: number): string[] {
	// num >= 1: recursive millions (ล้าน per level)
	if (num < 1000000) {
		return thBelowMillion(num);
	}
	const high = Math.floor(num / 1000000);
	const rest = num % 1000000;
	return [...thHigh(high), "ล้าน", ...(rest > 0 ? thBelowMillion(rest) : [])];
}

/** Verbalizes a decimal/negative number like RbnfEngine th. */
export function thNumberToWords(text: string): string {
	let negative = false;
	let t = text;
	if (t.startsWith("-")) {
		negative = true;
		t = t.slice(1);
	}
	const [intPart, fracPart] = t.split(".");
	const intNum = parseInt(intPart || "0", 10);
	const words: string[] = [...(intNum === 0 ? ["ศูนย์"] : thHigh(intNum))];
	if (fracPart !== undefined && fracPart.length > 0) {
		words.push(
			"จุด",
			[...fracPart]
				.map((d) => THAI_DIGIT_WORDS[parseInt(d, 10)] as string)
				.join(""),
		);
	}
	return [...(negative ? ["ลบ"] : []), ...words].join(" ");
}

/** Mirrors ThaiPhonemizer._numbers_to_words (baht, percent, grouped, plain). */
export function thNumbersToWords(text: string): string {
	let out = text.replace(THAI_GROUPED_NUMBER, "");
	out = out.replace(THAI_BAHT, (_m, num: string) => `${num} บาท`);
	out = out.replace(THAI_PERCENT, (_m, num: string) => `${num} เปอร์เซ็นต์`);
	out = out.replace(THAI_NUMBER, (m) => thNumberToWords(m));
	// Our verbalizer emits spaces directly (no zero-width spaces).
	return out;
}

// ---------- Pyodide TLTK bridge ----------

const TLTK_PYPI_JSON = "https://pypi.org/pypi/tltk/json";
const TLTK_DATA_FILES = [
	"th2ipa.py",
	"sylrule.lts",
	"thaisyl.dict",
	"sylseg.3g",
	"thdict",
	"PhSTrigram.sts",
];
const TLTK_SYLVAR_PICK = Buffer.from(
	"800263636f6c6c656374696f6e730a64656661756c74646963740a7100635f5f6275696c74696e5f5f0a6c6973740a71018571025271032e",
	"hex",
);

function runTar(args: string[], cwd: string): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile(
			"tar",
			args,
			{ cwd, timeout: 300_000 },
			(error, _stdout, stderr) => {
				if (error) {
					reject(
						new Error(
							`PiperNative: tar failed: ${String(stderr || error.message).trim()}`,
						),
					);
					return;
				}
				resolve();
			},
		);
	});
}

async function fetchToFile(url: string, destPath: string): Promise<void> {
	const response = await fetch(url);
	if (!response.ok || !response.body) {
		throw new Error(
			`PiperNative: download failed (${response.status}) for ${url}`,
		);
	}
	const { Readable } = await import("node:stream");
	const { pipeline } = await import("node:stream/promises");
	const dir = path.dirname(destPath);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	const tmpPath = `${destPath}.part-${process.pid}-${Date.now()}`;
	try {
		await pipeline(
			Readable.fromWeb(
				response.body as import("node:stream/web").ReadableStream,
			),
			fs.createWriteStream(tmpPath),
		);
		fs.renameSync(tmpPath, destPath);
	} catch (error) {
		try {
			if (fs.existsSync(tmpPath)) {
				fs.unlinkSync(tmpPath);
			}
		} catch {
			// best effort
		}
		throw error;
	}
}

/** Ensures TLTK data files for the pyodide sidecar. Returns the data dir. */
export async function ensureTltkDataDir(dataDir: string): Promise<string> {
	const missing = TLTK_DATA_FILES.filter(
		(f) => !fs.existsSync(path.join(dataDir, f)),
	);
	if (
		missing.length === 0 &&
		fs.existsSync(path.join(dataDir, "sylform_var.pick"))
	) {
		return dataDir;
	}
	if (!fs.existsSync(dataDir)) {
		fs.mkdirSync(dataDir, { recursive: true });
	}
	const meta = (await (await fetch(TLTK_PYPI_JSON)).json()) as {
		urls: { packagetype: string; url: string }[];
	};
	const sdist = meta.urls.find((u) => u.packagetype === "sdist");
	if (!sdist) {
		throw new Error("PiperNative: no TLTK sdist found on PyPI.");
	}
	const tarPath = path.join(dataDir, "tltk.tar.gz");
	await fetchToFile(sdist.url, tarPath);
	await runTar(["xzf", tarPath, "-C", dataDir], dataDir);
	try {
		fs.unlinkSync(tarPath);
	} catch {
		// best effort
	}
	// Locate th2ipa.py + data (sdist layout: tltk-<ver>/tltk/<file>).
	const { execSync } = await import("node:child_process");
	const found = execSync(`find ${JSON.stringify(dataDir)} -name th2ipa.py`, {
		encoding: "utf8",
	})
		.trim()
		.split("\n")[0] as string;
	if (!found) {
		throw new Error("PiperNative: th2ipa.py not found in TLTK sdist.");
	}
	const srcDir = path.dirname(found);
	for (const f of TLTK_DATA_FILES) {
		const src = path.join(srcDir, f);
		const dest = path.join(dataDir, f);
		if (src !== dest && fs.existsSync(src)) {
			fs.copyFileSync(src, dest);
		}
	}
	fs.writeFileSync(path.join(dataDir, "sylform_var.pick"), TLTK_SYLVAR_PICK);
	return dataDir;
}

interface PyodideHandle {
	runPython(code: string): unknown;
	FS: {
		mkdirTree(dir: string): void;
		writeFile(path: string, data: Uint8Array): void;
	};
}

let pyodideInstance: {
	py: PyodideHandle;
	transcribe: (run: string) => string;
} | null = null;

/**
 * Lazily boots Pyodide (offline, from the npm package) with real TLTK.
 * First call costs a few seconds (runtime + 15MB trigram load); later
 * calls are sub-second.
 */
export async function getTh2ipa(
	dataDir?: string,
): Promise<(run: string) => string> {
	if (pyodideInstance) {
		return pyodideInstance.transcribe;
	}
	const { loadPyodide } = (await import("pyodide")) as {
		loadPyodide: (options?: Record<string, unknown>) => Promise<PyodideHandle>;
	};
	const py = await loadPyodide();
	const dir = dataDir ?? path.resolve("piper-data", "tltk");
	await ensureTltkDataDir(dir);
	const remote = "/thaidata";
	py.FS.mkdirTree(remote);
	for (const f of [...TLTK_DATA_FILES, "sylform_var.pick"]) {
		py.FS.writeFile(`${remote}/${f}`, fs.readFileSync(path.join(dir, f)));
	}
	py.FS.writeFile(`${remote}/__init__.py`, new Uint8Array(0));
	py.runPython(`import sys; sys.path.insert(0, "${remote}")`);
	py.runPython("import th2ipa");
	const transcribe = (run: string): string =>
		py.runPython(`th2ipa.th2ipa(${JSON.stringify(run)})`) as string;
	pyodideInstance = { py, transcribe };
	return transcribe;
}

// ---------- ThaiPhonemizer ----------

export interface ThaiPhonemizerOptions {
	expandNumbers?: boolean;
	transcribe?: (run: string) => Promise<string> | string;
	dataDir?: string;
}

/**
 * Thai phonemizer: pure-TS normalization/numbers/parsing + real TLTK
 * `th2ipa` under Pyodide. Port of `ThaiPhonemizer` (GPL-3.0-or-later).
 */
export class ThaiPhonemizer {
	private readonly expandNumbers: boolean;
	private readonly transcribe: (run: string) => Promise<string> | string;
	private readonly dataDir?: string;

	constructor(options: ThaiPhonemizerOptions = {}) {
		this.expandNumbers = options.expandNumbers ?? true;
		this.dataDir = options.dataDir;
		if (options.transcribe) {
			this.transcribe = options.transcribe;
		} else {
			this.transcribe = async (run: string) =>
				(await getTh2ipa(this.dataDir))(run);
		}
	}

	/** IPA phonemes with tone digits, grouped by sentence. */
	async phonemize(text: string): Promise<string[][]> {
		const allPhonemes: string[][] = [];
		for (const sentence of text.split(THAI_SENTENCE_SPLIT)) {
			const sentencePhonemes = await this.phonemizeSentence(sentence);
			if (sentencePhonemes.length > 0) {
				allPhonemes.push(sentencePhonemes);
			}
		}
		return allPhonemes;
	}

	private async phonemizeSentence(sentence: string): Promise<string[]> {
		const normalized = this.normalize(sentence);
		const phonemes: string[] = [];
		let position = 0;
		for (const match of normalized.matchAll(THAI_RUN)) {
			const index = match.index ?? 0;
			phonemes.push(...punctuationPhonemes(normalized.slice(position, index)));
			phonemes.push(...(await this.phonemizeRun(match[0])));
			position = index + match[0].length;
		}
		phonemes.push(...punctuationPhonemes(normalized.slice(position)));
		while (phonemes.length > 0 && phonemes[0] === THAI_WORD_BREAK) {
			phonemes.shift();
		}
		while (
			phonemes.length > 0 &&
			phonemes[phonemes.length - 1] === THAI_WORD_BREAK
		) {
			phonemes.pop();
		}
		return phonemes;
	}

	private async phonemizeRun(run: string): Promise<string[]> {
		let transcription: string;
		try {
			transcription = await this.transcribe(run);
		} catch {
			return [];
		}
		const phonemes: string[] = [];
		for (const word of transcription
			.replaceAll(THAI_CHUNK_MARKER, " ")
			.split(/\s+/)
			.filter(Boolean)) {
			const wordPhonemes: string[] = [];
			for (const syllable of word.split(/[.+]/)) {
				wordPhonemes.push(...this.syllablePhonemes(syllable));
			}
			if (wordPhonemes.length > 0) {
				if (phonemes.length > 0) {
					phonemes.push(THAI_WORD_BREAK);
				}
				phonemes.push(...wordPhonemes);
			}
		}
		return phonemes;
	}

	private syllablePhonemes(syllable: string): string[] {
		if (!syllable) {
			return [];
		}
		let tone: string | null = null;
		let syl = syllable;
		const last = syl[syl.length - 1] as string;
		if (THAI_TONES.has(last)) {
			syl = syl.slice(0, -1);
			tone = last;
		}
		const phonemes: string[] = [];
		for (const rawChar of syl) {
			const char = THAI_TLTK_TO_IPA[rawChar] ?? rawChar;
			if (!(char in DEFAULT_PHONEME_ID_MAP)) {
				// OOV echo from TLTK: drop the whole syllable.
				return [];
			}
			phonemes.push(char);
		}
		if (phonemes.length === 0) {
			return [];
		}
		if (tone !== null) {
			phonemes.push(tone);
		}
		return phonemes;
	}

	private normalize(text: string): string {
		let out = text.normalize("NFC");
		out = [...out]
			.map((c) => THAI_DIGITS.get(c) ?? THAI_OBSOLETE.get(c) ?? c)
			.join("");
		out = out.replace(THAI_SARA_AM, "$1ำ");
		out = out.split(THAI_ET_CETERA[0]).join(THAI_ET_CETERA[1]);
		if (this.expandNumbers) {
			out = thNumbersToWords(out);
		}
		return out.replace(THAI_SILENT, "");
	}
}

function punctuationPhonemes(text: string): string[] {
	const phonemes: string[] = [];
	for (const char of text) {
		if (THAI_PUNCTUATION.has(char)) {
			phonemes.push(char);
			continue;
		}
		if (/[\p{L}\p{N}]/u.test(char)) {
			// Latin words, leftover digits: dropped with a single break.
		}
		if (
			phonemes.length === 0 ||
			phonemes[phonemes.length - 1] !== THAI_WORD_BREAK
		) {
			phonemes.push(THAI_WORD_BREAK);
		}
	}
	return phonemes;
}
