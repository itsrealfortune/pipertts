/**
 * Phoneme constants + phonemes-to-ids (MVP).
 *
 * Port of `src/piper/const.py` and `src/piper/phoneme_ids.py` from
 * piper1-gpl (GPL-3.0-or-later).
 * https://github.com/OHF-Voice/piper1-gpl
 */

export const PAD = "_";
export const BOS = "^";
export const EOS = "$";

export const DEFAULT_PHONEME_ID_MAP: Record<string, number[]> = {
	_: [0],
	"^": [1],
	$: [2],
	" ": [3],
	"!": [4],
	"'": [5],
	"(": [6],
	")": [7],
	",": [8],
	"-": [9],
	".": [10],
	":": [11],
	";": [12],
	"?": [13],
	a: [14],
	b: [15],
	c: [16],
	d: [17],
	e: [18],
	f: [19],
	h: [20],
	i: [21],
	j: [22],
	k: [23],
	l: [24],
	m: [25],
	n: [26],
	o: [27],
	p: [28],
	q: [29],
	r: [30],
	s: [31],
	t: [32],
	u: [33],
	v: [34],
	w: [35],
	x: [36],
	y: [37],
	z: [38],
	æ: [39],
	ç: [40],
	ð: [41],
	ø: [42],
	ħ: [43],
	ŋ: [44],
	œ: [45],
	ǀ: [46],
	ǁ: [47],
	ǂ: [48],
	ǃ: [49],
	ɐ: [50],
	ɑ: [51],
	ɒ: [52],
	ɓ: [53],
	ɔ: [54],
	ɕ: [55],
	ɖ: [56],
	ɗ: [57],
	ɘ: [58],
	ə: [59],
	ɚ: [60],
	ɛ: [61],
	ɜ: [62],
	ɞ: [63],
	ɟ: [64],
	ɠ: [65],
	ɡ: [66],
	ɢ: [67],
	ɣ: [68],
	ɤ: [69],
	ɥ: [70],
	ɦ: [71],
	ɧ: [72],
	ɨ: [73],
	ɪ: [74],
	ɫ: [75],
	ɬ: [76],
	ɭ: [77],
	ɮ: [78],
	ɯ: [79],
	ɰ: [80],
	ɱ: [81],
	ɲ: [82],
	ɳ: [83],
	ɴ: [84],
	ɵ: [85],
	ɶ: [86],
	ɸ: [87],
	ɹ: [88],
	ɺ: [89],
	ɻ: [90],
	ɽ: [91],
	ɾ: [92],
	ʀ: [93],
	ʁ: [94],
	ʂ: [95],
	ʃ: [96],
	ʄ: [97],
	ʈ: [98],
	ʉ: [99],
	ʊ: [100],
	ʋ: [101],
	ʌ: [102],
	ʍ: [103],
	ʎ: [104],
	ʏ: [105],
	ʐ: [106],
	ʑ: [107],
	ʒ: [108],
	ʔ: [109],
	ʕ: [110],
	ʘ: [111],
	ʙ: [112],
	ʛ: [113],
	ʜ: [114],
	ʝ: [115],
	ʟ: [116],
	ʡ: [117],
	ʢ: [118],
	ʲ: [119],
	ˈ: [120],
	ˌ: [121],
	ː: [122],
	ˑ: [123],
	"˞": [124],
	β: [125],
	θ: [126],
	χ: [127],
	ᵻ: [128],
	ⱱ: [129],
	"0": [130],
	"1": [131],
	"2": [132],
	"3": [133],
	"4": [134],
	"5": [135],
	"6": [136],
	"7": [137],
	"8": [138],
	"9": [139],
	"̧": [140],
	"̃": [141],
	"̪": [142],
	"̯": [143],
	"̩": [144],
	ʰ: [145],
	ˤ: [146],
	ε: [147],
	"↓": [148],
	"#": [149],
	'"': [150],
	"↑": [151],
	"̺": [152],
	"̻": [153],
	g: [154],
	ʦ: [155],
	X: [156],
	"̝": [157],
	"̊": [158],
	ɝ: [159],
	ʷ: [160],
	aɪ: [161],
	aʊ: [162],
	ɔɪ: [163],
	eɪ: [164],
	oʊ: [165],
};

export interface PhonemesToIdsResult {
	ids: number[];
	skipped: string[];
}

/**
 * Mirrors `phonemes_to_ids`: BOS + PAD, then per phoneme (ids + PAD), then EOS.
 * Unknown phonemes are skipped and reported (Python logs a warning).
 */
export function phonemesToIds(
	phonemes: string[],
	idMap?: Record<string, number[]> | null,
): PhonemesToIdsResult {
	const map =
		idMap && Object.keys(idMap).length > 0 ? idMap : DEFAULT_PHONEME_ID_MAP;
	const ids: number[] = [];
	const skipped: string[] = [];

	const bos = map[BOS] ?? DEFAULT_PHONEME_ID_MAP[BOS] ?? [];
	const pad = map[PAD] ?? DEFAULT_PHONEME_ID_MAP[PAD] ?? [];
	const eos = map[EOS] ?? DEFAULT_PHONEME_ID_MAP[EOS] ?? [];

	ids.push(...bos, ...pad);
	for (const phoneme of phonemes) {
		const mapped = map[phoneme];
		if (!mapped) {
			skipped.push(phoneme);
			continue;
		}
		ids.push(...mapped, ...pad);
	}
	ids.push(...eos);

	return { ids, skipped };
}
