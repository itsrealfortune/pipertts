/**
 * Lithuanian phonemizer (MVP).
 *
 * TypeScript port of piper1-gpl `src/piper/phonemize_lithuanian.py`
 * (GPL-3.0-or-later). espeak-ng IPA per word + dictionary pitch accents.
 * Dictionary files (CC-BY-4.0) download on demand, see `data.ts`.
 */

import * as fs from "node:fs";
import { espeakBridgePhonemize, espeakCliPhonemize } from "./phonemizer.js";
import { getEspeakBridge } from "./espeak-bridge/loader.js";

export const LT_ESPEAK_VOICE = "lt";
export const LT_ACUTE = "ˈ";
export const LT_CIRCUMFLEX = "ˌ";
export const LT_GRAVE = "ˋ";
const LT_STRESS_MARKS = LT_ACUTE + LT_CIRCUMFLEX + LT_GRAVE;

const LT_IPA_VOWELS = "aeiouɑɐɔɛɪʊæøɘəɜ";
const LT_LENGTH = "ː";
const LT_CONSONANT_MODIFIERS = "ʲʷʰ̩";
const LT_WORD_CLEAN = /[^a-zA-ZąčęėįšųūžĄČĘĖĮŠŲŪŽ0-9]/g;
const LT_KEEP_PUNCT = ".,!?:;";
const LT_SENTENCE_SPLIT = /(?<=[.!?…])\s+/;
const LT_CACHE_LIMIT = 250_000;

const LT_STRIP_DIACRITICS = new Map(
	[..."ąčęėįšųūžĄČĘĖĮŠŲŪŽ"].map((c, i) => [
		c,
		"aceeisuuzACEEISUUZ"[i] as string,
	]),
);
const LT_VOCATIVE_OPENERS = [",", ":", "-", "–", "—"];
const LT_VOCATIVE_CLOSERS = [",", ".", "!", "?", "…"];

export type LtDictionary = Map<string, { groupIndex: number; mark: string }>;
export type LtLetters = Map<string, { ipa: string; prefixes: string[] }>;

function stripLtDiacritics(word: string): string {
	return [...word].map((c) => LT_STRIP_DIACRITICS.get(c) ?? c).join("");
}

export function loadLtDictionary(content: string): LtDictionary {
	const entries: LtDictionary = new Map();
	for (const line of content.split("\n")) {
		if (line.startsWith("#")) {
			continue;
		}
		const parts = line.replace(/\n$/, "").split("\t");
		if (
			(parts.length === 3 || parts.length === 4) &&
			LT_STRESS_MARKS.includes(parts[2] as string)
		) {
			const group = parts.length === 4 ? parts[3] : parts[1];
			entries.set(parts[0] as string, {
				groupIndex: parseInt(group as string, 10),
				mark: parts[2] as string,
			});
		}
	}
	return entries;
}

export function loadLtDictionaryFile(path: string): LtDictionary {
	return loadLtDictionary(fs.readFileSync(path, "utf8"));
}

export function loadLtLetters(content: string): LtLetters {
	const letters: LtLetters = new Map();
	for (const line of content.split("\n")) {
		if (line.startsWith("#")) {
			continue;
		}
		const parts = line.replace(/\n$/, "").split("\t");
		if (parts.length < 2 || !parts[1]) {
			continue;
		}
		const prefixes =
			parts.length > 2 ? (parts[2] as string).split(",").filter(Boolean) : [];
		letters.set((parts[0] as string).toLowerCase(), {
			ipa: parts[1] as string,
			prefixes,
		});
	}
	return letters;
}

export function loadLtLettersFile(path: string): LtLetters {
	return loadLtLetters(fs.readFileSync(path, "utf8"));
}

export function loadLtVocatives(content: string): Set<string> {
	const words = new Set<string>();
	for (const line of content.split("\n")) {
		if (line.startsWith("#")) {
			continue;
		}
		const word = (line.replace(/\n$/, "").split("\t")[0] as string)
			.trim()
			.toLowerCase();
		if (word) {
			words.add(stripLtDiacritics(word));
		}
	}
	return words;
}

export function loadLtVocativesFile(path: string): Set<string> {
	try {
		const stat = fs.statSync(path);
		if (stat.size === 0) {
			return new Set();
		}
	} catch {
		return new Set();
	}
	return loadLtVocatives(fs.readFileSync(path, "utf8"));
}

export function ltLetterIpa(
	word: string,
	nextWord: string,
	letters: LtLetters,
): string | null {
	const entry = letters.get(word.toLowerCase());
	if (!entry) {
		return null;
	}
	for (const prefix of entry.prefixes) {
		if (nextWord.toLowerCase().startsWith(prefix)) {
			return null;
		}
	}
	return entry.ipa;
}

function ltIsVocative(
	words: string[],
	tokens: string[],
	i: number,
	vocatives: Set<string>,
): boolean {
	if (vocatives.size === 0) {
		return false;
	}
	if (!vocatives.has(stripLtDiacritics((words[i] as string).toLowerCase()))) {
		return false;
	}
	const opened =
		i === 0 ||
		LT_VOCATIVE_OPENERS.some((op) =>
			(tokens[i - 1] as string).trimEnd().endsWith(op),
		);
	const closed =
		i === tokens.length - 1 ||
		LT_VOCATIVE_CLOSERS.some((cl) =>
			(tokens[i] as string).trimEnd().endsWith(cl),
		);
	return opened && closed;
}

export function ltIpaVowelGroups(ipa: string): number[] {
	const chars = [...ipa];
	const groups: number[] = [];
	let i = 0;
	while (i < chars.length) {
		if (LT_IPA_VOWELS.includes(chars[i] as string)) {
			const start = i;
			while (
				i + 1 < chars.length &&
				(LT_IPA_VOWELS.includes(chars[i + 1] as string) ||
					chars[i + 1] === LT_LENGTH)
			) {
				i += 1;
			}
			groups.push(start);
		}
		i += 1;
	}
	return groups;
}

export function ltPlaceAccent(
	ipa: string,
	groupIndex: number | null,
	mark: string,
): string {
	const clean = [...ipa].filter((c) => !LT_STRESS_MARKS.includes(c));
	const groups = ltIpaVowelGroups(clean.join(""));
	if (
		groupIndex === null ||
		groupIndex === undefined ||
		groupIndex >= groups.length
	) {
		return ipa;
	}
	let p = groups[groupIndex] as number;
	let i = p - 1;
	while (i >= 0 && LT_CONSONANT_MODIFIERS.includes(clean[i] as string)) {
		i -= 1;
	}
	if (
		i >= 0 &&
		!LT_IPA_VOWELS.includes(clean[i] as string) &&
		clean[i] !== " " &&
		clean[i] !== LT_LENGTH
	) {
		i -= 1;
	}
	let boundary = i + 1;
	const jStop = i;
	let j = jStop;
	while (
		j >= 0 &&
		!LT_IPA_VOWELS.includes(clean[j] as string) &&
		clean[j] !== " "
	) {
		j -= 1;
	}
	if (j < 0 || clean[j] === " ") {
		boundary = j + 1;
	}
	return (
		clean.slice(0, boundary).join("") + mark + clean.slice(boundary).join("")
	);
}

export function ltVocativeAccent(ipa: string): string {
	const accented = ltPlaceAccent(ipa, 0, LT_ACUTE);
	const chars = [...accented];
	const groups = ltIpaVowelGroups(accented);
	if (groups.length === 0) {
		return accented;
	}
	const start = groups[0] as number;
	let end = start;
	while (
		end + 1 < chars.length &&
		(LT_IPA_VOWELS.includes(chars[end + 1] as string) ||
			chars[end + 1] === LT_LENGTH)
	) {
		end += 1;
	}
	if (end !== start) {
		return accented;
	}
	return (
		chars.slice(0, end + 1).join("") +
		LT_LENGTH +
		LT_LENGTH +
		chars.slice(end + 1).join("")
	);
}

export interface LithuanianData {
	dictionary: LtDictionary;
	letters: LtLetters;
	vocatives: Set<string>;
}

export class LithuanianPhonemizer {
	private readonly data: LithuanianData;
	private readonly espeakBinary: string;
	private readonly cache = new Map<string, string>();

	constructor(data: LithuanianData, espeakBinary = "espeak-ng") {
		this.data = data;
		this.espeakBinary = espeakBinary;
	}

	static loadFromDir(dir: string, espeakBinary?: string): LithuanianPhonemizer {
		const read = (name: string) => {
			try {
				return fs.readFileSync(`${dir}/${name}`, "utf8");
			} catch {
				return "";
			}
		};
		return new LithuanianPhonemizer(
			{
				dictionary: loadLtDictionary(read("lt_kirciai.tsv")),
				letters: loadLtLetters(read("lt_raides.tsv")),
				vocatives: loadLtVocatives(read("lt_kreipiniai.tsv")),
			},
			espeakBinary,
		);
	}

	get dictionarySize(): number {
		return this.data.dictionary.size;
	}

	private async espeakWord(word: string): Promise<string> {
		const cached = this.cache.get(word);
		if (cached !== undefined) {
			return cached;
		}
		if (this.cache.size >= LT_CACHE_LIMIT) {
			this.cache.clear();
		}
		const bridge = getEspeakBridge();
		const sentences = bridge
			? espeakBridgePhonemize(word, LT_ESPEAK_VOICE, null, bridge)
			: await espeakCliPhonemize(word, LT_ESPEAK_VOICE, null, {
					espeakBinary: this.espeakBinary,
				});
		let ipa = sentences
			.map((s) => s.join(""))
			.join("")
			.trim()
			.replace(/ʂ/g, "s");
		this.cache.set(word, ipa);
		return ipa;
	}

	async phonemizeWord(word: string): Promise<string> {
		let ipa = await this.espeakWord(word);
		const entry = this.data.dictionary.get(word.toLowerCase());
		if (!entry) {
			if (![...ipa].some((c) => LT_STRESS_MARKS.includes(c))) {
				const groups = ltIpaVowelGroups(ipa);
				if (groups.length > 0) {
					const chars = [...ipa];
					const p = groups[0] as number;
					ipa = chars.slice(0, p).join("") + LT_ACUTE + chars.slice(p).join("");
				}
			}
			return ipa;
		}
		return ltPlaceAccent(ipa, entry.groupIndex, entry.mark);
	}

	async phonemizeSentence(sentence: string): Promise<string> {
		const pieces: string[] = [];
		const tokens = sentence.split(/\s+/).filter(Boolean);
		const words = tokens.map((t) => t.replace(LT_WORD_CLEAN, ""));
		for (let i = 0; i < tokens.length; i++) {
			const word = words[i] as string;
			const punct = [...(tokens[i] as string)]
				.filter((c) => LT_KEEP_PUNCT.includes(c))
				.join("");
			if (!word) {
				if (punct && pieces.length > 0) {
					pieces[pieces.length - 1] += punct;
				}
				continue;
			}
			const override = ltLetterIpa(word, words[i + 1] ?? "", this.data.letters);
			let ipa = override ?? (await this.phonemizeWord(word));
			if (
				override === null &&
				ltIsVocative(
					words as string[],
					tokens as string[],
					i,
					this.data.vocatives,
				)
			) {
				ipa = ltVocativeAccent(ipa);
			}
			pieces.push(ipa + punct);
		}
		return pieces.join(" ");
	}

	async phonemize(text: string): Promise<string[][]> {
		const result: string[][] = [];
		for (const sentence of text.trim().split(LT_SENTENCE_SPLIT)) {
			if (!sentence) {
				continue;
			}
			const ipa = await this.phonemizeSentence(sentence);
			if (ipa) {
				result.push([...ipa.normalize("NFD")]);
			}
		}
		return result;
	}
}
