import { describe, expect, it } from "bun:test";
import {
	BertWordPieceTokenizer,
	chinesePhonemesToIds,
	compareCodepoints,
	normalizeG2pwSyllable,
	splitInitialFinalTone,
	splitZhSentences,
	wordizeAndMap,
	zhNumbersToWords,
	zhNumberToWords,
} from "./chinese.js";
import { hebrewToIpa, hebrewWordToIpa } from "./hebrew.js";
import {
	jaExpandNumbers,
	jaNumberToKatakana,
	katakanaToMorae,
	moraeToPhonemes,
	splitJaSentences,
} from "./japanese.js";
import {
	loadLtDictionary,
	ltIpaVowelGroups,
	ltPlaceAccent,
	ltVocativeAccent,
} from "./lithuanian.js";
import { thNumbersToWords, thNumberToWords } from "./thai.js";

describe("chinese tables", () => {
	it("splits initial/final/tone", () => {
		expect(splitInitialFinalTone("hang2")).toEqual(["h", "ang", "2"]);
		expect(splitInitialFinalTone("ai3")).toEqual(["", "ai", "3"]);
		expect(splitInitialFinalTone("bogus")).toEqual(["", "", null]);
	});

	it("normalizes ü-family to v", () => {
		expect(normalizeG2pwSyllable("nü3")).toBe("nv3");
		expect(normalizeG2pwSyllable("bei3")).toBe("bei3");
		expect(normalizeG2pwSyllable("???")).toBe("???");
	});

	it("pads ids after group-end phonemes", () => {
		const { ids, skipped } = chinesePhonemesToIds(["b", "ei", "3", "。"]);
		expect(skipped).toEqual([]);
		// BOS + b ei 3 PAD + 。 PAD + EOS
		expect(ids[0]).toBe(1);
		expect(ids[ids.length - 1]).toBe(2);
		expect(ids.filter((v) => v === 0).length).toBe(2);
	});

	it("sorts by codepoint, not UTF-16", () => {
		expect(compareCodepoints("一", "𠀀")).toBeLessThan(0);
		expect(compareCodepoints("￿", "𐀀")).toBeLessThan(0);
	});

	it("wordizes ascii runs and single chars", () => {
		const { words, word2text } = wordizeAndMap("Hi 你好");
		expect(words).toEqual(["Hi", "你", "好"]);
		expect(word2text).toEqual([
			[0, 2],
			[3, 4],
			[4, 5],
		]);
	});
});

describe("chinese numbers (RBNF-identical)", () => {
	const cases: [string, string][] = [
		["0", "〇"],
		["10", "十"],
		["12", "十二"],
		["101", "一百〇一"],
		["200", "二百"],
		["10000", "一万"],
		["123456789", "一亿二千三百四十五万六千七百八十九"],
		["3.14", "三点一四"],
		["-7", "负七"],
	];
	for (const [input, expected] of cases) {
		it(`${input} -> ${expected}`, () => {
			expect(zhNumberToWords(input)).toBe(expected);
		});
	}

	it("expands temps and percents", () => {
		expect(zhNumbersToWords("-7°C")).toBe("零下七度");
		expect(zhNumbersToWords("77%")).toBe("百分之七十七");
	});
});

describe("splitZhSentences", () => {
	it("splits CJK and ASCII terminators", () => {
		expect(splitZhSentences("你好世界！今天天气怎么样？很不错。")).toEqual([
			"你好世界！",
			"今天天气怎么样？",
			"很不错。",
		]);
		expect(splitZhSentences("Hello world. Ni hao.")).toEqual([
			"Hello world.",
			"Ni hao.",
		]);
	});

	it("holds abbreviations and ellipsis", () => {
		expect(splitZhSentences("Mr. Smith came。")).toEqual(["Mr. Smith came。"]);
		expect(splitZhSentences("Dr. Zhang... arrived。")).toEqual([
			"Dr. Zhang... arrived。",
		]);
	});
});

describe("BertWordPieceTokenizer", () => {
	it("tokenizes with longest-match and ## continuations", () => {
		const tok = new BertWordPieceTokenizer([
			"[UNK]",
			"hello",
			"##world",
			"##s",
		]);
		expect(tok.tokenizeWord("helloworlds")).toEqual([
			"hello",
			"##world",
			"##s",
		]);
		expect(tok.tokenizeWord("zzz")).toEqual(["[UNK]"]);
		expect(tok.convertTokensToIds(["hello", "[UNK]"])).toEqual([1, 0]);
	});
});

describe("thai numbers (RBNF-identical)", () => {
	const cases: [string, string][] = [
		["0", "ศูนย์"],
		["11", "สิบ เอ็ด"],
		["21", "ยี่ สิบ เอ็ด"],
		["101", "หนึ่ง ร้อย หนึ่ง"],
		["1250", "หนึ่ง พัน สอง ร้อย ห้า สิบ"],
		["1000001", "หนึ่ง ล้าน หนึ่ง"],
		["1000000000", "หนึ่ง พัน ล้าน"],
		["3.14", "สาม จุด หนึ่งสี่"],
		["-7", "ลบ เจ็ด"],
	];
	for (const [input, expected] of cases) {
		it(`${input} -> ${expected}`, () => {
			expect(thNumberToWords(input)).toBe(expected);
		});
	}

	it("expands baht and percent", () => {
		expect(thNumbersToWords("฿1250")).toBe("หนึ่ง พัน สอง ร้อย ห้า สิบ บาท");
		expect(thNumbersToWords("50%")).toBe("ห้า สิบ เปอร์เซ็นต์");
	});
});

describe("japanese morae engine", () => {
	it("maps basic kana", () => {
		expect(moraeToPhonemes(katakanaToMorae("コンニチワ"))).toEqual([
			"k",
			"o",
			"ɴ",
			"n",
			"i",
			"t",
			"ɕ",
			"i",
			"w",
			"a",
		]);
	});

	it("handles palatalized morae, geminates, long vowels", () => {
		expect(moraeToPhonemes(katakanaToMorae("キャッシュ"))).toEqual([
			"k",
			"ʲ",
			"a",
			"ʔ",
			"ɕ",
			"ɯ",
		]);
		expect(moraeToPhonemes(katakanaToMorae("ガッコウ"))).toEqual([
			"ɡ",
			"a",
			"ʔ",
			"k",
			"o",
			"ɯ",
		]);
	});

	it("reads Sino-Japanese numerals with rendaku", () => {
		expect(jaNumberToKatakana("123")).toBe("ヒャクニジュウサン");
		expect(jaNumberToKatakana("300")).toBe("サンビャク");
		expect(jaNumberToKatakana("8000")).toBe("ハッセン");
		expect(jaNumberToKatakana("3.14")).toBe("サンテンイチシ");
	});

	it("expands digit runs in text", () => {
		expect(jaExpandNumbers("123円")).toBe("ヒャクニジュウサン円");
	});

	it("splits sentences with decimal guard", () => {
		expect(
			splitJaSentences("今日は良い天気です。これは本ですか？1.5倍です。"),
		).toEqual(["今日は良い天気です。", "これは本ですか？", "1.5倍です。"]);
	});
});

describe("hebrew rules (dotted input, no model)", () => {
	it("converts diacritized words", () => {
		expect(hebrewToIpa("שָׁלוֹם עוֹלָם")).toBe("ʃˈalom ʔˈolam");
		expect(hebrewWordToIpa("בְּרֵאשִׁית")).toBe("beʁeʃˈit");
	});
});

describe("lithuanian accent logic", () => {
	it("finds vowel groups", () => {
		expect(ltIpaVowelGroups("labas").length).toBeGreaterThan(0);
	});

	it("loads the TSV dictionary format", () => {
		const dict = loadLtDictionary(
			"abariaus\t1\tˌ\ndaug\t0\tˈ\t0\n# comment\nbadline\n",
		);
		expect(dict.get("abariaus")).toEqual({ groupIndex: 1, mark: "ˌ" });
		expect(dict.get("daug")).toEqual({ groupIndex: 0, mark: "ˈ" });
		expect(dict.has("badline")).toBe(false);
	});

	it("places and moves accents", () => {
		// monosyllable-style: acute before first vowel group
		expect(ltPlaceAccent("mama", 0, "ˈ")).toBe("ˈmama");
		// out-of-range index keeps input
		expect(ltPlaceAccent("mama", 9, "ˈ")).toBe("mama");
	});

	it("accents vocatives on the first syllable", () => {
		expect(ltVocativeAccent("mama")).toBe("ˈmaːːma");
	});
});
