import * as fs from "node:fs";
import * as path from "node:path";

function isExecutableFile(candidate: string): boolean {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(candidate);
	} catch {
		return false;
	}
	if (!stat.isFile()) {
		return false;
	}
	if (process.platform === "win32") {
		return true;
	}
	try {
		fs.accessSync(candidate, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function windowsCandidates(dir: string, binaryName: string): string[] {
	const hasExtension = path.extname(binaryName) !== "";
	if (hasExtension) {
		return [path.join(dir, binaryName)];
	}
	const pathext = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
		.split(";")
		.map((ext) => ext.trim())
		.filter(Boolean);
	const candidates = [path.join(dir, binaryName)];
	for (const ext of pathext) {
		candidates.push(path.join(dir, `${binaryName}${ext.toLowerCase()}`));
		candidates.push(path.join(dir, `${binaryName}${ext}`));
	}
	return candidates;
}

function resolveBinaryFromPath(binaryName: string): string | null {
	const pathEnv = process.env.PATH ?? "";
	const pathDirs = pathEnv.split(path.delimiter).filter(Boolean);

	for (const dir of pathDirs) {
		const candidates =
			process.platform === "win32"
				? windowsCandidates(dir, binaryName)
				: [path.join(dir, binaryName)];
		for (const candidate of candidates) {
			if (isExecutableFile(candidate)) {
				return candidate;
			}
		}
	}

	return null;
}

/**
 * Resolves an executable from an explicit path or from PATH.
 *
 * @param {string} commandOrPath - Command name (`python3`) or executable path.
 * @returns {string} Absolute executable path.
 * @throws {Error} When the executable cannot be resolved.
 */
export function resolveExecutable(commandOrPath: string): string {
	const hasPathSeparator =
		commandOrPath.includes(path.sep) ||
		(path.sep === "\\" && commandOrPath.includes("/"));

	if (hasPathSeparator || path.isAbsolute(commandOrPath)) {
		const resolved = path.resolve(commandOrPath);
		if (!isExecutableFile(resolved)) {
			if (!fs.existsSync(resolved)) {
				throw new Error(`PiperTTS: executable not found at "${resolved}".`);
			}
			throw new Error(
				`PiperTTS: path "${resolved}" exists but is not an executable file.`,
			);
		}
		return resolved;
	}

	const fromPath = resolveBinaryFromPath(commandOrPath);
	if (!fromPath) {
		throw new Error(
			`PiperTTS: executable "${commandOrPath}" not found in PATH.`,
		);
	}

	return fromPath;
}

/**
 * Resolves the default Piper command.
 *
 * Preferred: `python3 -m piper`
 * Fallback: `python -m piper`
 *
 * @returns {{ command: string; commandPrefixArgs: string[] }} Command and prefix args used to run Piper.
 * @throws {Error} When Python is not available in PATH.
 */
export function resolveSystemCommand(): {
	command: string;
	commandPrefixArgs: string[];
} {
	const pythonCmd =
		resolveBinaryFromPath("python3") || resolveBinaryFromPath("python");

	if (!pythonCmd) {
		throw new Error(
			'PiperTTS: Python not found in PATH. Install Python and the Piper module, or pass "piperBinaryPath" explicitly.',
		);
	}

	return {
		command: pythonCmd,
		commandPrefixArgs: ["-m", "piper"],
	};
}
