# flacscan

Periodic integrity verification for large FLAC collections. Processes one batch per invocation, logs only problems, exits. Designed for unattended scheduling via cron or macOS `launchd`, but it's flexible enough to do a full scan on large collections to initialize the database.

## Prerequisites

- Node.js 22+
- `flac` on PATH (`brew install flac`)
- `id3v2` on PATH if using `--fix` (`brew install id3v2`)

## Install

```sh
npm install -g flacscan
```

Or run from source:

```sh
git clone https://github.com/xysnaptic/flacscan.git
cd flacscan
pnpm install
pnpm dev scan --directory /path/to/music
```

## Config

Copy `flacscan.config.example.yaml` to `~/.flacscan/flacscan.config.yaml` and edit. All settings can be overridden via CLI flags.

## Commands

```sh
flacscan scan                        # run one verification batch
flacscan recheck                     # re-verify all known bad files, prune deleted entries
flacscan status                      # collection health overview
flacscan report                      # dump all known issues (--output file.txt)
flacscan list                        # file paths to stdout for scripting
flacscan list critical               # filter: critical, recoverable, unknown, unreadable
```

### scan flags

| Flag                 | Default                            |
| -------------------- | ---------------------------------- |
| `--directory <path>` | from config                        |
| `--batch-size <n>`   | 100                                |
| `--parallelism <n>`  | 1                                  |
| `--rescan-days <n>`  | 90                                 |
| `--fix`              | off                                |
| `--db-path <path>`   | `~/.flacscan/flacscan.db`          |
| `--log-path <path>`  | `~/.flacscan/flacscan.log`         |
| `--config <path>`    | `~/.flacscan/flacscan.config.yaml` |

`--fix` strips non-standard ID3 tags (via `id3v2 --delete-all`) when they cause verification failures. If the file passes after stripping, it's marked healthy.

### Exit codes

| Code | Meaning                                   |
| ---- | ----------------------------------------- |
| 0    | Clean run                                 |
| 1    | Corruption detected                       |
| 2    | Tool error (bad config, missing binaries) |

## How it works

Each `flacscan scan` invocation:

1. Walks configured directories, skipping unmounted/unavailable paths
2. **Discovery** — stats every `.flac` file, caches mtime + size in SQLite. Unchanged files (same mtime and size) are skipped
3. **Verification** — selects a batch of files due for verification (never-verified first, then oldest-first) and runs `flac -t` on each at `nice -n 19` priority
4. Logs corruption, unreadable files, and ID3 issues to an append-only log file

Files are re-verified on a configurable interval. A full sweep of a large collection happens incrementally across many runs.

### File categories

| Category       | Meaning                                                                 |
| -------------- | ----------------------------------------------------------------------- |
| **healthy**    | Passed `flac -t` (full decode + CRC + MD5 verification)                 |
| **corrupt**    | Failed `flac -t`; classified as `critical`, `recoverable`, or `unknown` |
| **unreadable** | File couldn't be stat'd during discovery                                |
| **pending**    | Discovered but not yet verified                                         |

Corruption severity is classified by parsing `flac -t` stderr:

- **critical** — structural damage (truncation, unparseable stream, EOF errors, LOST_SYNC + ABORTED)
- **recoverable** — localized frame damage (CRC mismatch, MD5 mismatch, LOST_SYNC + END_OF_STREAM)
- **unknown** — unrecognized error pattern

### Trade-offs

- **Path-keyed database** — files are tracked by their full path. Renames or moves are treated as a new file + a stale entry. `recheck` prunes stale entries when the old path no longer exists.
- **Batch model** — designed for low, predictable resource usage rather than scanning everything at once. A single run touches at most `batch_size` files.
- **No metadata extraction** — discovery only checks mtime/size via `stat`, not FLAC headers. This keeps discovery fast but means the tool can't detect files that were silently corrupted without a mtime change (e.g., bit rot on a filesystem that doesn't update mtime). The periodic rescan interval mitigates this.
- **Graceful shutdown** — Ctrl+C finishes in-flight workers before exiting. A second Ctrl+C force-quits.

## Development

```sh
pnpm dev scan --directory ./samples
pnpm build
pnpm test
pnpm check-types
pnpm lint
```

## License

MIT
