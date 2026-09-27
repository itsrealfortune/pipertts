/**
 * Arabic diacritizer (tashkeel, MVP).
 *
 * TypeScript port of piper1-gpl `src/piper/tashkeel/__init__.py`
 * (GPL-3.0-or-later; ported from mush42/libtashkeel).
 * Model + maps are downloaded on demand, see `data.ts`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createRawOrtSession } from "./inference.js";

const CHAR_LIMIT = 12000;
const PAD_SYMBOL = "_";
const NUMERAL_SYMBOL = "#";
const NUMERALS = new Set("0123456789٠١٢٣٤٥٦٧٨٩");
const ARABIC_DIACRITICS = new Set(
	[1618, 1617, 1614, 1615, 1616, 1611, 1612, 1613].map((c) =>
		String.fromCharCode(c),
	),
);
const NORMALIZED_DIAC_MAP: Record<string, string> = {
	"َّ": "َّ",
	"ًّ": "ًّ",
	"ُّ": "ُّ",
	"ٌّ": "ٌّ",
	"ِّ": "ِّ",
	"ٍّ": "ٍّ",
};
const SUKOON = String.fromCharCode(0x652);

interface TashkeelSession {
	run(feeds: {
		charInputs: number[];
		diacInputs: number[];
		inputLength: number;
	}): Promise<{ targetIds: number[]; logits: number[] }>;
}

async function createTashkeelSession(
	modelPath: string,
): Promise<TashkeelSession> {
	const { ort, session } = await createRawOrtSession(modelPath);
	return {
		async run({ charInputs, diacInputs, inputLength }) {
			const feeds: Record<string, unknown> = {
				char_inputs: new ort.Tensor(
					"int64",
					BigInt64Array.from(charInputs.map((id) => BigInt(id))),
					[1, charInputs.length],
				),
				diac_inputs: new ort.Tensor(
					"int64",
					BigInt64Array.from(diacInputs.map((id) => BigInt(id))),
					[1, diacInputs.length],
				),
				input_lengths: new ort.Tensor(
					"int64",
					BigInt64Array.from([BigInt(inputLength)]),
					[1],
				),
			};
			const results = await session.run(feeds);
			const predictions = Array.from(
				(results["predictions"] as { data: ArrayLike<number> }).data,
			).map((v) => v & 0xff);
			const logits = Array.from(
				(results["logits"] as { data: ArrayLike<number> }).data,
			);
			return { targetIds: predictions, logits };
		},
	};
}

export class TashkeelDiacritizer {
	private readonly session: TashkeelSession;
	private readonly inputIdMap: Record<string, number>;
	private readonly idTargetMap: Record<number, string>;
	private readonly targetMetaIds: Set<number>;
	private readonly hintIdMap: Record<string, number>;

	private constructor(
		session: TashkeelSession,
		inputIdMap: Record<string, number>,
		idTargetMap: Record<number, string>,
		targetMetaIds: Set<number>,
		hintIdMap: Record<string, number>,
	) {
		this.session = session;
		this.inputIdMap = inputIdMap;
		this.idTargetMap = idTargetMap;
		this.targetMetaIds = targetMetaIds;
		this.hintIdMap = hintIdMap;
	}

	static async load(modelDir: string): Promise<TashkeelDiacritizer> {
		const readJson = (name: string) =>
			JSON.parse(fs.readFileSync(path.join(modelDir, name), "utf8"));
		const inputIdMap = readJson("input_id_map.json") as Record<string, number>;
		const targetIdMap = readJson("target_id_map.json") as Record<
			string,
			number
		>;
		const hintIdMap = readJson("hint_id_map.json") as Record<string, number>;
		const idTargetMap: Record<number, string> = {};
		for (const [c, i] of Object.entries(targetIdMap)) {
			idTargetMap[i] = c;
		}
		const session = await createTashkeelSession(
			path.join(modelDir, "model.onnx"),
		);
		return new TashkeelDiacritizer(
			session,
			inputIdMap,
			idTargetMap,
			new Set([targetIdMap[PAD_SYMBOL] as number]),
			hintIdMap,
		);
	}

	async diacritize(text: string, taskeenThreshold?: number): Promise<string> {
		const stripped = text.trim();
		if (stripped.length > CHAR_LIMIT) {
			throw new Error(`PiperNative: text length cannot exceed ${CHAR_LIMIT}`);
		}
		const [validText, removedChars] = this.toValidChars(stripped);
		const [inputText, diacritics] = this.extractCharsAndDiacritics(
			validText,
			true,
		);
		const inputIds = [...inputText].map((c) => this.inputIdMap[c] as number);
		const diacIds = diacritics.map((d) => this.hintIdMap[d] as number);
		if (inputIds.length === 0) {
			return text;
		}
		const { targetIds, logits } = await this.session.run({
			charInputs: inputIds,
			diacInputs: diacIds,
			inputLength: inputIds.length,
		});
		const diacOut = targetIds
			.filter((id) => !this.targetMetaIds.has(id))
			.map((id) => this.idTargetMap[id] ?? "");
		if (taskeenThreshold === undefined || taskeenThreshold === null) {
			return this.annotate(stripped, diacOut, removedChars);
		}
		return this.annotateTaskeen(
			stripped,
			diacOut,
			removedChars,
			logits,
			taskeenThreshold,
		);
	}

	private annotate(
		inputText: string,
		diacritics: string[],
		removedChars: Set<string>,
	): string {
		const out: string[] = [];
		let di = 0;
		for (const c of inputText) {
			if (ARABIC_DIACRITICS.has(c)) {
				continue;
			}
			out.push(c);
			if (!removedChars.has(c)) {
				out.push(diacritics[di] ?? "");
				di += 1;
			}
		}
		return out.join("");
	}

	private annotateTaskeen(
		inputText: string,
		diacritics: string[],
		removedChars: Set<string>,
		logits: number[],
		threshold: number,
	): string {
		const out: string[] = [];
		let di = 0;
		for (const c of inputText) {
			if (ARABIC_DIACRITICS.has(c)) {
				continue;
			}
			out.push(c);
			if (!removedChars.has(c)) {
				const diac = diacritics[di] ?? "";
				const logit = logits[di] ?? 0;
				out.push(logit > threshold ? SUKOON : diac);
				di += 1;
			}
		}
		return out.join("");
	}

	private extractCharsAndDiacritics(
		text: string,
		normalizeDiacritics: boolean,
	): [string, string[]] {
		const diacStr = [...ARABIC_DIACRITICS].join("");
		const trimmed = text.replace(new RegExp(`^[${diacStr}]+`), "");
		const cleanChars: string[] = [];
		const diacritics: string[] = [];
		let pending = "";
		for (const c of [...trimmed, " "]) {
			if (ARABIC_DIACRITICS.has(c)) {
				pending += c;
			} else {
				cleanChars.push(c);
				diacritics.push(pending);
				pending = "";
			}
		}
		if (cleanChars.length > 0) {
			cleanChars.pop();
		}
		if (diacritics.length > 0) {
			diacritics.shift();
		}
		if (normalizeDiacritics) {
			for (let i = 0; i < diacritics.length; i++) {
				const d = diacritics[i] as string;
				if (!(d in this.hintIdMap)) {
					diacritics[i] = NORMALIZED_DIAC_MAP[d] ?? "";
				}
			}
		}
		return [cleanChars.join(""), diacritics];
	}

	private toValidChars(text: string): [string, Set<string>] {
		const valid: string[] = [];
		const invalid = new Set<string>();
		for (const c of text) {
			if (c in this.inputIdMap || ARABIC_DIACRITICS.has(c)) {
				valid.push(c);
			} else if (NUMERALS.has(c)) {
				valid.push(NUMERAL_SYMBOL);
			} else {
				invalid.add(c);
			}
		}
		return [valid.join(""), invalid];
	}
}
