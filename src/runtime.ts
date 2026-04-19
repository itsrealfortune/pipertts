import * as fs from "node:fs";
import * as path from "node:path";

function resolveBinaryFromPath(binaryName: string): string | null {
	const pathEnv = process.env.PATH ?? "";
	const pathDirs = pathEnv.split(path.delimiter).filter(Boolean);

	for (const dir of pathDirs) {
		const candidate = path.join(dir, binaryName);
		if (fs.existsSync(candidate)) {
			return candidate;
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
		if (!fs.existsSync(resolved)) {
			throw new Error(`PiperTTS: executable not found at "${resolved}".`);
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
