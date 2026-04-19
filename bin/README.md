# Piper Binaries

On package install, `pipertts` tries to download and place the matching Piper
binary here automatically via `postinstall`.

Place the Piper binary for each platform in the matching subdirectory:

| Directory       | Binary        | Platform         |
|-----------------|---------------|------------------|
| `linux-x64/`    | `piper`       | Linux 64-bit     |
| `linux-arm64/`  | `piper`       | Linux ARM64      |
| `win32-x64/`    | `piper.exe`   | Windows 64-bit   |

Download releases from: https://github.com/rhasspy/piper/releases

The binary must be placed here by you (or via a postinstall script) since
Piper binaries are not redistributed with this package.

Environment variables:

- `PIPERTTS_SKIP_POSTINSTALL=1` to skip automatic download
- `PIPERTTS_PIPER_VERSION=vX.Y.Z` to pin a specific release tag
