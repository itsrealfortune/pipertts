/**
 * Chinese (pinyin) phonemizer (zh branch).
 *
 * TypeScript port of piper1-gpl `src/piper/phonemize_chinese.py`
 * (Apache-2.0) and `src/piper/g2pw_onnx.py` (Apache-2.0, Yi-Chang Chen).
 * g2pW model + tables download on demand; bert-base-chinese WordPiece
 * vocab downloads from Hugging Face.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import {
	createRawOrtSession,
	type RawOrtSession,
	type OrtLike,
} from "./inference.js";

// ---------- Pinyin tables (from phonemize_chinese.py) ----------

/** NOTE: must stay sorted longest to shortest. */
export const PINYIN_INITIALS = [
	"zh",
	"ch",
	"sh",
	"b",
	"p",
	"m",
	"f",
	"d",
	"t",
	"n",
	"l",
	"g",
	"k",
	"h",
	"j",
	"q",
	"x",
	"r",
	"z",
	"c",
	"s",
	"y",
	"w",
];

export const PINYIN_PHONEME_TO_ID: Record<string, number[]> = {
	_: [0],
	"^": [1],
	$: [2],
	Ø: [3],
	b: [4],
	p: [5],
	m: [6],
	f: [7],
	d: [8],
	t: [9],
	n: [10],
	l: [11],
	g: [12],
	k: [13],
	h: [14],
	j: [15],
	q: [16],
	x: [17],
	zh: [18],
	ch: [19],
	sh: [20],
	r: [21],
	z: [22],
	c: [23],
	s: [24],
	y: [25],
	w: [26],
	a: [27],
	o: [28],
	e: [29],
	ai: [30],
	ei: [31],
	ao: [32],
	ou: [33],
	an: [34],
	en: [35],
	ang: [36],
	eng: [37],
	ong: [38],
	i: [39],
	ia: [40],
	ie: [41],
	iao: [42],
	iu: [43],
	ian: [44],
	in: [45],
	iang: [46],
	ing: [47],
	iong: [48],
	u: [49],
	ua: [50],
	uo: [51],
	uai: [52],
	ui: [53],
	uan: [54],
	un: [55],
	uang: [56],
	ueng: [57],
	v: [58],
	ve: [59],
	van: [60],
	vn: [61],
	er: [62],
	ue: [63],
	"1": [64],
	"2": [65],
	"3": [66],
	"4": [67],
	"5": [68],
	"。": [69],
	".": [69],
	"？": [70],
	"?": [70],
	"！": [71],
	"!": [71],
	"—": [72],
	"…": [72],
	"、": [72],
	"，": [72],
	",": [72],
	"：": [72],
	":": [72],
	"；": [72],
	";": [72],
	" ": [72],
};

export const PINYIN_GROUP_END_PHONEMES = new Set([
	"1",
	"2",
	"3",
	"4",
	"5",
	"。",
	"？",
	"！",
	".",
	"?",
	"!",
	"—",
	"…",
	"、",
	"，",
	"：",
	"；",
	",",
	":",
	";",
	" ",
]);

/**
 * Pinyin triple phonemes with group-end padding.
 * Port of `phonemize_chinese.py` (Apache-2.0).
 */
export interface ChinesePhonemesToIdsResult {
	ids: number[];
	skipped: string[];
}

/**
 * Pinyin ids: BOS, then ids per phoneme with PAD after each group-end
 * phoneme (tone or pause), then EOS. Mirrors `phonemes_to_ids` in
 * `phonemize_chinese.py` (differs from the default espeak padding).
 */
export function chinesePhonemesToIds(
	phonemes: string[],
	idMap: Record<string, number[]> = PINYIN_PHONEME_TO_ID,
): ChinesePhonemesToIdsResult {
	const ids: number[] = [...(idMap["^"] ?? [])];
	const skipped: string[] = [];
	for (const phoneme of phonemes) {
		const mapped = idMap[phoneme];
		if (!mapped) {
			skipped.push(phoneme);
			continue;
		}
		ids.push(...mapped);
		if (PINYIN_GROUP_END_PHONEMES.has(phoneme)) {
			ids.push(...(idMap["_"] ?? []));
		}
	}
	ids.push(...(idMap["$"] ?? []));
	return { ids, skipped };
}

export function normalizeG2pwSyllable(syl: string): string {
	const m = syl.match(/^([a-züv:]+?)([1-5])$/);
	if (!m) {
		return syl;
	}
	const base = (m[1] as string).replace(/u:/g, "v").replace(/ü/g, "v");
	return base + (m[2] as string);
}

export function splitInitialFinalTone(
	syl: string,
): [string, string, string | null] {
	const m = syl.match(/^([a-zvü]+?)([1-5])$/);
	if (!m) {
		return ["", "", null];
	}
	const base = m[1] as string;
	const tone = m[2] as string;
	let ini = "";
	for (const cand of PINYIN_INITIALS) {
		if (base.startsWith(cand)) {
			ini = cand;
			break;
		}
	}
	return [ini, ini ? base.slice(ini.length) : base, tone];
}

// ---------- Codepoint-aware sort (Python sorted() semantics) ----------

/** Compares strings by Unicode code points (Python `sorted`, not UTF-16). */
export function compareCodepoints(a: string, b: string): number {
	const ca = [...a];
	const cb = [...b];
	const n = Math.min(ca.length, cb.length);
	for (let i = 0; i < n; i++) {
		const pa = (ca[i] as string).codePointAt(0) as number;
		const pb = (cb[i] as string).codePointAt(0) as number;
		if (pa !== pb) {
			return pa - pb;
		}
	}
	return ca.length - cb.length;
}

// ---------- wordize_and_map (ported from g2pw_onnx.py) ----------

export interface WordizeResult {
	words: string[];
	text2word: (number | null)[];
	word2text: [number, number][];
}

export function wordizeAndMap(text: string): WordizeResult {
	const words: string[] = [];
	const text2word: (number | null)[] = [];
	const word2text: [number, number][] = [];
	let rest = text;
	while (rest.length > 0) {
		const spaceMatch = rest.match(/^ +/);
		if (spaceMatch) {
			const spaces = spaceMatch[0];
			for (let i = 0; i < spaces.length; i++) {
				text2word.push(null);
			}
			rest = rest.slice(spaces.length);
			continue;
		}
		const enMatch = rest.match(/^[a-zA-Z0-9]+/);
		if (enMatch) {
			const enWord = enMatch[0];
			const start = text2word.length;
			word2text.push([start, start + enWord.length]);
			for (let i = 0; i < enWord.length; i++) {
				text2word.push(words.length);
			}
			words.push(enWord);
			rest = rest.slice(enWord.length);
		} else {
			const start = text2word.length;
			word2text.push([start, start + 1]);
			text2word.push(words.length);
			words.push(rest[0] as string);
			rest = rest.slice(1);
		}
	}
	return { words, text2word, word2text };
}

// ---------- BertTokenizer (basic + WordPiece, bert-base-chinese) ----------

function isCjkChar(cp: number): boolean {
	return (
		(cp >= 0x4e00 && cp <= 0x9fff) ||
		(cp >= 0x3400 && cp <= 0x4dbf) ||
		(cp >= 0x20000 && cp <= 0x2a6df) ||
		(cp >= 0x2a700 && cp <= 0x2b73f) ||
		(cp >= 0x2b740 && cp <= 0x2b81f) ||
		(cp >= 0x2b820 && cp <= 0x2ceaf) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0x2f800 && cp <= 0x2fa1f)
	);
}

function isPunctuation(ch: string): boolean {
	const cp = ch.codePointAt(0) as number;
	if (
		(cp >= 33 && cp <= 47) ||
		(cp >= 58 && cp <= 64) ||
		(cp >= 91 && cp <= 96) ||
		(cp >= 123 && cp <= 126)
	) {
		return true;
	}
	return /^\p{P}$/u.test(ch);
}

function cleanText(text: string): string {
	let out = "";
	for (const ch of text) {
		const cp = ch.codePointAt(0) as number;
		if (
			cp === 0 ||
			cp === 0xfffd ||
			(cp >= 1 && cp <= 31 && ch !== "\t" && ch !== "\n" && ch !== "\r")
		) {
			continue;
		}
		out += ch;
	}
	return out;
}

function basicTokenize(text: string, doLowerCase = true): string[] {
	let t = cleanText(text);
	let spaced = "";
	for (const ch of t) {
		if (isCjkChar(ch.codePointAt(0) as number)) {
			spaced += ` ${ch} `;
		} else {
			spaced += ch;
		}
	}
	const tokens: string[] = [];
	for (const token of spaced.trim().split(/\s+/).filter(Boolean)) {
		let tok = doLowerCase ? token.toLowerCase() : token;
		// strip accents (NFD + remove Mn) when lowercasing, like HF
		if (doLowerCase) {
			tok = tok.normalize("NFD").replace(/\p{Mn}/gu, "");
		}
		// split on punctuation
		let current = "";
		for (const ch of tok) {
			if (isPunctuation(ch)) {
				if (current) {
					tokens.push(current);
					current = "";
				}
				tokens.push(ch);
			} else {
				current += ch;
			}
		}
		if (current) {
			tokens.push(current);
		}
	}
	return tokens;
}

/**
 * Minimal bert-base-chinese tokenizer: basic tokenization + WordPiece.
 * Token ids match `transformers.BertTokenizer` for the same vocab.
 */
export class BertWordPieceTokenizer {
	private readonly vocab: Map<string, number>;
	private readonly unkToken = "[UNK]";
	private readonly maxChars = 100;

	constructor(vocab: string[]) {
		this.vocab = new Map(vocab.map((t, i) => [t, i]));
	}

	tokenizeWord(word: string): string[] {
		const chars = [...word];
		if (chars.length > this.maxChars) {
			return [this.unkToken];
		}
		// Basic-tokenize the single word first (HF BertTokenizer.tokenize path).
		const output: string[] = [];
		for (const basic of basicTokenize(word, false)) {
			output.push(...this.wordpiece(basic));
		}
		return output;
	}

	private wordpiece(token: string): string[] {
		const chars = [...token];
		if (chars.length > this.maxChars) {
			return [this.unkToken];
		}
		const subTokens: string[] = [];
		let start = 0;
		while (start < chars.length) {
			let end = chars.length;
			let cur: string | null = null;
			while (start < end) {
				let substr = chars.slice(start, end).join("");
				if (start > 0) {
					substr = "##" + substr;
				}
				if (this.vocab.has(substr)) {
					cur = substr;
					break;
				}
				end -= 1;
			}
			if (cur === null) {
				return [this.unkToken];
			}
			subTokens.push(cur);
			start = end;
		}
		return subTokens;
	}

	convertTokensToIds(tokens: string[]): number[] {
		return tokens.map(
			(t) => this.vocab.get(t) ?? this.vocab.get(this.unkToken) ?? 100,
		);
	}

	static loadVocabFile(vocabPath: string): BertWordPieceTokenizer {
		const content = fs.readFileSync(vocabPath, "utf8");
		return new BertWordPieceTokenizer(
			content
				.split("\n")
				.map((l) => l.replace(/\r$/, ""))
				.filter((l) => l.length > 0),
		);
	}
}

export interface TokenizeMapResult {
	tokens: string[];
	text2token: (number | null)[];
	token2text: [number, number][];
}

export function tokenizeAndMap(
	tokenizer: BertWordPieceTokenizer,
	text: string,
): TokenizeMapResult {
	const { words, text2word, word2text } = wordizeAndMap(text);
	const tokens: string[] = [];
	const token2text: [number, number][] = [];
	words.forEach((word, wi) => {
		const [wordStart, wordEnd] = word2text[wi] as [number, number];
		const wordTokens = tokenizer.tokenizeWord(word);
		if (
			wordTokens.length === 0 ||
			(wordTokens.length === 1 && wordTokens[0] === "[UNK]")
		) {
			token2text.push([wordStart, wordEnd]);
			tokens.push("[UNK]");
		} else {
			let currentStart = wordStart;
			for (const wt of wordTokens) {
				const clean = wt.replace(/^##/, "");
				const len = [...clean].length;
				token2text.push([currentStart, currentStart + len]);
				currentStart += len;
				tokens.push(wt);
			}
		}
	});
	const text2token: (number | null)[] = [...text2word];
	token2text.forEach(([tokenStart, tokenEnd], i) => {
		for (let pos = tokenStart; pos < tokenEnd; pos++) {
			text2token[pos] = i;
		}
	});
	return { tokens, text2token, token2text };
}

// ---------- Labels ----------

export function getPhonemeLabels(polyphonicChars: [string, string][]): {
	labels: string[];
	char2phonemes: Map<string, number[]>;
} {
	const labelSet = new Set(polyphonicChars.map(([, phoneme]) => phoneme));
	const labels = [...labelSet].sort(compareCodepoints);
	const char2phonemes = new Map<string, number[]>();
	for (const [char, phoneme] of polyphonicChars) {
		const arr = char2phonemes.get(char) ?? [];
		arr.push(labels.indexOf(phoneme));
		char2phonemes.set(char, arr);
	}
	return { labels, char2phonemes };
}

// ---------- Feature builder ----------

export interface G2pwSample {
	inputIds: number[];
	tokenTypeIds: number[];
	attentionMask: number[];
	phonemeMask: number[];
	charId: number;
	positionId: number;
}

const G2PW_MAX_LEN = 512;

function truncateWindow(
	windowSize: number,
	texts: string[],
	queryIds: number[],
): [string[], number[]] {
	const truncatedTexts: string[] = [];
	const truncatedQueryIds: number[] = [];
	texts.forEach((text, idx) => {
		const queryId = queryIds[idx] as number;
		const start = Math.max(0, queryId - Math.floor(windowSize / 2));
		const end = Math.min(
			[...text].length,
			queryId + Math.floor(windowSize / 2),
		);
		const chars = [...text];
		truncatedTexts.push(chars.slice(start, end).join(""));
		truncatedQueryIds.push(queryId - start);
	});
	return [truncatedTexts, truncatedQueryIds];
}

export interface FeatureBuilderOptions {
	windowSize?: number;
	useMask?: boolean;
}

export function buildG2pwSample(
	tokenizer: BertWordPieceTokenizer,
	labels: string[],
	char2phonemes: Map<string, number[]>,
	chars: string[],
	text: string,
	queryId: number,
	options: FeatureBuilderOptions = {},
): G2pwSample | null {
	const useMask = options.useMask ?? true;
	const lowered = text.toLowerCase();
	let tokens: string[];
	let text2token: (number | null)[];
	let token2text: [number, number][];
	try {
		const mapped = tokenizeAndMap(tokenizer, lowered);
		tokens = mapped.tokens;
		text2token = mapped.text2token;
		token2text = mapped.token2text;
	} catch {
		return null;
	}
	// _truncate to max_len
	const truncateLen = G2PW_MAX_LEN - 2;
	let tText = lowered;
	let tQuery = queryId;
	if (tokens.length > truncateLen) {
		const tokenPos = text2token[queryId];
		if (tokenPos === null || tokenPos === undefined) {
			return null;
		}
		let tokenStart = tokenPos - Math.floor(truncateLen / 2);
		let tokenEnd = tokenStart + truncateLen;
		const frontExceed = -tokenStart;
		const backExceed = tokenEnd - tokens.length;
		if (frontExceed > 0) {
			tokenStart += frontExceed;
			tokenEnd += frontExceed;
		} else if (backExceed > 0) {
			tokenStart -= backExceed;
			tokenEnd -= backExceed;
		}
		const start = (token2text[tokenStart] as [number, number])[0];
		const end = (token2text[tokenEnd - 1] as [number, number])[1];
		const textChars = [...lowered];
		tText = textChars.slice(start, end).join("");
		tQuery = queryId - start;
		tokens = tokens.slice(tokenStart, tokenEnd);
		text2token = text2token
			.slice(start, end)
			.map((i) => (i === null ? null : (i as number) - tokenStart));
		token2text = token2text
			.slice(tokenStart, tokenEnd)
			.map(([s, e]) => [s - start, e - start] as [number, number]);
	}
	const processedTokens = ["[CLS]", ...tokens, "[SEP]"];
	const queryChar = [...tText][tQuery] as string;
	const candidates = char2phonemes.get(queryChar) ?? [];
	const phonemeMask = labels.map((_, i) =>
		useMask ? (candidates.includes(i) ? 1 : 0) : 1,
	);
	const pos = text2token[tQuery];
	if (pos === null || pos === undefined) {
		return null;
	}
	return {
		inputIds: tokenizer.convertTokensToIds(processedTokens),
		tokenTypeIds: new Array(processedTokens.length).fill(0),
		attentionMask: new Array(processedTokens.length).fill(1),
		phonemeMask,
		charId: chars.indexOf(queryChar),
		positionId: (pos as number) + 1,
	};
}

// ---------- G2PW converter ----------

export interface G2pwModelFiles {
	onnxPath: string;
	vocabPath: string;
	polyphonicPath: string;
	monophonicPath: string;
	bopomofoToPinyinPath: string;
	charBopomofoPath: string;
	s2tPath: string;
}

const G2PW_TARBALL_URL =
	"https://huggingface.co/datasets/rhasspy/piper-checkpoints/resolve/main/zh/zh_CN/_resources/g2pw.tar.gz?download=true";
const G2PW_VOCAB_URL =
	"https://huggingface.co/google-bert/bert-base-chinese/resolve/main/vocab.txt";
const G2PW_DATA_BASE_URL =
	"https://raw.githubusercontent.com/GitYCC/g2pw/master/g2pw";
const G2PW_DATA_FILES = [
	"bopomofo_to_pinyin_wo_tune_dict.json",
	"char_bopomofo_dict.json",
	"bert-base-chinese_s2t_dict.txt",
];

function runTar(
	args: string[],
	cwd: string,
	timeoutMs = 300_000,
): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile(
			"tar",
			args,
			{ cwd, timeout: timeoutMs },
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

/** Ensures the g2pw model dir (tarball + vocab + lookup tables). */
export async function ensureG2pwModelDir(
	modelDir: string,
): Promise<G2pwModelFiles> {
	const files: G2pwModelFiles = {
		onnxPath: path.join(modelDir, "g2pw.onnx"),
		vocabPath: path.join(modelDir, "vocab.txt"),
		polyphonicPath: path.join(modelDir, "POLYPHONIC_CHARS.txt"),
		monophonicPath: path.join(modelDir, "MONOPHONIC_CHARS.txt"),
		bopomofoToPinyinPath: path.join(
			modelDir,
			"bopomofo_to_pinyin_wo_tune_dict.json",
		),
		charBopomofoPath: path.join(modelDir, "char_bopomofo_dict.json"),
		s2tPath: path.join(modelDir, "bert-base-chinese_s2t_dict.txt"),
	};
	if (!fs.existsSync(modelDir)) {
		fs.mkdirSync(modelDir, { recursive: true });
	}
	if (
		!fs.existsSync(files.onnxPath) ||
		!fs.existsSync(files.polyphonicPath) ||
		!fs.existsSync(files.monophonicPath)
	) {
		const tarPath = path.join(modelDir, "g2pw.tar.gz");
		await fetchToFile(G2PW_TARBALL_URL, tarPath);
		await runTar(["xzf", tarPath, "-C", modelDir], modelDir);
		try {
			fs.unlinkSync(tarPath);
		} catch {
			// best effort
		}
	}
	if (!fs.existsSync(files.vocabPath)) {
		await fetchToFile(G2PW_VOCAB_URL, files.vocabPath);
	}
	for (const name of G2PW_DATA_FILES) {
		const dest = path.join(modelDir, name);
		if (!fs.existsSync(dest)) {
			await fetchToFile(`${G2PW_DATA_BASE_URL}/${name}`, dest);
		}
	}
	return files;
}

function parseG2pwConfig(modelDir: string): {
	windowSize: number;
	batchSize: number;
	useMask: boolean;
} {
	const defaults = { windowSize: 32, batchSize: 256, useMask: true };
	try {
		const content = fs.readFileSync(path.join(modelDir, "config.py"), "utf8");
		const num = (key: string, fallback: number): number => {
			const m = content.match(new RegExp(`^${key}\\s*=\\s*(\\d+)`, "m"));
			return m ? parseInt(m[1] as string, 10) : fallback;
		};
		const bool = (key: string, fallback: boolean): boolean => {
			const m = content.match(new RegExp(`^${key}\\s*=\\s*(True|False)`, "m"));
			return m ? m[1] === "True" : fallback;
		};
		return {
			windowSize: num("window_size", defaults.windowSize),
			batchSize: num("batch_size", defaults.batchSize),
			useMask: bool("use_mask", defaults.useMask),
		};
	} catch {
		return defaults;
	}
}

/**
 * Torch-free g2pW converter: same `g2pw.onnx` graph under onnxruntime.
 * Port of `g2pw_onnx.G2PWOnnxConverter` (Apache-2.0).
 */
export class G2PWOnnxConverter {
	private readonly ort: OrtLike;
	private readonly session: RawOrtSession;
	private readonly tokenizer: BertWordPieceTokenizer;
	private readonly labels: string[];
	private readonly char2phonemes: Map<string, number[]>;
	private readonly chars: string[];
	private readonly monophonic: Map<string, string>;
	private readonly charBopomofo: Record<string, string[]>;
	private readonly bopomofoToPinyin: Record<string, string>;
	private readonly s2t: Map<string, string>;
	private readonly batchSize: number;
	private readonly windowSize: number;
	private readonly useMask: boolean;

	private constructor(
		ort: OrtLike,
		session: RawOrtSession,
		tokenizer: BertWordPieceTokenizer,
		labels: string[],
		char2phonemes: Map<string, number[]>,
		chars: string[],
		monophonic: Map<string, string>,
		charBopomofo: Record<string, string[]>,
		bopomofoToPinyin: Record<string, string>,
		s2t: Map<string, string>,
		batchSize: number,
		windowSize: number,
		useMask: boolean,
	) {
		this.ort = ort;
		this.session = session;
		this.tokenizer = tokenizer;
		this.labels = labels;
		this.char2phonemes = char2phonemes;
		this.chars = chars;
		this.monophonic = monophonic;
		this.charBopomofo = charBopomofo;
		this.bopomofoToPinyin = bopomofoToPinyin;
		this.s2t = s2t;
		this.batchSize = batchSize;
		this.windowSize = windowSize;
		this.useMask = useMask;
	}

	/** Loads the converter (downloads model dir on first use). */
	static async load(
		modelDir: string,
		enableS2t = true,
	): Promise<G2PWOnnxConverter> {
		const files = await ensureG2pwModelDir(modelDir);
		const { createRawOrtSession } = await import("./inference.js");
		const { ort, session } = await createRawOrtSession(files.onnxPath);
		const readLines = (p: string): string[] =>
			fs
				.readFileSync(p, "utf8")
				.split("\n")
				.map((l) => l.trim())
				.filter(Boolean);
		const poly: [string, string][] = readLines(files.polyphonicPath).map(
			(l) => {
				const [char, phoneme] = l.split("\t");
				return [char as string, phoneme as string];
			},
		);
		const mono = new Map<string, string>();
		for (const l of readLines(files.monophonicPath)) {
			const [char, phoneme] = l.split("\t");
			mono.set(char as string, phoneme as string);
		}
		const { labels, char2phonemes } = getPhonemeLabels(poly);
		const chars = [...char2phonemes.keys()].sort(compareCodepoints);
		const bopomofoToPinyin = JSON.parse(
			fs.readFileSync(files.bopomofoToPinyinPath, "utf8"),
		) as Record<string, string>;
		const charBopomofo = JSON.parse(
			fs.readFileSync(files.charBopomofoPath, "utf8"),
		) as Record<string, string[]>;
		const s2t = new Map<string, string>();
		if (enableS2t) {
			for (const l of readLines(files.s2tPath)) {
				const [s, t] = l.split("\t");
				s2t.set(s as string, t as string);
			}
		}
		const cfg = parseG2pwConfig(modelDir);
		return new G2PWOnnxConverter(
			ort,
			session,
			BertWordPieceTokenizer.loadVocabFile(files.vocabPath),
			labels,
			char2phonemes,
			chars,
			mono,
			charBopomofo,
			bopomofoToPinyin,
			s2t,
			cfg.batchSize,
			cfg.windowSize,
			cfg.useMask,
		);
	}

	private convertBopomofoToPinyin(bopomofo: string): string | null {
		const tone = bopomofo[bopomofo.length - 1] as string;
		if (!"12345".includes(tone)) {
			return null;
		}
		const component = this.bopomofoToPinyin[bopomofo.slice(0, -1)];
		return component ? component + tone : null;
	}

	private convertS2t(sentence: string): string {
		return [...sentence].map((c) => this.s2t.get(c) ?? c).join("");
	}

	/** Pinyin (or null for punctuation) per character per sentence. */
	/** Pinyin (or null for punctuation) per character per sentence. */
	async convert(sentences: string | string[]): Promise<(string | null)[][]> {
		const list = typeof sentences === "string" ? [sentences] : sentences;
		const converted = list.map((s) => this.convertS2t(s));
		const texts: string[] = [];
		const queryIds: number[] = [];
		const sentIds: number[] = [];
		const partial: (string | null)[][] = [];
		converted.forEach((sentence, sentId) => {
			const row: (string | null)[] = new Array([...sentence].length).fill(null);
			[...sentence].forEach((char, i) => {
				if (this.chars.includes(char)) {
					texts.push(sentence);
					queryIds.push(i);
					sentIds.push(sentId);
				} else if (this.monophonic.has(char)) {
					row[i] = this.convertBopomofoToPinyin(
						this.monophonic.get(char) as string,
					);
				} else if (this.charBopomofo[char]) {
					row[i] = this.convertBopomofoToPinyin(
						(this.charBopomofo[char] as string[])[0] as string,
					);
				}
			});
			partial.push(row);
		});
		if (texts.length === 0) {
			return partial;
		}
		const [truncTexts, truncQueryIds] = truncateWindow(
			this.windowSize,
			texts,
			queryIds,
		);
		const samples: G2pwSample[] = [];
		const sampleMeta: [number, number][] = [];
		truncTexts.forEach((text, idx) => {
			const sample = buildG2pwSample(
				this.tokenizer,
				this.labels,
				this.char2phonemes,
				this.chars,
				text,
				truncQueryIds[idx] as number,
				{ useMask: this.useMask },
			);
			if (sample) {
				samples.push(sample);
				sampleMeta.push([sentIds[idx] as number, queryIds[idx] as number]);
			}
		});
		const preds: string[] = [];
		for (let start = 0; start < samples.length; start += this.batchSize) {
			const batch = samples.slice(start, start + this.batchSize);
			// Right-pad int rows to the batch max (mirrors _pad_stack).
			const padTo = (rows: number[][], width: number): BigInt64Array => {
				const out = new BigInt64Array(rows.length * width);
				rows.forEach((row, i) => {
					row.forEach((v, j) => {
						out[i * width + j] = BigInt(v);
					});
				});
				return out;
			};
			const wInput = Math.max(...batch.map((s) => s.inputIds.length));
			const wType = Math.max(...batch.map((s) => s.tokenTypeIds.length));
			const wMask = Math.max(...batch.map((s) => s.attentionMask.length));
			const feeds: Record<string, unknown> = {
				input_ids: new this.ort.Tensor(
					"int64",
					padTo(
						batch.map((s) => s.inputIds),
						wInput,
					),
					[batch.length, wInput],
				),
				token_type_ids: new this.ort.Tensor(
					"int64",
					padTo(
						batch.map((s) => s.tokenTypeIds),
						wType,
					),
					[batch.length, wType],
				),
				attention_mask: new this.ort.Tensor(
					"int64",
					padTo(
						batch.map((s) => s.attentionMask),
						wMask,
					),
					[batch.length, wMask],
				),
				phoneme_mask: new this.ort.Tensor(
					"float32",
					Float32Array.from(batch.flatMap((s) => s.phonemeMask)),
					[batch.length, this.labels.length],
				),
				char_ids: new this.ort.Tensor(
					"int64",
					BigInt64Array.from(batch.map((s) => BigInt(s.charId))),
					[batch.length],
				),
				position_ids: new this.ort.Tensor(
					"int64",
					BigInt64Array.from(batch.map((s) => BigInt(s.positionId))),
					[batch.length],
				),
			};
			const results = await this.session.run(feeds);
			const probs = Array.from(results["probs"]?.data ?? []);
			const numLabels = this.labels.length;
			const batchCount = probs.length / numLabels;
			for (let b = 0; b < batchCount; b++) {
				let best = 0;
				let bestV = -Infinity;
				for (let c = 0; c < numLabels; c++) {
					const v = probs[b * numLabels + c] as number;
					if (v > bestV) {
						bestV = v;
						best = c;
					}
				}
				preds.push(this.labels[best] as string);
			}
		}
		sampleMeta.forEach(([sentId, queryId], i) => {
			(partial[sentId] as (string | null)[])[queryId] =
				this.convertBopomofoToPinyin(preds[i] as string);
		});
		return partial;
	}
}

// ---------- Numbers (zh verbalization, mirrors RbnfEngine zh) ----------

const ZH_DIGITS = ["〇", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
const ZH_UNITS = ["", "十", "百", "千"];
const ZH_BIG_UNITS = ["", "万", "亿", "万亿", "亿亿"];

function zhSection(num: number): string {
	// 0 <= num < 10000
	if (num === 0) {
		return "";
	}
	const digits: number[] = [
		Math.floor(num / 1000),
		Math.floor(num / 100) % 10,
		Math.floor(num / 10) % 10,
		num % 10,
	];
	let out = "";
	let zeroPending = false;
	digits.forEach((d, i) => {
		const unit = ZH_UNITS[3 - i] as string;
		if (d === 0) {
			zeroPending = out.length > 0;
		} else {
			if (zeroPending) {
				out += "〇";
				zeroPending = false;
			}
			// 10-19: 十X without leading 一
			if (!(num < 20 && num >= 10 && i === 2 && d === 1 && out === "")) {
				out += ZH_DIGITS[d] as string;
			}
			out += unit;
		}
	});
	return out;
}

function zhInteger(num: number): string {
	if (num === 0) {
		return "〇";
	}
	const sections: number[] = [];
	let rest = num;
	while (rest > 0) {
		sections.push(rest % 10000);
		rest = Math.floor(rest / 10000);
	}
	let out = "";
	let zeroPending = false;
	for (let i = sections.length - 1; i >= 0; i--) {
		const section = sections[i] as number;
		if (section === 0) {
			zeroPending = out.length > 0;
			continue;
		}
		if (zeroPending) {
			out += "〇";
			zeroPending = false;
		} else if (out.length > 0 && section < 1000) {
			// e.g. 10001 -> 一万〇一
			out += "〇";
		}
		out += zhSection(section) + (ZH_BIG_UNITS[i] as string);
	}
	return out;
}

/** Verbalizes a decimal/negative number like RbnfEngine zh. */
export function zhNumberToWords(text: string): string {
	let negative = false;
	let t = text;
	if (t.startsWith("-")) {
		negative = true;
		t = t.slice(1);
	}
	const [intPart, fracPart] = t.split(".");
	let out = zhInteger(parseInt(intPart || "0", 10));
	if (fracPart !== undefined && fracPart.length > 0) {
		out +=
			"点" +
			[...fracPart].map((d) => ZH_DIGITS[parseInt(d, 10)] as string).join("");
	}
	return (negative ? "负" : "") + out;
}

const ZH_TEMP_PATTERN = /(?<sign>[-−])?(?<num>\d+)\s*(?:°\s*C|℃)/;
const ZH_PERCENT_PATTERN =
	/(?<num>-?\d+(?:\.\d+)?|[零〇一二三四五六七八九十百千万亿两点]+)\s*(?:%|％)/;

/** Mirrors ChinesePhonemizer._numbers_to_words (temps, percents, numbers). */
export function zhNumbersToWords(text: string): string {
	let out = text.replace(
		new RegExp(ZH_TEMP_PATTERN.source, "g"),
		(...args: unknown[]) => {
			const groups = args[args.length - 1] as { sign?: string; num: string };
			const words = zhNumberToWords(groups.num);
			return groups.sign ? `零下${words}度` : `${words}度`;
		},
	);
	out = out.replace(
		new RegExp(ZH_PERCENT_PATTERN.source, "g"),
		(...args: unknown[]) => {
			const groups = args[args.length - 1] as { num: string };
			const numWords = /^-?\d+(?:\.\d+)?$/.test(groups.num)
				? zhNumberToWords(groups.num)
				: groups.num;
			return `百分之${numWords}`;
		},
	);
	return out.replace(/-?\d+(?:\.\d+)?/g, (m) => zhNumberToWords(m));
}

// ---------- Sentences (mirrors stream_to_sentences for zh) ----------

/** Splits after 。？！…!? (keeping delimiters and closing quotes). */
export function splitZhSentences(text: string): string[] {
	return [...streamSentences(text)];
}

/**
 * Port of `sentence_stream.SentenceBoundaryDetector` (Apache-2.0,
 * Home Assistant) for complete input: Chinese enders anywhere, ASCII
 * enders with lookahead, abbreviation hold-back, blank-line splits.
 */
export function* streamSentences(text: string): Generator<string> {
	const SENTENCE_END = "[.!?…؟।॥]";
	const ABBREVIATION_RE = /\b\p{Lu}(?:\p{L}{1,2})?\.$/u;
	const ASCII_CLOSERS = `['"\\)\\]\\}\u2019\u201d»]*`;
	const ASCII_RE = new RegExp(
		`(?:${SENTENCE_END}+)${ASCII_CLOSERS}(?=\\s+[\\p{Lu}\\p{Lt}\\p{Lo}]|(?:\\s+\\d+[.)]{1,2}\\s+))`,
		"su",
	);
	const ZH_RE = /(?:[。！？]|……|…)+[”’」』）》】〕〉）]*/su;
	const BLANK_RE = /(?:\r?\n){2,}/u;
	const removeAsterisks = (s: string): string =>
		s.replace(/\*+([^*]+)\*+/g, "$1").replace(/(?:^|\n)\s*\*+/g, "");

	let remaining = text;
	let current = "";
	const flush = function* (s: string): Generator<string> {
		const out = removeAsterisks(s.trim());
		if (out) {
			yield out;
		}
	};

	while (remaining) {
		ASCII_RE.lastIndex = 0;
		ZH_RE.lastIndex = 0;
		BLANK_RE.lastIndex = 0;
		const mBlank = BLANK_RE.exec(remaining);
		const mZh = ZH_RE.exec(remaining);
		const mAscii = ASCII_RE.exec(remaining);
		let first: RegExpExecArray | null = null;
		if (mZh && mAscii) {
			first = mZh.index < mAscii.index ? mZh : mAscii;
		} else {
			first = mZh ?? mAscii;
		}
		if (mBlank && first) {
			first = mBlank.index < first.index ? mBlank : first;
		} else if (mBlank) {
			first = mBlank;
		}
		if (!first) {
			break;
		}
		const isZh = first === mZh;
		if (isZh && first.index + first[0].length === remaining.length) {
			break;
		}
		const matchEnd = first.index + first[0].length;
		const matchText = remaining.slice(0, matchEnd);
		if (!current) {
			if (ABBREVIATION_RE.test(matchText.slice(-5))) {
				current = matchText;
			} else {
				yield* flush(matchText);
			}
		} else if (ABBREVIATION_RE.test(current.slice(-5))) {
			current += matchText;
		} else {
			yield* flush(current);
			current = matchText;
		}
		if (current && !ABBREVIATION_RE.test(current.slice(-5))) {
			yield* flush(current);
			current = "";
		}
		remaining = remaining.slice(matchEnd);
	}
	yield* flush(current + remaining);
}

// ---------- ChinesePhonemizer ----------

export interface ChinesePhonemizerOptions {
	modelDir?: string;
	dataDir?: string;
}

/**
 * Chinese phonemizer: numbers → words, g2pW syllables → pinyin triples.
 * Port of `ChinesePhonemizer` (Apache-2.0).
 */
export class ChinesePhonemizer {
	private readonly g2p: G2PWOnnxConverter;

	private constructor(g2p: G2PWOnnxConverter) {
		this.g2p = g2p;
	}

	/** Loads the phonemizer (downloads g2pw dir on first use). */
	static async load(modelDir: string): Promise<ChinesePhonemizer> {
		return new ChinesePhonemizer(await G2PWOnnxConverter.load(modelDir, true));
	}

	/** Pinyin triples grouped by sentence. */
	async phonemize(text: string): Promise<string[][]> {
		const cleaned = text.replace(/[“”"]/g, "");
		const allPhonemes: string[][] = [];
		for (const sentence of splitZhSentences(cleaned)) {
			const withNumbers = zhNumbersToWords(sentence);
			const sylls = (await this.g2p.convert(withNumbers))[0] ?? [];
			const sentencePhonemes: string[] = [];
			const chars = [...withNumbers];
			sylls.forEach((syl, idx) => {
				const sylChar = chars[idx] as string;
				if (syl === null || syl === undefined) {
					if (PINYIN_PHONEME_TO_ID[sylChar]) {
						sentencePhonemes.push(sylChar);
					}
					return;
				}
				const normalized = normalizeG2pwSyllable(syl);
				const [ini, fin, tone] = splitInitialFinalTone(normalized);
				if (!fin || !tone) {
					sentencePhonemes.push(syl);
					return;
				}
				sentencePhonemes.push(ini || "Ø", fin, tone);
			});
			allPhonemes.push(sentencePhonemes);
		}
		return allPhonemes;
	}
}
