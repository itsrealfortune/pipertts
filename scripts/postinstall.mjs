#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import {
    access,
    chmod,
    copyFile,
    mkdir,
    mkdtemp,
    readdir,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { arch, platform } from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..");

const PLATFORM_MAP = {
  "linux:x64": {
    dir: "linux-x64",
    binaryName: "piper",
    assetMatchers: [/linux.*(x86_64|amd64).*\\.tar\\.gz$/i],
  },
  "linux:arm64": {
    dir: "linux-arm64",
    binaryName: "piper",
    assetMatchers: [/linux.*(aarch64|arm64).*\\.tar\\.gz$/i],
  },
  "win32:x64": {
    dir: "win32-x64",
    binaryName: "piper.exe",
    assetMatchers: [/windows.*(x86_64|amd64|x64).*\\.zip$/i],
  },
};

function log(message) {
  console.log(`[pipertts postinstall] ${message}`);
}

function fail(message) {
  throw new Error(`[pipertts postinstall] ${message}`);
}

async function fileExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "pipe",
    encoding: "utf8",
    ...options,
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || "no stderr output";
    fail(`command failed: ${command} ${args.join(" ")}\\n${stderr}`);
  }
}

async function findBinaryRecursive(currentDir, targetBinaryName) {
  const children = await readdir(currentDir);

  for (const child of children) {
    const fullPath = join(currentDir, child);
    const info = await stat(fullPath);

    if (info.isDirectory()) {
      const nested = await findBinaryRecursive(fullPath, targetBinaryName);
      if (nested) {
        return nested;
      }
      continue;
    }

    if (child.toLowerCase() === targetBinaryName.toLowerCase()) {
      return fullPath;
    }
  }

  return null;
}

async function fetchRelease(versionTag) {
  const endpoint = versionTag
    ? `https://api.github.com/repos/rhasspy/piper/releases/tags/${encodeURIComponent(versionTag)}`
    : "https://api.github.com/repos/rhasspy/piper/releases/latest";

  const response = await fetch(endpoint, {
    headers: {
      "User-Agent": "pipertts-postinstall",
      Accept: "application/vnd.github+json",
    },
  });

  if (!response.ok) {
    fail(`unable to read Piper releases API (${response.status})`);
  }

  return response.json();
}

function pickAsset(assets, matchers) {
  for (const matcher of matchers) {
    const match = assets.find((asset) => matcher.test(asset.name));
    if (match) {
      return match;
    }
  }

  return null;
}

async function downloadAsset(url, outputPath) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "pipertts-postinstall",
      Accept: "application/octet-stream",
    },
  });

  if (!response.ok || !response.body) {
    fail(`unable to download Piper asset (${response.status})`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(outputPath, bytes);
}

function extractArchive(archivePath, outputDir, isWindowsAsset) {
  if (isWindowsAsset) {
    if (platform === "win32") {
      runCommand("powershell", [
        "-NoProfile",
        "-Command",
        `Expand-Archive -Path '${archivePath}' -DestinationPath '${outputDir}' -Force`,
      ]);
      return;
    }

    runCommand("unzip", ["-o", archivePath, "-d", outputDir]);
    return;
  }

  runCommand("tar", ["-xzf", archivePath, "-C", outputDir]);
}

async function main() {
  if (process.env.PIPERTTS_SKIP_POSTINSTALL === "1") {
    log("skipped because PIPERTTS_SKIP_POSTINSTALL=1");
    return;
  }

  const key = `${platform}:${arch}`;
  const target = PLATFORM_MAP[key];

  if (!target) {
    log(`unsupported platform ${platform}/${arch}, skipping binary download`);
    return;
  }

  const targetDir = join(packageRoot, "bin", target.dir);
  const targetBinaryPath = join(targetDir, target.binaryName);

  if (await fileExists(targetBinaryPath)) {
    log(`binary already exists at ${targetBinaryPath}, skipping`);
    return;
  }

  await mkdir(targetDir, { recursive: true });

  const tempRoot = await mkdtemp(join(tmpdir(), "pipertts-postinstall-"));
  const tempExtractDir = join(tempRoot, "extract");
  await mkdir(tempExtractDir, { recursive: true });

  try {
    const releaseTag = process.env.PIPERTTS_PIPER_VERSION || "";
    log(
      releaseTag
        ? `resolving Piper release ${releaseTag}`
        : "resolving latest Piper release",
    );

    const release = await fetchRelease(releaseTag || undefined);
    const asset = pickAsset(release.assets || [], target.assetMatchers);

    if (!asset) {
      const names = (release.assets || []).map((a) => a.name).join(", ");
      fail(`no compatible asset found for ${key}. Available assets: ${names}`);
    }

    const archivePath = join(tempRoot, asset.name);
    log(`downloading ${asset.name}`);
    await downloadAsset(asset.browser_download_url, archivePath);

    log("extracting archive");
    extractArchive(archivePath, tempExtractDir, asset.name.toLowerCase().endsWith(".zip"));

    const extractedBinary = await findBinaryRecursive(
      tempExtractDir,
      target.binaryName,
    );

    if (!extractedBinary) {
      fail(`unable to find ${target.binaryName} in extracted archive`);
    }

    await copyFile(extractedBinary, targetBinaryPath);
    if (platform !== "win32") {
      await chmod(targetBinaryPath, 0o755);
    }

    log(`installed ${target.binaryName} to ${targetBinaryPath}`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.warn(error.message || String(error));
  console.warn(
    "[pipertts postinstall] continuing install without bundled binary. Set PIPERTTS_SKIP_POSTINSTALL=1 to silence this step.",
  );
  process.exit(0);
});
