import { describe, expect, it } from "bun:test";
import {
	assertSupportedPhonemeType,
	espeakBridgePhonemize,
	isRawBlock,
	mergeVowelClusters,
	rawBlockToPhonemes,
	splitRawBlocks,
	splitSentences,
	textToPhonemes,
} from "./phonemizer.js";

describe("raw blocks and text", () => {
	it("splits and detects [[blocks]]", () => {
		expect(splitRawBlocks("a [[b c]] d")).toEqual(["a ", "[[b c]]", " d"]);
		expect(isRawBlock("[[x]]")).toBe(true);
		expect(isRawBlock("x")).toBe(false);
		expect(rawBlockToPhonemes("[[a b]]")).toEqual(["a", " ", "b"]);
	});

	it("splits text to NFD codepoints", () => {
		expect(textToPhonemes("é").length).toBeGreaterThanOrEqual(1);
		expect(textToPhonemes("hi")).toEqual(["h", "i"]);
	});

	it("splits sentences keeping terminators", () => {
		expect(splitSentences("Hello world. How are you?")).toEqual([
			{ body: "Hello world", terminator: "." },
			{ body: "How are you", terminator: "?" },
		]);
	});

	it("merges known vowel clusters longest-first", () => {
		const clusters = new Set(["aɪ", "aʊ"]);
		expect(mergeVowelClusters(["a", "ɪ", "x"], clusters)).toEqual(["aɪ", "x"]);
		expect(mergeVowelClusters(["a", "b"], null)).toEqual(["a", "b"]);
	});
});

describe("espeakBridgePhonemize (stubbed bridge)", () => {
	const stub = {
		phonemize: (_voice: string, _text: string) => [
			{ phonemes: "həlˈoʊ", terminator: ",", endOfSentence: false },
			{ phonemes: "wˈɜːld", terminator: ".", endOfSentence: true },
		],
	};

	it("appends terminators and space after comma", () => {
		const sentences = espeakBridgePhonemize(
			"Hello, world.",
			"en-us",
			null,
			stub,
		);
		expect(sentences).toHaveLength(1);
		expect(sentences[0]?.join("")).toBe("həlˈoʊ, wˈɜːld.");
	});

	it("strips (lang) flags", () => {
		const flagStub = {
			phonemize: () => [
				{ phonemes: "a(lang)b", terminator: "", endOfSentence: true },
			],
		};
		expect(
			espeakBridgePhonemize("x", "en-us", null, flagStub)[0]?.join(""),
		).toBe("ab");
	});
});

describe("assertSupportedPhonemeType", () => {
	it("accepts all 7 ported types", () => {
		for (const t of [
			"espeak",
			"text",
			"hebrew",
			"lithuanian",
			"pinyin",
			"thai",
			"japanese",
		]) {
			expect(() => assertSupportedPhonemeType(t)).not.toThrow();
		}
	});

	it("rejects unknown types", () => {
		expect(() => assertSupportedPhonemeType("klingon")).toThrow(
			/not supported/,
		);
	});
});
