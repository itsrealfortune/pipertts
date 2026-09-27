/**
 * Phonemizers (MVP).
 *
 * - `text`: codepoints (NFD), mirrors `PiperVoice.phonemize` TEXT branch.
 * - `raw blocks`: `[[...]]` passthrough, mirrors the ESPEAK branch block handling.
 * - `espeak-cli` (POC): persistent `espeak-ng --ipa` is NOT available, so we
 *   spawn `espeak-ng -v <voice> --ipa -q` per sentence, NFD-split the output,
 *   and re-append the sentence terminator. This approximates
 *   `espeakbridge.get_phonemes` (clause, terminator, end_of_sentence) without
 *   the native binding. A future NAPI addon will replace this with direct
 *   libespeak-ng calls + the process-global voice lock.
 */

import { execFile } from "node:child_process";

const PHONEME_BLOCK_PATTERN = /(\[\[.*?\]\])/;
const SENTENCE_SPLIT_PATTERN = /([^.!?]+[.!?]+["'”’)]*\s*|[^.!?]+\s*$)/g;

/** Splits text on `[[...]]` raw blocks, keeping delimiters. Port of the ESPEAK-branch block handling in `voice.py`. */
export function splitRawBlocks(text: string): string[] {
	return text.split(PHONEME_BLOCK_PATTERN).filter((part) => part.length > 0);
}

/** Returns true when the part is a `[[...]]` raw phoneme block. */
export function isRawBlock(part: string): boolean {
	return part.startsWith("[[") && part.endsWith("]]");
}

/** Strips `[[`/`]]` from a raw block and splits the contents to codepoints. Port of the raw-block branch in `voice.py`. */
export function rawBlockToPhonemes(block: string): string[] {
	return [...block.slice(2, -2).trim()];
}

/** NFD-normalizes text and splits it to codepoints. Port of the TEXT branch of `PiperVoice.phonemize` in `voice.py`. */
export function textToPhonemes(text: string): string[] {
	return [...text.normalize("NFD")];
}

/** Splits text into sentences with body and trailing terminator. Used to approximate `espeakbridge.get_phonemes` clauses. */
export function splitSentences(
	text: string,
): { body: string; terminator: string }[] {
	const matches = text.match(SENTENCE_SPLIT_PATTERN) ?? [text];
	return matches
		.map((m) => m.trim())
		.filter((m) => m.length > 0)
		.map((sentence) => {
			const terminatorMatch = sentence.match(/[.!?;:,"'”’)\]]+$/);
			const terminatorRaw = terminatorMatch?.[0] ?? "";
			const terminator = terminatorRaw.trim();
			const body = terminatorRaw
				? sentence.slice(0, -terminatorRaw.length).trim()
				: sentence;
			return { body, terminator };
		});
}

/** Merges adjacent phonemes into multi-codepoint vowel clusters (longest match). Port of the vowel-cluster handling in `voice.py`. */
export function mergeVowelClusters(
	phones: string[],
	clusters: Set<string> | null,
): string[] {
	if (!clusters || clusters.size === 0) {
		return phones;
	}
	let maxLen = 0;
	for (const cluster of clusters) {
		maxLen = Math.max(maxLen, [...cluster].length);
	}
	const out: string[] = [];
	let i = 0;
	while (i < phones.length) {
		let matched: string | null = null;
		let matchedLen = 0;
		const maxN = Math.min(maxLen, phones.length - i);
		for (let n = maxN; n > 1; n--) {
			const candidate = phones.slice(i, i + n).join("");
			if (clusters.has(candidate)) {
				matched = candidate;
				matchedLen = n;
				break;
			}
		}
		if (matched !== null) {
			out.push(matched);
			i += matchedLen;
		} else {
			out.push((phones[i] as string) ?? "");
			i += 1;
		}
	}
	return out;
}

function runEspeakIpa(
	voice: string,
	text: string,
	espeakBinary = "espeak-ng",
	timeoutMs = 15_000,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			espeakBinary,
			["-v", voice, "--ipa", "-q", text],
			{ timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
			(error, stdout, stderr) => {
				if (error) {
					reject(
						new Error(
							`PiperNative: espeak-ng failed for voice "${voice}": ${(stderr || error.message).trim()}`,
						),
					);
					return;
				}
				resolve(stdout);
			},
		);
		void child;
	});
}

/**
 * POC espeak phonemizer via CLI. Returns phonemes grouped by sentence.
 * Unsupported `phoneme_type` values throw explicitly (full port later).
 */
export async function espeakCliPhonemize(
	text: string,
	espeakVoice: string,
	vowelClusters: Set<string> | null,
	options?: { espeakBinary?: string; timeoutMs?: number },
): Promise<string[][]> {
	const sentences: string[][] = [];
	const parts = splitRawBlocks(text);
	let pending: string[] = [];
	let pendingRaw = false;

	const flushPendingAsSentences = async () => {
		const joined = pending.join("").trim();
		pending = [];
		if (!joined) {
			return;
		}
		for (const { body, terminator } of splitSentences(joined)) {
			if (!body) {
				continue;
			}
			const ipa = await runEspeakIpa(
				espeakVoice,
				body,
				options?.espeakBinary ?? "espeak-ng",
				options?.timeoutMs ?? 15_000,
			);
			// espeak CLI drops punctuation: output is one IPA line per input line.
			const ipaText = ipa
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean)
				.join(" ");
			let phonemes = textToPhonemes(ipaText.replace(/\(.*?\)/g, ""));
			if (terminator) {
				phonemes.push(...textToPhonemes(terminator));
			}
			phonemes = mergeVowelClusters(phonemes, vowelClusters);
			sentences.push(phonemes);
		}
	};

	for (const part of parts) {
		if (isRawBlock(part)) {
			if (sentences.length === 0 && pending.length === 0) {
				sentences.push([]);
			}
			const target = sentences[sentences.length - 1] as string[];
			target.push(...rawBlockToPhonemes(part));
			pendingRaw = true;
			continue;
		}
		pending.push(part);
		if (pendingRaw) {
			// Mirror Python: text following a raw block joins that block's sentence
			// when possible; here we simplify by flushing pending into sentences
			// and merging the first flushed sentence into the raw block sentence.
			const before = sentences.length;
			await flushPendingAsSentences();
			if (sentences.length > before && sentences.length > 1) {
				const first = sentences.splice(before, 1)[0] as string[];
				(sentences[before - 1] as string[]).push(...first);
			}
			pendingRaw = false;
		}
	}
	await flushPendingAsSentences();

	return sentences.filter((s) => s.length > 0);
}

/**
 * Exact port of `EspeakPhonemizer.phonemize` using the N-API bridge.
 * Mirrors `phonemize_espeak.py:31-79`: clause loop, `(lang)` flag strip,
 * terminator append (`,`/`:`/`;` add trailing space), NFD codepoints,
 * vowel-cluster merge per sentence.
 */
export function espeakBridgePhonemize(
	text: string,
	espeakVoice: string,
	vowelClusters: Set<string> | null,
	bridge: {
		phonemize(
			voice: string,
			text: string,
		): {
			phonemes: string;
			terminator: string;
			endOfSentence: boolean;
		}[];
	},
): string[][] {
	const allPhonemes: string[][] = [];
	let sentencePhonemes: string[] = [];

	for (const clause of bridge.phonemize(espeakVoice, text)) {
		let phonemesStr = clause.phonemes.replace(/\(.*?\)/g, "");
		phonemesStr += clause.terminator;
		if (
			clause.terminator === "," ||
			clause.terminator === ":" ||
			clause.terminator === ";"
		) {
			phonemesStr += " ";
		}
		sentencePhonemes.push(...textToPhonemes(phonemesStr));
		if (clause.endOfSentence) {
			sentencePhonemes = mergeVowelClusters(sentencePhonemes, vowelClusters);
			allPhonemes.push(sentencePhonemes);
			sentencePhonemes = [];
		}
	}
	if (sentencePhonemes.length > 0) {
		allPhonemes.push(mergeVowelClusters(sentencePhonemes, vowelClusters));
	}
	return allPhonemes;
}

const SUPPORTED_NATIVE_TYPES = new Set([
	"espeak",
	"text",
	"hebrew",
	"lithuanian",
	"pinyin",
	"thai",
]);

/**
 * Full port of `PiperVoice.phonemize` ESPEAK branch (`voice.py:273-327`):
 * `[[raw]]` block handling + bridge clauses per text part.
 */
export function espeakBridgePhonemizeWithRawBlocks(
	text: string,
	espeakVoice: string,
	vowelClusters: Set<string> | null,
	bridge: {
		phonemize(
			voice: string,
			text: string,
		): {
			phonemes: string;
			terminator: string;
			endOfSentence: boolean;
		}[];
	},
): string[][] {
	const phonemes: string[][] = [];
	const parts = splitRawBlocks(text);
	let prevRawPhonemes = false;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i] as string;
		if (isRawBlock(part)) {
			prevRawPhonemes = true;
			if (phonemes.length === 0) {
				phonemes.push([]);
			}
			const last = phonemes[phonemes.length - 1] as string[];
			if (i > 0 && (parts[i - 1] as string).endsWith(" ")) {
				last.push(" ");
			}
			last.push(...rawBlockToPhonemes(part));
			if (i < parts.length - 1 && (parts[i + 1] as string).startsWith(" ")) {
				last.push(" ");
			}
			continue;
		}

		let partSentences = espeakBridgePhonemize(
			part,
			espeakVoice,
			vowelClusters,
			bridge,
		);
		if (prevRawPhonemes && partSentences.length > 0) {
			(phonemes[phonemes.length - 1] as string[]).push(
				...(partSentences[0] as string[]),
			);
			partSentences = partSentences.slice(1);
		}
		phonemes.push(...partSentences);
		prevRawPhonemes = false;
	}

	if (
		phonemes.length > 0 &&
		(phonemes[phonemes.length - 1] as string[]).length === 0
	) {
		phonemes.pop();
	}
	return phonemes;
}

const UNSUPPORTED_REASONS: Record<string, string> = {
	japanese: "requires OpenJTalk/mecab (native); not portable to pure TS",
};

/** Throws for phoneme types without a native port (japanese needs native models). */
export function assertSupportedPhonemeType(phonemeType: string): void {
	if (!SUPPORTED_NATIVE_TYPES.has(phonemeType)) {
		const reason = UNSUPPORTED_REASONS[phonemeType] ?? "unknown phoneme type";
		throw new Error(
			`PiperNative: phoneme_type "${phonemeType}" is not supported (${reason}).`,
		);
	}
}
