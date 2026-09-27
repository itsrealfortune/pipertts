/**
 * Hebrew phonemizer (MVP).
 *
 * TypeScript port of piper1-gpl `src/piper/phonemize_hebrew.py`,
 * `src/piper/hebrew/__init__.py` (Nakdimon) and
 * `src/piper/hebrew/hebrew_ipa.py` (GPL-3.0-or-later; Nakdimon model MIT).
 * Model (`nakdimon.onnx`) downloads on demand, see `data.ts`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createRawOrtSession } from "./inference.js";

// ---------- Nakdimon tables (vendored) ----------

const RAFE = "ֿ";
const HEBREW_LETTERS = Array.from({ length: 0x05ea - 0x05d0 + 1 }, (_, i) =>
	String.fromCharCode(0x05d0 + i),
);
const NIQQUD_TABLE = [
	RAFE,
	...Array.from({ length: 0x05bc - 0x05b0 + 1 }, (_, i) =>
		String.fromCharCode(0x05b0 + i),
	),
	"ַ",
];
const SHIN_YEMANIT = "ׁ";
const SHIN_SMALIT = "ׂ";
const NIQQUD_SIN = [RAFE, SHIN_YEMANIT, SHIN_SMALIT];
const DAGESH_LETTER = "ּ";
const DAGESH_TABLE = [RAFE, DAGESH_LETTER];
const VALID_LETTERS = [
	" ",
	"!",
	'"',
	"'",
	"(",
	")",
	",",
	"-",
	".",
	":",
	";",
	"?",
	...HEBREW_LETTERS,
];
const SPECIAL_TOKENS = ["H", "O", "5"];
const ENDINGS_TO_REGULAR = new Map(
	[..."ךםןףץ"].map((c, i) => [c, [..."כמנפצ"][i] as string]),
);
const LETTER_CHARS = ["", ...SPECIAL_TOKENS, ...VALID_LETTERS];
const NIQQUD_CHARS = ["", ...NIQQUD_TABLE];
const DAGESH_CHARS = ["", ...DAGESH_TABLE];
const SIN_CHARS = ["", ...NIQQUD_SIN];
const CHAR_TO_ID = new Map(LETTER_CHARS.map((c, i) => [c, i]));
const NIQQUD_DETECT = /[ְ-ׇּֿׁׂ]/;

function removeNiqqud(text: string): string {
	return text.replace(NIQQUD_DETECT, "");
}

function normalizeChar(c: string): string {
	if (VALID_LETTERS.includes(c)) {
		return c;
	}
	const ending = ENDINGS_TO_REGULAR.get(c);
	if (ending) {
		return ending;
	}
	if (c === "\n" || c === "\t") {
		return " ";
	}
	if ("־‒–—―−".includes(c)) {
		return "-";
	}
	if (c === "[") {
		return "(";
	}
	if (c === "]") {
		return ")";
	}
	if ("´‘’".includes(c)) {
		return "'";
	}
	if ("“”״".includes(c)) {
		return '"';
	}
	if (/\d/.test(c)) {
		return "5";
	}
	if (c === "…") {
		return ",";
	}
	if ("ײװױ".includes(c)) {
		return "H";
	}
	return "O";
}

function canDagesh(letter: string): boolean {
	return "בגדהוזטיכלמנספצקשתךף".includes(letter);
}

function canSin(letter: string): boolean {
	return letter === "ש";
}

function canNiqqud(letter: string): boolean {
	return "אבגדהוזחטיכלמנסעפצקרשתךן".includes(letter);
}

/** Nakdimon ONNX diacritizer restoring Hebrew niqqud. Port of hebrew/__init__.py. */
export class NakdimonDiacritizer {
	private readonly ort: import("./inference.js").OrtLike;
	private readonly session: import("./inference.js").RawOrtSession;
	private readonly inputName: string;

	private constructor(
		ort: import("./inference.js").OrtLike,
		session: import("./inference.js").RawOrtSession,
		inputName: string,
	) {
		this.ort = ort;
		this.session = session;
		this.inputName = inputName;
	}

	/** Load the Nakdimon model from a file path or a directory containing nakdimon.onnx. */
	static async load(modelPathOrDir: string): Promise<NakdimonDiacritizer> {
		let modelPath = modelPathOrDir;
		try {
			if (fs.statSync(modelPathOrDir).isDirectory()) {
				modelPath = path.join(modelPathOrDir, "nakdimon.onnx");
			}
		} catch {
			// treat as file path
		}
		if (!fs.existsSync(modelPath)) {
			throw new Error(
				`PiperNative: Nakdimon model not found at "${modelPath}".`,
			);
		}
		const { ort, session } = await createRawOrtSession(modelPath);
		const inputName = session.inputNames[0];
		if (!inputName) {
			throw new Error("PiperNative: Nakdimon model has no inputs.");
		}
		return new NakdimonDiacritizer(ort, session, inputName);
	}

	/** Run the Nakdimon model over text and return it with niqqud/dagesh/sin marks added. */
	async diacritize(text: string): Promise<string> {
		const bare = removeNiqqud(text);
		const letters = [...bare];
		if (letters.length === 0) {
			return text;
		}
		const ids = letters.map((c) => CHAR_TO_ID.get(normalizeChar(c)) ?? 0);
		const feeds: Record<string, unknown> = {
			[this.inputName]: new this.ort.Tensor("float32", Float32Array.from(ids), [
				1,
				ids.length,
			]),
		};
		const results = await this.session.run(feeds);
		const nOut = Array.from(results["N"]?.data ?? []);
		const dOut = Array.from(results["D"]?.data ?? []);
		const sOut = Array.from(results["S"]?.data ?? []);
		const n = letters.length;
		const argmax = (data: number[], classes: number, row: number): number => {
			let best = 0;
			let bestV = -Infinity;
			for (let c = 0; c < classes; c++) {
				const v = data[row * classes + c] as number;
				if (v > bestV) {
					bestV = v;
					best = c;
				}
			}
			return best;
		};
		const out: string[] = [];
		for (let i = 0; i < n; i++) {
			const letter = letters[i] as string;
			const nId = argmax(nOut, 16, i);
			const dId = argmax(dOut, 3, i);
			const sId = argmax(sOut, 4, i);
			out.push(letter);
			if (canDagesh(letter)) {
				out.push(DAGESH_CHARS[dId] as string);
			}
			if (canSin(letter)) {
				out.push(SIN_CHARS[sId] as string);
			}
			if (canNiqqud(letter)) {
				out.push(NIQQUD_CHARS[nId] as string);
			}
		}
		return out.join("").replaceAll(RAFE, "");
	}
}

// ---------- hebrew_ipa rules ----------

const TAAMIM = /[֑-֯]/g;
const DAGESH = "ּ";
const SHIN_DOT = "ׁ";
const SIN_DOT = "ׂ";
const GERESH = "׳";
const SHEVA = "ְ";
const HATAF_SEGOL = "ֱ";
const HATAF_PATAH = "ֲ";
const HATAF_QAMATS = "ֳ";
const HIRIQ = "ִ";
const TSERE = "ֵ";
const SEGOL = "ֶ";
const PATAH = "ַ";
const QAMATS = "ָ";
const HOLAM = "ֹ";
const QUBUTZ = "ֻ";
const QAMATS_QATAN = "ׇ";
const VOWEL_MARKS = new Set([
	SHEVA,
	HATAF_SEGOL,
	HATAF_PATAH,
	HATAF_QAMATS,
	HIRIQ,
	TSERE,
	SEGOL,
	PATAH,
	QAMATS,
	HOLAM,
	QUBUTZ,
	QAMATS_QATAN,
]);
const ALEF = "א";
const BET = "ב";
const GIMEL = "ג";
const DALET = "ד";
const HE = "ה";
const VAV = "ו";
const ZAYIN = "ז";
const HET = "ח";
const TET = "ט";
const YOD = "י";
const KAF = "כ";
const LAMED = "ל";
const MEM = "מ";
const NUN = "נ";
const SAMEKH = "ס";
const AYIN = "ע";
const PE = "פ";
const TSADI = "צ";
const QOF = "ק";
const RESH = "ר";
const SHIN = "ש";
const TAV = "ת";
const FINAL_FORM_BASE = new Map([
	["ך", KAF],
	["ם", MEM],
	["ן", NUN],
	["ף", PE],
	["ץ", TSADI],
]);
const GERESH_DIGRAPHS = new Map([
	[GIMEL + GERESH, "d͡ʒ"],
	[ZAYIN + GERESH, "ʒ"],
	[TSADI + GERESH, "t͡ʃ"],
]);

interface Glyph {
	base: string;
	marks: string[];
}

function isCombining(ch: string): boolean {
	return /\p{M}/u.test(ch);
}

function iterGlyphs(word: string): Glyph[] {
	const clean = word.normalize("NFC").replace(TAAMIM, "");
	const glyphs: Glyph[] = [];
	for (const ch of clean) {
		if (isCombining(ch)) {
			if (glyphs.length > 0) {
				(glyphs[glyphs.length - 1] as Glyph).marks.push(ch);
			}
		} else {
			glyphs.push({ base: ch, marks: [] });
		}
	}
	return glyphs;
}

function applyGereshDigraphs(glyphs: Glyph[]): Glyph[] {
	const out: Glyph[] = [];
	let i = 0;
	while (i < glyphs.length) {
		const g = glyphs[i] as Glyph;
		const nxt = glyphs[i + 1];
		if (nxt && nxt.base === GERESH && GERESH_DIGRAPHS.has(g.base + GERESH)) {
			out.push({
				base: `<IPA:${GERESH_DIGRAPHS.get(g.base + GERESH)}>`,
				marks: [],
			});
			i += 2;
			continue;
		}
		out.push(g);
		i += 1;
	}
	return out;
}

function mapConsonant(base: string, marks: string[], isFinal: boolean): string {
	const b = FINAL_FORM_BASE.get(base) ?? base;
	if (b === ALEF || b === AYIN) {
		return "<GLT>";
	}
	if (b === HE) {
		if (isFinal && !marks.includes(DAGESH)) {
			return "";
		}
		return "h";
	}
	if (b === YOD) {
		return "j";
	}
	if (b === VAV) {
		return "v";
	}
	if (b === SHIN) {
		if (marks.includes(SHIN_DOT)) {
			return "ʃ";
		}
		if (marks.includes(SIN_DOT)) {
			return "s";
		}
		return "ʃ";
	}
	if (b === BET) {
		return marks.includes(DAGESH) ? "b" : "v";
	}
	if (b === KAF) {
		return marks.includes(DAGESH) ? "k" : "χ";
	}
	if (b === PE) {
		return marks.includes(DAGESH) ? "p" : "f";
	}
	if (b === GIMEL) {
		return "g";
	}
	if (b === DALET) {
		return "d";
	}
	if (b === HET) {
		return "χ";
	}
	if (b === TET) {
		return "t";
	}
	if (b === LAMED) {
		return "l";
	}
	if (b === MEM) {
		return "m";
	}
	if (b === NUN) {
		return "n";
	}
	if (b === SAMEKH) {
		return "s";
	}
	if (b === TSADI) {
		return "t͡s";
	}
	if (b === QOF) {
		return "k";
	}
	if (b === RESH) {
		return "ʁ";
	}
	if (b === TAV) {
		return "t";
	}
	if (b === ZAYIN) {
		return "z";
	}
	return "";
}

function hasVowelMarks(marks: string[]): boolean {
	return marks.some((m) => VOWEL_MARKS.has(m));
}

function isHiriqYod(curr: Glyph, nxt: Glyph | undefined): boolean {
	return (
		curr.marks.includes(HIRIQ) &&
		!!nxt &&
		nxt.base === YOD &&
		!hasVowelMarks(nxt.marks)
	);
}

function isHolamMale(g: Glyph): boolean {
	return g.base === VAV && g.marks.includes(HOLAM) && !g.marks.includes(DAGESH);
}

function isShuruk(curr: Glyph): boolean {
	const nonVowel = [
		HOLAM,
		HIRIQ,
		TSERE,
		SEGOL,
		PATAH,
		QAMATS,
		QUBUTZ,
		QAMATS_QATAN,
		SHEVA,
		HATAF_SEGOL,
		HATAF_PATAH,
		HATAF_QAMATS,
	];
	return (
		curr.base === VAV &&
		curr.marks.includes(DAGESH) &&
		!curr.marks.some((m) => nonVowel.includes(m))
	);
}

function mapBasicVowel(g: Glyph): [string, boolean] {
	if (g.marks.includes(QAMATS_QATAN)) {
		return ["o", true];
	}
	if (g.marks.includes(QUBUTZ)) {
		return ["u", true];
	}
	if (g.marks.includes(HIRIQ)) {
		return ["i", true];
	}
	if (g.marks.includes(TSERE)) {
		return ["e", true];
	}
	if (g.marks.includes(SEGOL)) {
		return ["e", true];
	}
	if (g.marks.includes(PATAH)) {
		return ["a", true];
	}
	if (g.marks.includes(QAMATS)) {
		return ["a", true];
	}
	if (g.marks.includes(HATAF_PATAH)) {
		return ["a", true];
	}
	if (g.marks.includes(HATAF_SEGOL)) {
		return ["e", true];
	}
	if (g.marks.includes(HATAF_QAMATS)) {
		return ["o", true];
	}
	if (g.marks.includes(SHEVA)) {
		return ["ə", false];
	}
	return ["", false];
}

interface HeSegment {
	onset: string[];
	nucleus: string;
	coda: string[];
	dagesh: boolean;
}

function wordToSegments(word: string): HeSegment[] {
	const glyphs = applyGereshDigraphs(iterGlyphs(word));
	const segs: HeSegment[] = [];
	let onset: string[] = [];
	let i = 0;
	while (i < glyphs.length) {
		const g = glyphs[i] as Glyph;
		const nxt = glyphs[i + 1];
		const isFinal = i === glyphs.length - 1;
		if (isShuruk(g)) {
			segs.push({ onset, nucleus: "u", coda: [], dagesh: false });
			onset = [];
			i += 1;
			continue;
		}
		if (isHiriqYod(g, nxt)) {
			const cons = mapConsonant(g.base, g.marks, false);
			if (cons && cons !== "<GLT>") {
				onset.push(cons);
			}
			segs.push({ onset, nucleus: "i", coda: [], dagesh: false });
			onset = [];
			i += 2;
			continue;
		}
		if (isHolamMale(g)) {
			segs.push({ onset, nucleus: "o", coda: [], dagesh: false });
			onset = [];
			i += 1;
			continue;
		}
		const cons = mapConsonant(g.base, g.marks, isFinal);
		const [v, isVoc] = mapBasicVowel(g);
		if (isVoc) {
			if (cons && cons !== "<GLT>") {
				onset.push(cons);
			}
			segs.push({ onset, nucleus: v, coda: [], dagesh: false });
			onset = [];
		} else if (g.marks.includes(SHEVA)) {
			if (cons && cons !== "<GLT>") {
				onset.push(cons);
			}
			segs.push({
				onset,
				nucleus: "ə",
				coda: [],
				dagesh: g.marks.includes(DAGESH),
			});
			onset = [];
		} else if (cons === "<GLT>") {
			onset.push("ʔ");
		} else if (cons) {
			onset.push(cons);
		}
		i += 1;
	}
	if (onset.length > 0 && segs.length > 0) {
		(segs[segs.length - 1] as HeSegment).coda.push(...onset);
	}
	return segs;
}

function resolveShevaAndQamats(segs: HeSegment[]): HeSegment[] {
	let prevSilenced = false;
	for (let i = 0; i < segs.length; i++) {
		const s = segs[i] as HeSegment;
		if (s.nucleus !== "ə") {
			prevSilenced = false;
			continue;
		}
		const dageshChazak = s.dagesh && i > 0;
		const na = i === 0 || dageshChazak || prevSilenced;
		if (na) {
			s.nucleus = "e";
			prevSilenced = false;
		} else {
			if (i - 1 >= 0) {
				(segs[i - 1] as HeSegment).coda.push(...s.onset);
			}
			s.onset = [];
			s.nucleus = "";
			prevSilenced = true;
		}
	}
	const merged: HeSegment[] = [];
	for (const s of segs) {
		if (s.nucleus === "") {
			if (merged.length > 0) {
				(merged[merged.length - 1] as HeSegment).coda.push(...s.onset);
			} else {
				merged.push(s);
			}
			continue;
		}
		merged.push(s);
	}
	return merged;
}

function syllabifyToIpa(segs: HeSegment[]): string {
	let stressIndex = segs.length - 1;
	if (
		segs.length === 2 &&
		(segs[segs.length - 1] as HeSegment).coda.length > 0
	) {
		stressIndex = 0;
	}
	const pieces: string[] = [];
	segs.forEach((s, idx) => {
		const before = s.onset.join("");
		const after = s.coda.join("");
		pieces.push(
			idx === stressIndex
				? `${before}ˈ${s.nucleus}${after}`
				: `${before}${s.nucleus}${after}`,
		);
	});
	return pieces.join("");
}

/** Convert one dotted Hebrew word to IPA. Port of hebrew/hebrew_ipa.py. */
export function hebrewWordToIpa(word: string): string {
	let ipa = syllabifyToIpa(resolveShevaAndQamats(wordToSegments(word)));
	ipa = ipa
		.replace(/ʔ(?=ˈ?[aeiouə])/g, "ʔ")
		.replace(/^ʔ/, "ʔ")
		.replace(/ʔ(?=[^aeiouəˈ]|$)/g, "");
	return ipa.replace(/͡/g, "");
}

/** Convert dotted Hebrew text to space-joined word IPA. Port of hebrew/hebrew_ipa.py. */
export function hebrewToIpa(text: string): string {
	const clean = text.normalize("NFC").replace(TAAMIM, "");
	return clean.split(/\s+/).filter(Boolean).map(hebrewWordToIpa).join(" ");
}

/** Hebrew phonemizer: Nakdimon diacritization plus rule-based IPA. Port of phonemize_hebrew.py. */
export class HebrewPhonemizer {
	private readonly diacritizer: NakdimonDiacritizer;

	constructor(diacritizer: NakdimonDiacritizer) {
		this.diacritizer = diacritizer;
	}

	/** Load a HebrewPhonemizer from a Nakdimon model path or directory. */
	static async load(modelPathOrDir: string): Promise<HebrewPhonemizer> {
		return new HebrewPhonemizer(await NakdimonDiacritizer.load(modelPathOrDir));
	}

	/** Diacritize undotted text when needed, then return IPA as a single character array. */
	async phonemize(text: string): Promise<string[][]> {
		let dotted = text;
		if (!NIQQUD_DETECT.test(text)) {
			dotted = await this.diacritizer.diacritize(text);
		}
		const ipa = hebrewToIpa(dotted);
		if (!ipa) {
			return [];
		}
		return [[...ipa]];
	}
}
