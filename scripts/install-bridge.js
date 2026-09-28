/**
 * Optional espeak-ng bridge installer.
 *
 * npm auto-runs `node-gyp rebuild` for any package shipping a root
 * `binding.gyp` without an explicit `install` script - which hard-fails on
 * machines without `libespeak-ng-dev`. The bridge is optional (the loader
 * falls back to the `espeak-ng` CLI), so this script tries in order:
 * prebuilt binary already present → build from source → warn and continue.
 * It always exits 0 unless `--strict` is passed.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const strict = process.argv.includes("--strict");

function prebuildPresent() {
	const dir = path.join(root, "prebuilds", `${process.platform}-${process.arch}`);
	for (const name of ["espeak_bridge.napi.node", "espeak_bridge.node"]) {
		try {
			if (fs.statSync(path.join(dir, name)).isFile()) {
				return true;
			}
		} catch {
			// try next
		}
	}
	return false;
}

function tryBuild() {
	execSync("node-gyp rebuild", { cwd: root, stdio: "pipe", timeout: 300_000 });
	const built = path.join(root, "build", "Release", "espeak_bridge.node");
	if (!fs.existsSync(built)) {
		throw new Error("node-gyp reported success but no binary was produced");
	}
}

try {
	if (prebuildPresent()) {
		console.log("[pipertts] espeak bridge prebuild found, skipping compilation.");
	} else {
		tryBuild();
		console.log("[pipertts] espeak bridge compiled successfully.");
	}
} catch (error) {
	const hint =
		"Install libespeak-ng-dev (apt/brew/choco) and run `npm run build:espeak-bridge`, " +
		"or rely on the espeak-ng CLI fallback.";
	if (strict) {
		console.error(`[pipertts] espeak bridge build failed: ${(error instanceof Error ? error.message : error).toString().slice(0, 300)}`);
		process.exit(1);
	}
	console.warn(`[pipertts] optional espeak bridge not built (${(error instanceof Error ? error.message : error).toString().split("\n")[0]}). ${hint}`);
}
