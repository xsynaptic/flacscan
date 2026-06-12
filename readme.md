# flacscan

This is a small CLI tool intended for periodic integrity verification for large FLAC collections. Processes one batch per invocation, logs only problems, exits. Designed for unattended scheduling via cron or macOS `launchd` but it can also operate as an interactive utility for initial integration into archival workflows.

If you're a serious digital music collector you will invariably have to deal with files that become corrupted over time. Even if your backup system is effective (on-site and in the cloud) you will still end up in a silent war against bitrot, and if you don't know a file needs to be replaced, you may end up with corrupted backups as well.

To make effective use of this tool you'll want to scan your entire collection, root out corruption, and then setup periodic scans to catch corruption soon after it occurs. The initial scan will probably be painful; you may end up with hundreds of files to recover one way or another, which is why this tool also provides lists and reports to help you get started. Read on for more details.

## Prerequisites

- Node.js 22+
- `flac` on PATH (`brew install flac`)
- `id3v2` on PATH if using `--fix` (`brew install id3v2`)

## Install

```sh
npm install -g flacscan
```

## Config

Copy `flacscan.config.example.yaml` to `~/.flacscan/flacscan.config.yaml` and edit. flacscan looks for `./flacscan.config.yaml` in the working directory first, then falls back to `~/.flacscan/flacscan.config.yaml`. All settings can be overridden via CLI flags.

## Commands

```sh
flacscan                             # print this command list
flacscan scan                        # run one verification batch
flacscan recheck                     # re-verify all known bad files, prune deleted entries
flacscan recover                     # re-encode salvageable corrupt files alongside the originals
flacscan recover recoverable         # filter: critical, recoverable, unknown
flacscan status                      # collection health overview
flacscan report                      # dump all known issues (--output file.txt)
flacscan list                        # file paths to stdout for scripting
flacscan list critical               # filter: critical, recoverable, unknown, unreadable
flacscan list --json                 # structured JSON per issue (combine with a filter)
```

### Flags

Every command accepts:

| Flag                | Default                                                           |
| ------------------- | ----------------------------------------------------------------- |
| `--config <path>`   | `./flacscan.config.yaml`, else `~/.flacscan/flacscan.config.yaml` |
| `--db-path <path>`  | `~/.flacscan/flacscan.db`                                         |
| `--log-path <path>` | `~/.flacscan/flacscan.log`                                        |

`scan` adds:

| Flag                 | Default     |
| -------------------- | ----------- |
| `--directory <path>` | from config |
| `--batch-size <n>`   | 100         |
| `--parallelism <n>`  | 1           |
| `--rescan-days <n>`  | 90          |
| `--fix`              | off         |

`recover` adds:

| Flag                      | Default            |
| ------------------------- | ------------------ |
| `--max-trailing-loss <s>` | 3                  |
| `--min-free-bytes <n>`    | 1073741824 (1 GiB) |
| `--output <path>`         | none               |

`--min-free-bytes` is the free space `recover` keeps on every volume; it aborts before writing anything if any volume would drop below it.

`--fix` strips non-standard ID3 tags (via `id3v2 --delete-all`) when they cause verification failures. If the file passes after stripping, it's marked healthy. Invalid ID3 tags may end up attached to media improperly converted from other formats.

### Exit codes

| Code | Meaning                                   |
| ---- | ----------------------------------------- |
| 0    | Clean run                                 |
| 1    | Corruption detected                       |
| 2    | Tool error (bad config, missing binaries) |

## How it works

Each `flacscan` invocation:

1. Walks configured directories, skipping unmounted/unavailable paths; this is so you can include external drives without needing to concern yourself about whether they're connected at the time of the scan
2. **Discovery** - stats every `.flac` file, caches modified time and size in SQLite; unchanged files are skipped
3. **Verification** - selects a batch of files due for verification (never-verified first, then oldest-first) and runs `flac -t` on each at `nice -n 19` priority
4. Logs corruption, unreadable files, and ID3 issues to an append-only log file

Files are re-verified on a configurable interval. A full sweep of a large collection happens incrementally across many runs.

### File categories

| Category       | Meaning                                                                 |
| -------------- | ----------------------------------------------------------------------- |
| **healthy**    | Passed `flac -t` (full decode + CRC + MD5 verification)                 |
| **corrupt**    | Failed `flac -t`; classified as `critical`, `recoverable`, or `unknown` |
| **unreadable** | File couldn't be stat'd during discovery                                |
| **pending**    | Discovered but not yet verified                                         |

Severity predicts whether `recover` can salvage the file: each corrupt file's length is probed with `metaflac` and run through `recover`'s own accept/reject rule.

- **recoverable** - `recover` can salvage it (damage confined to a short tail)
- **critical** - `recover` can't help (loss too large, or the whole stream decodes); re-acquire
- **unknown** - couldn't probe the file's length (often `metaflac` can't read it either)

The prediction uses `recover_max_trailing_loss_seconds`, so changing that threshold leaves stored severities stale until a re-scan or `flacscan recheck`.

### Recovering files

`flacscan recover` re-encodes the clean leading audio of a corrupt file into `Track [Recovered].flac` next to the original, which is never modified. It writes a file only when the damage is provably confined to the tail, the lost stretch is under `recover_max_trailing_loss_seconds` (default 3, or `--max-trailing-loss`), and the re-encode passes `flac -t`; anything else is skipped and reported. Standard tags and front cover are carried over. Each file is attempted once and the verdict stored, so re-runs skip it. Pass a severity to narrow scope, `--output file.txt` for a per-file report.

### Trade-offs

- **Path-keyed database** - files are tracked by their full path. Renames or moves are treated as a new file + a stale entry. `recheck` prunes stale entries when the old path no longer exists.
- **Batch model** - designed for low, predictable resource usage rather than scanning everything at once. A single run touches at most `batch_size` files.
- **No metadata extraction during discovery** - discovery only checks mtime/size via `stat`, not FLAC headers (artist/title/etc. are read later, only for files that turn up corrupt). This keeps discovery fast but means the tool can't detect files that were silently corrupted without a mtime change (_e.g._, bitrot on a filesystem that doesn't update mtime). The periodic rescan interval mitigates this.
- **Graceful shutdown** - Ctrl+C finishes in-flight workers before exiting. A second Ctrl+C force-quits.

## License

MIT
