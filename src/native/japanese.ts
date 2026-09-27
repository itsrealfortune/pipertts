/**
 * Japanese phonemizer (ja branch).
 *
 * Segmentation + readings via lindera-wasm + UniDic (WASM, offline after
 * install); katakana → morae engine, phone → IPA map, and sentence splitter
 * ported from piper1-gpl `src/piper/phonemize_japanese.py` (GPL-3.0-or-later).
 *
 * Known gap vs OpenJTalk: no lexical pitch accent (UniDic ships no accent
 * nucleus data), so ↑/↓/# are not emitted. Segments, mora timing, particles,
 * and geminates match; output stays flat but intelligible — espeak-ng cannot
 * read kanji at all.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ---------- Prosody / phones (ported tables) ----------

export const JA_ACCENT_RISE = "↑";
export const JA_ACCENT_FALL = "↓";
export const JA_PHRASE_BOUNDARY = "#";
export const JA_PAUSE = ",";
export const JA_DECLARATIVE_END = ".";
export const JA_INTERROGATIVE_END = "?";

const JA_SENTENCE_END = /[。．！？!?]+[」』）】〉》”’"')\]\s]*/gu;

function jaIsDecimalPoint(
	text: string,
	start: number,
	end: number,
	match: string,
): boolean {
	if (match !== ".") {
		return false;
	}
	const before = start > 0 ? (text[start - 1] as string) : "";
	const after = end < text.length ? (text[end] as string) : "";
	return /\d/.test(before) && /\d/.test(after);
}

/** Splits sentences, keeping final punctuation (port of _split_sentences). */
export function splitJaSentences(text: string): string[] {
	const sentences: string[] = [];
	let start = 0;
	JA_SENTENCE_END.lastIndex = 0;
	let match: RegExpExecArray | null;
	const re = new RegExp(JA_SENTENCE_END.source, JA_SENTENCE_END.flags);
	for (match = re.exec(text); match !== null; match = re.exec(text)) {
		// Lone "." between digits is a decimal point, not a boundary.
		if (
			match[0] === "." &&
			jaIsDecimalPoint(text, match.index, match.index + 1, ".")
		) {
			continue;
		}
		const sentence = text.slice(start, match.index + match[0].length).trim();
		if (sentence) {
			sentences.push(sentence);
		}
		start = match.index + match[0].length;
		if (match[0].length === 0) {
			break;
		}
	}
	const tail = text.slice(start).trim();
	if (tail) {
		sentences.push(tail);
	}
	return sentences;
}

// ---------- Katakana → morae ----------

export interface JaMora {
	/** IPA onset ("" for vowel-only morae). */
	onset: string;
	/** IPA vowel, "ʔ" (geminate), or "ɴ" (moraic nasal). */
	nucleus: string;
}

const JA_VOWELS: Record<string, string> = {
	ア: "a",
	イ: "i",
	ウ: "ɯ",
	エ: "e",
	オ: "o",
	ァ: "a",
	ィ: "i",
	ゥ: "ɯ",
	ェ: "e",
	ォ: "o",
};

const JA_BASE: Record<string, [string, string]> = {
	ア: ["", "a"],
	イ: ["", "i"],
	ウ: ["", "ɯ"],
	エ: ["", "e"],
	オ: ["", "o"],
	カ: ["k", "a"],
	キ: ["k", "i"],
	ク: ["k", "ɯ"],
	ケ: ["k", "e"],
	コ: ["k", "o"],
	サ: ["s", "a"],
	シ: ["ɕ", "i"],
	ス: ["s", "ɯ"],
	セ: ["s", "e"],
	ソ: ["s", "o"],
	タ: ["t", "a"],
	チ: ["tɕ", "i"],
	ツ: ["ts", "ɯ"],
	テ: ["t", "e"],
	ト: ["t", "o"],
	ナ: ["n", "a"],
	ニ: ["n", "i"],
	ヌ: ["n", "ɯ"],
	ネ: ["n", "e"],
	ノ: ["n", "o"],
	ハ: ["h", "a"],
	ヒ: ["hʲ", "i"],
	フ: ["ɸ", "ɯ"],
	ヘ: ["h", "e"],
	ホ: ["h", "o"],
	マ: ["m", "a"],
	ミ: ["m", "i"],
	ム: ["m", "ɯ"],
	メ: ["m", "e"],
	モ: ["m", "o"],
	ヤ: ["j", "a"],
	ユ: ["j", "ɯ"],
	ヨ: ["j", "o"],
	ラ: ["ɾ", "a"],
	リ: ["ɾ", "i"],
	ル: ["ɾ", "ɯ"],
	レ: ["ɾ", "e"],
	ロ: ["ɾ", "o"],
	ワ: ["w", "a"],
	ヰ: ["w", "i"],
	ヱ: ["w", "e"],
	ヲ: ["w", "o"],
	ガ: ["ɡ", "a"],
	ギ: ["ɡ", "i"],
	グ: ["ɡ", "ɯ"],
	ゲ: ["ɡ", "e"],
	ゴ: ["ɡ", "o"],
	ザ: ["z", "a"],
	ジ: ["dʑ", "i"],
	ズ: ["z", "ɯ"],
	ゼ: ["z", "e"],
	ゾ: ["z", "o"],
	ダ: ["d", "a"],
	ヂ: ["dʑ", "i"],
	ヅ: ["z", "ɯ"],
	デ: ["d", "e"],
	ド: ["d", "o"],
	バ: ["b", "a"],
	ビ: ["b", "i"],
	ブ: ["b", "ɯ"],
	ベ: ["b", "e"],
	ボ: ["b", "o"],
	パ: ["p", "a"],
	ピ: ["p", "i"],
	プ: ["p", "ɯ"],
	ペ: ["p", "e"],
	ポ: ["p", "o"],
	ヴ: ["v", "ɯ"],
	ヶ: ["k", "e"],
	ヵ: ["k", "a"],
};

// (base kana, small kana) → [onset IPA, vowel]. Covers productive combos.
const JA_COMBOS: Record<string, [string, string]> = {
	キャ: ["kʲ", "a"],
	キュ: ["kʲ", "ɯ"],
	キョ: ["kʲ", "o"],
	シャ: ["ɕ", "a"],
	シュ: ["ɕ", "ɯ"],
	ショ: ["ɕ", "o"],
	シェ: ["ɕ", "e"],
	チャ: ["tɕ", "a"],
	チュ: ["tɕ", "ɯ"],
	チョ: ["tɕ", "o"],
	チェ: ["tɕ", "e"],
	ニャ: ["nʲ", "a"],
	ニュ: ["nʲ", "ɯ"],
	ニョ: ["nʲ", "o"],
	ヒャ: ["hʲ", "a"],
	ヒュ: ["hʲ", "ɯ"],
	ヒョ: ["hʲ", "o"],
	ミャ: ["mʲ", "a"],
	ミュ: ["mʲ", "ɯ"],
	ミョ: ["mʲ", "o"],
	リャ: ["ɾʲ", "a"],
	リュ: ["ɾʲ", "ɯ"],
	リョ: ["ɾʲ", "o"],
	ギャ: ["ɡʲ", "a"],
	ギュ: ["ɡʲ", "ɯ"],
	ギョ: ["ɡʲ", "o"],
	ジャ: ["dʑ", "a"],
	ジュ: ["dʑ", "ɯ"],
	ジョ: ["dʑ", "o"],
	ジェ: ["dʑ", "e"],
	ビャ: ["bʲ", "a"],
	ビュ: ["bʲ", "ɯ"],
	ビョ: ["bʲ", "o"],
	ピャ: ["pʲ", "a"],
	ピュ: ["pʲ", "ɯ"],
	ピョ: ["pʲ", "o"],
	ヂャ: ["dʑ", "a"],
	ヂュ: ["dʑ", "ɯ"],
	ヂョ: ["dʑ", "o"],
	テャ: ["tʲ", "a"],
	ティ: ["tʲ", "i"],
	トゥ: ["tʲ", "ɯ"],
	ディ: ["dʲ", "i"],
	ドゥ: ["dʲ", "ɯ"],
	ファ: ["ɸ", "a"],
	フィ: ["ɸ", "i"],
	フェ: ["ɸ", "e"],
	フォ: ["ɸ", "o"],
	フュ: ["ɸ", "ɯ"],
	ウィ: ["w", "i"],
	ウェ: ["w", "e"],
	ウォ: ["w", "o"],
	ヴァ: ["v", "a"],
	ヴィ: ["v", "i"],
	ヴェ: ["v", "e"],
	ヴォ: ["v", "o"],
	ヴャ: ["vʲ", "a"],
	ヴュ: ["vʲ", "ɯ"],
	ヴョ: ["vʲ", "o"],
	イェ: ["j", "e"],
	ウァ: ["w", "a"],
	クァ: ["k", "a"],
	クィ: ["k", "i"],
	クェ: ["k", "e"],
	クォ: ["k", "o"],
	クヮ: ["kʷ", "a"],
	グヮ: ["ɡʷ", "a"],
	スィ: ["s", "i"],
	ズィ: ["z", "i"],
	ツィ: ["ts", "i"],
};

const JA_SMALL = new Set("ァィゥェォャュョ");

/**
 * Converts a katakana reading to morae. Long vowels stay two morae and
 * geminates/nasals keep mora timing for the duration predictor.
 */
export function katakanaToMorae(reading: string): JaMora[] {
	const morae: JaMora[] = [];
	const chars = [...reading];
	let i = 0;
	while (i < chars.length) {
		const ch = chars[i] as string;
		const next = chars[i + 1];
		if (ch === "ッ") {
			morae.push({ onset: "", nucleus: "ʔ" });
			i += 1;
			continue;
		}
		if (ch === "ン") {
			morae.push({ onset: "", nucleus: "ɴ" });
			i += 1;
			continue;
		}
		if (ch === "ー") {
			const prev = morae[morae.length - 1];
			if (prev && "aiɯeo".includes(prev.nucleus)) {
				morae.push({ onset: "", nucleus: prev.nucleus });
			}
			i += 1;
			continue;
		}
		if (ch === "ヽ" || ch === "ヾ") {
			const prev = morae[morae.length - 1];
			if (prev) {
				morae.push({ ...prev });
			}
			i += 1;
			continue;
		}
		if (next && JA_SMALL.has(next)) {
			const combo = JA_COMBOS[ch + next];
			if (combo) {
				morae.push({ onset: combo[0], nucleus: combo[1] });
			} else {
				const base = JA_BASE[ch];
				const vowel = JA_VOWELS[next] ?? "";
				if (base && vowel) {
					morae.push({ onset: base[0], nucleus: vowel });
				} else if (base) {
					morae.push({ onset: base[0], nucleus: base[1] });
					i += 1;
					continue;
				} else {
					i += 1;
					continue;
				}
			}
			i += 2;
			continue;
		}
		const base = JA_BASE[ch];
		if (base) {
			morae.push({ onset: base[0], nucleus: base[1] });
		}
		// Unknown kana (ぇ standalone etc.): skipped like missing phones.
		i += 1;
	}
	return morae;
}

/** Morae to single-codepoint phonemes (long vowels = two phonemes). */
export function moraeToPhonemes(morae: JaMora[]): string[] {
	const out: string[] = [];
	for (const m of morae) {
		if (m.nucleus === "ʔ" || m.nucleus === "ɴ") {
			out.push(m.nucleus);
			continue;
		}
		if (m.onset) {
			out.push(...[...m.onset]);
		}
		out.push(m.nucleus);
	}
	return out;
}

// ---------- Japanese numerals (Sino-Japanese readings) ----------

const JA_DIGIT = [
	"ゼロ",
	"イチ",
	"ニ",
	"サン",
	"シ",
	"ゴ",
	"ロク",
	"シチ",
	"ハチ",
	"キュウ",
];
const JA_FULLWIDTH_DIGITS = new Map(
	[..."０１２３４５６７８９"].map((d, i) => [d, String(i)]),
);

function jaBelowMan(n: number): string[] {
	// 1 <= n < 10000. Rendaku: さんびゃく/ろっぴゃく/はっぴゃく, さんぜん/はっせん.
	const out: string[] = [];
	const hundreds = Math.floor(n / 100);
	const rest100 = n % 100;
	if (hundreds > 0) {
		if (hundreds === 3) {
			out.push("サン", "ビャク");
		} else if (hundreds === 6) {
			out.push("ロッ", "ピャク");
		} else if (hundreds === 8) {
			out.push("ハッ", "ピャク");
		} else {
			if (hundreds > 1) {
				out.push(JA_DIGIT[hundreds] as string);
			}
			out.push("ヒャク");
		}
	}
	const tens = Math.floor(rest100 / 10);
	const ones = rest100 % 10;
	if (tens === 1) {
		out.push("ジュウ");
	} else if (tens > 1) {
		out.push(JA_DIGIT[tens] as string, "ジュウ");
	}
	if (ones > 0) {
		out.push(JA_DIGIT[ones] as string);
	}
	return out;
}

function jaThousands(n: number): string[] {
	// 1 <= n < 10000 with 千 unit + rendaku.
	if (n < 1000) {
		return jaBelowMan(n);
	}
	const th = Math.floor(n / 1000);
	const rest = n % 1000;
	const out: string[] = [];
	if (th === 3) {
		out.push("サン", "ゼン");
	} else if (th === 8) {
		out.push("ハッ", "セン");
	} else {
		if (th > 1) {
			out.push(JA_DIGIT[th] as string);
		}
		out.push("セン");
	}
	if (rest > 0) {
		out.push(...jaBelowMan(rest));
	}
	return out;
}

function jaIntegerKatakana(n: number): string {
	if (n === 0) {
		return "ゼロ";
	}
	const units: [number, string][] = [
		[1e12, "チョウ"],
		[1e8, "オク"],
		[10000, "マン"],
	];
	let out = "";
	let rest = n;
	for (const [value, word] of units) {
		if (rest >= value) {
			const part = Math.floor(rest / value);
			rest %= value;
			out += jaThousands(part).join("") + word;
		}
	}
	if (rest > 0 || out === "") {
		out += jaThousands(rest).join("");
	}
	return out;
}

/** Digits (half/full width) → katakana reading. Minus → マイナス, dot → テン. */
export function jaNumberToKatakana(text: string): string {
	let t = [...text].map((c) => JA_FULLWIDTH_DIGITS.get(c) ?? c).join("");
	let negative = false;
	if (t.startsWith("-") || t.startsWith("−")) {
		negative = true;
		t = t.slice(1);
	}
	const [intPart, fracPart] = t.split(".");
	let out = jaIntegerKatakana(parseInt(intPart || "0", 10));
	if (fracPart !== undefined && fracPart.length > 0) {
		out +=
			"テン" +
			[...fracPart].map((d) => JA_DIGIT[parseInt(d, 10)] as string).join("");
	}
	return (negative ? "マイナス" : "") + out;
}

const JA_NUMBER_RUN = /[+\-−]?[0-9０-９]+(?:[.,．][0-9０-９]+)?/gu;

/** Expands digit runs in running text (OpenJTalk normalizes first too). */
export function jaExpandNumbers(text: string): string {
	return text.replace(JA_NUMBER_RUN, (m) => {
		if (/^[+]$/.test(m)) {
			return m;
		}
		// Keep thousand-separator commas: 1,000 → strip comma, read as number.
		const cleaned = m.replace(/[,，．]/g, (c) =>
			c === "." || c === "．" ? "." : "",
		);
		if (/^\d+$/.test(cleaned.replace(".", "")) === false) {
			return m;
		}
		return jaNumberToKatakana(cleaned);
	});
}

// ---------- lindera-wasm bridge ----------

/** UniDic token: katakana pronunciation drives the morae engine. */
export interface JaToken {
	surface: string;
	/** UniDic pronunciation (katakana) or "" when absent. */
	pronunciation: string;
	reading: string;
	pos1: string;
	isUnknown: boolean;
}

const LINDERA_RELEASE =
	"https://github.com/lindera/lindera/releases/download/v6.2.0/lindera-unidic-6.2.0.zip";
const LINDERA_FILES = [
	"metadata.json",
	"dict.trie",
	"dict.valsidx",
	"dict.vals",
	"dict.wordsidx",
	"dict.words",
	"matrix.mtx",
	"char_def.bin",
	"unk.bin",
];

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

/** Ensures the lindera UniDic directory (zip download + extract). */
export async function ensureLinderaUnidicDir(dataDir: string): Promise<string> {
	const missing = LINDERA_FILES.filter(
		(f) => !fs.existsSync(path.join(dataDir, f)),
	);
	if (missing.length === 0) {
		return dataDir;
	}
	if (!fs.existsSync(dataDir)) {
		fs.mkdirSync(dataDir, { recursive: true });
	}
	const zipPath = path.join(dataDir, "lindera-unidic.zip");
	await fetchToFile(LINDERA_RELEASE, zipPath);
	const { execFile } = await import("node:child_process");
	await new Promise<void>((resolve, reject) => {
		execFile(
			"unzip",
			["-o", "-q", zipPath, "-d", dataDir],
			(error, _stdout, stderr) => {
				if (error) {
					reject(
						new Error(
							`PiperNative: unzip failed: ${String(stderr || error.message).trim()}`,
						),
					);
					return;
				}
				resolve();
			},
		);
	});
	// Release layout nests files under lindera-unidic/; hoist them.
	const nested = path.join(dataDir, "lindera-unidic");
	if (fs.existsSync(nested)) {
		for (const f of LINDERA_FILES) {
			const src = path.join(nested, f);
			if (fs.existsSync(src)) {
				fs.renameSync(src, path.join(dataDir, f));
			}
		}
		try {
			fs.rmSync(nested, { recursive: true, force: true });
		} catch {
			// best effort
		}
	}
	try {
		fs.unlinkSync(zipPath);
	} catch {
		// best effort
	}
	const stillMissing = LINDERA_FILES.filter(
		(f) => !fs.existsSync(path.join(dataDir, f)),
	);
	if (stillMissing.length > 0) {
		throw new Error(
			`PiperNative: UniDic incomplete, missing: ${stillMissing.join(", ")}`,
		);
	}
	return dataDir;
}

interface LinderaWasm {
	default: (input?: unknown) => Promise<unknown>;
	TokenizerBuilder: new () => {
		setDictionaryInstance(d: unknown): void;
		setMode(m: string): void;
		build(): {
			tokenize(text: string): {
				surface: string;
				isUnknown: boolean;
				details: string[];
			}[];
		};
	};
	loadDictionaryFromBytes: (...files: Uint8Array[]) => unknown;
}

let linderaCache: {
	tokenize: (text: string) => JaToken[];
} | null = null;

/** Lazily boots lindera-wasm + UniDic (offline after npm install + data). */
export async function getLinderaTokenizer(
	dataDir?: string,
): Promise<(text: string) => JaToken[]> {
	if (linderaCache) {
		return linderaCache.tokenize;
	}
	const wasm = (await import("lindera-wasm")) as unknown as LinderaWasm;
	const { createRequire } = await import("node:module");
	const require = createRequire(import.meta.url);
	const pkgMain = require.resolve("lindera-wasm");
	const wasmPath = path.join(path.dirname(pkgMain), "lindera_wasm_bg.wasm");
	await wasm.default(fs.readFileSync(wasmPath));
	const dir = dataDir ?? path.resolve("piper-data", "unidic");
	await ensureLinderaUnidicDir(dir);
	const R = (f: string): Uint8Array =>
		new Uint8Array(fs.readFileSync(path.join(dir, f)));
	const dict = wasm.loadDictionaryFromBytes(
		R("metadata.json"),
		R("dict.trie"),
		R("dict.valsidx"),
		R("dict.vals"),
		R("dict.wordsidx"),
		R("dict.words"),
		R("matrix.mtx"),
		R("char_def.bin"),
		R("unk.bin"),
	);
	const builder = new wasm.TokenizerBuilder();
	builder.setDictionaryInstance(dict);
	builder.setMode("normal");
	const tokenizer = builder.build();
	const tokenize = (text: string): JaToken[] =>
		tokenizer.tokenize(text).map((t) => ({
			surface: t.surface,
			pronunciation:
				t.details[9] && t.details[9] !== "*" ? (t.details[9] as string) : "",
			reading:
				t.details[6] && t.details[6] !== "*" ? (t.details[6] as string) : "",
			pos1: (t.details[0] as string) ?? "",
			isUnknown: t.isUnknown,
		}));
	linderaCache = { tokenize };
	return tokenize;
}

// ---------- JapanesePhonemizer ----------

export interface JapanesePhonemizerOptions {
	unidicDir?: string;
	tokenize?: (text: string) => Promise<JaToken[]> | JaToken[];
}

const JA_KATAKANA_RUN = /[ァ-ヶー]+/u;

/**
 * Japanese phonemizer: lindera segmentation + katakana morae engine.
 * No lexical pitch accent (UniDic ships no accent data) — see module doc.
 */
export class JapanesePhonemizer {
	private readonly tokenize: (text: string) => Promise<JaToken[]> | JaToken[];
	private readonly unidicDir?: string;

	constructor(options: JapanesePhonemizerOptions = {}) {
		this.unidicDir = options.unidicDir;
		if (options.tokenize) {
			this.tokenize = options.tokenize;
		} else {
			this.tokenize = async (text: string) =>
				(await getLinderaTokenizer(this.unidicDir))(text);
		}
	}

	async phonemize(text: string): Promise<string[][]> {
		const allPhonemes: string[][] = [];
		for (const sentence of splitJaSentences(text)) {
			const phones = await this.phonemizeSentence(sentence);
			if (phones.length > 0) {
				allPhonemes.push(phones);
			}
		}
		return allPhonemes;
	}

	private async phonemizeSentence(sentence: string): Promise<string[]> {
		const expanded = jaExpandNumbers(sentence);
		const tokens = await this.tokenize(expanded);
		const phonemes: string[] = [];
		for (const token of tokens) {
			phonemes.push(...this.tokenPhonemes(token));
		}
		// Sentence-final intonation: ? iff trailing ?/？/!/！ or か-question.
		const trimmed = sentence.trim();
		const interrogative =
			/[?？!！]$/.test(trimmed) || /か[。．\s]*$/.test(trimmed);
		// Drop trailing pause if present (it becomes the end mark instead).
		while (phonemes.length > 0 && phonemes[phonemes.length - 1] === JA_PAUSE) {
			phonemes.pop();
		}
		if (phonemes.length > 0) {
			phonemes.push(interrogative ? JA_INTERROGATIVE_END : JA_DECLARATIVE_END);
		}
		return phonemes;
	}

	private tokenPhonemes(token: JaToken): string[] {
		const surface = token.surface;
		if (/^[、，,]$/.test(surface)) {
			return [JA_PAUSE];
		}
		if (/^[。．！？!?]$/.test(surface)) {
			return [];
		}
		if (/^\s+$/.test(surface)) {
			return [];
		}
		const reading = token.pronunciation || token.reading;
		if (!reading) {
			if (token.isUnknown && JA_KATAKANA_RUN.test(surface)) {
				return moraeToPhonemes(katakanaToMorae(surface));
			}
			// Unknown kanji/emoji: skipped like missing OpenJTalk phones.
			return [];
		}
		return moraeToPhonemes(katakanaToMorae(reading));
	}
}
