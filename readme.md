# flacscan

This is a small CLI tool intended for periodic integrity verification for large FLAC collections. Processes one batch per invocation, logs only problems, exits. Designed for unattended scheduling via cron or macOS `launchd` but it can also operate as an interactive utility for initial integration into archival workflows.

If you're a serious digital music collector you will invariably have to deal with files that become corrupted over time. Even if your backup system is effective (on-site and in the cloud) you will still end up in a silent war against bitrot, and if you don't know a file needs to be replaced, you may end up with corrupted backups as well.

To make effective use of this tool you'll want to scan your entire collection, root out corruption, and then setup periodic scans to catch corruption soon after it occurs. The initial scan will probably be painful; you may end up with hundreds of files to recover one way or another, which is why this tool also provides lists and reports to help you get started. Read on for more details.

## Prerequisites

- Node.js 24+
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
flacscan accept                      # accept current issues; future runs alarm only on new ones
flacscan recover                     # re-encode salvageable corrupt files alongside the originals
flacscan status                      # collection health overview
flacscan report                      # dump all known issues (--output file.txt)
flacscan list                        # file paths to stdout for scripting
flacscan list new                    # filters: new, accepted, regressed, unreadable
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
| `--notify`           | off         |

`recover` adds:

| Flag                      | Default            |
| ------------------------- | ------------------ |
| `--max-trailing-loss <s>` | 3                  |
| `--min-free-bytes <n>`    | 1073741824 (1 GiB) |
| `--output <path>`         | none               |

`--min-free-bytes` is the free space `recover` keeps on every volume; it aborts before writing anything if any volume would drop below it.

`--fix` strips non-standard ID3 tags (via `id3v2 --delete-all`) when they cause verification failures. If the file passes after stripping, it's marked healthy. Invalid ID3 tags may end up attached to media improperly converted from other formats.

### Exit codes

| Code | Meaning                                                               |
| ---- | --------------------------------------------------------------------- |
| 0    | Clean run                                                             |
| 1    | New corruption detected (not yet accepted)                            |
| 2    | Tool error (bad config, missing binaries, another run holds the lock) |

## How it works

Each `flacscan` invocation:

1. Walks configured directories, skipping unmounted/unavailable paths; this is so you can include external drives without needing to concern yourself about whether they're connected at the time of the scan
2. **Discovery** - stats every `.flac` file, caches modified time and size in SQLite; unchanged files are skipped, moves are carried over, and rows for missing files are pruned
3. **Verification** - selects a batch of files due for verification (never-verified first, then oldest-first) and runs `flac -t` on each at `nice -n 19` priority
4. Logs corruption, unreadable files, and ID3 issues to an append-only log file

Files are re-verified on a configurable interval. A full sweep of a large collection happens incrementally across many runs.

### Reaching a green baseline

An initial scan of a large collection often finds standing damage (files that are hard or impossible to replace). Replace what you can, then run `flacscan accept` to mark the rest as known. From then on `scan` and `recheck` exit 0 and stay quiet unless something **new** goes bad; exit 1 means new corruption you haven't accepted yet. An accepted issue reverts to new automatically when a file verifies healthy again or when its content changes (different mtime/size), since changed bytes are a new episode. `status`, `report`, `list`, and the log all split new issues from accepted ones; `list new` and `list accepted` filter each side.

### Regressions

A file that turns up corrupt after verifying healthy, with no content change in between, is a **regression**: its bytes went bad in place. `scan` and `recheck` print it as `REGRESSED` with its last healthy time, `status` counts regressions, `report` tags them `[regressed]`, `list regressed` lists them, and the `--notify` banner counts new ones; the log and `list --json` carry `last_healthy_at`. Like acceptance, the healthy history follows a move and is cleared by a content change (different mtime/size).

### File categories

| Category       | Meaning                                                    |
| -------------- | ---------------------------------------------------------- |
| **healthy**    | Passed `flac -t` (full decode + CRC + MD5 verification)    |
| **corrupt**    | Failed `flac -t`; run `recover` to see what is salvageable |
| **unreadable** | File couldn't be stat'd during discovery                   |
| **pending**    | Discovered but not yet verified                            |

### Recovering files

`flacscan recover` re-encodes the clean leading audio of a corrupt file into `Track [Recovered].flac` next to the original, which is never modified. It writes a file only when the damage is provably confined to the tail, the lost stretch is under `recover_max_trailing_loss_seconds` (default 3, or `--max-trailing-loss`), and the re-encode passes `flac -t`; anything else is skipped and reported. Standard tags and front cover are carried over. Whether a file is salvageable is decided here at recover time, not during a scan. Each file is attempted once and the verdict stored, so re-runs skip it. Pass `--output file.txt` for a per-file report.

### Trade-offs

- **Path-keyed database** - files are tracked by their exact path, and configured directories are matched in their on-disk case. A renamed or moved file keeps its row, verdict and acceptance included, when exactly one row with the same size and mtime has lost its file and no other new path claims it; otherwise it is a new file. Each scan prunes rows for files missing from a directory it walked completely, so a file moved to an offline volume is verified again as new once that volume is back.
- **Batch model** - designed for low, predictable resource usage rather than scanning everything at once. A single run touches at most `batch_size` files.
- **No metadata extraction during discovery** - discovery only checks mtime/size via `stat`, not FLAC headers (artist/title/etc. are read later, only for files that turn up corrupt). This keeps discovery fast but means discovery can't see a file corrupted without an mtime change (_e.g._, bitrot on a filesystem that doesn't update mtime); the periodic rescan catches it and flags it as a [regression](#regressions).
- **Graceful shutdown** - Ctrl+C finishes in-flight workers before exiting. A second Ctrl+C force-quits.
- **One run at a time** - `scan`, `recheck`, `recover` and `accept` hold `<db-path>.lock`; a second one exits 2 naming the running pid, and a lock left by a dead process is taken over.

## Scheduling

Run `flacscan scan` on an interval so corruption surfaces soon after it happens. Each run verifies one batch and exits: exit 0 means nothing new, exit 1 means new corruption you haven't accepted. Pair it with `--notify` to get a macOS banner on that event instead of having to read the log.

`PATH` in the scheduled environment must include the directory holding `flac` (Homebrew installs it at `/opt/homebrew/bin`). The first notification may need approval under System Settings → Notifications for the invoking context (Script Editor / osascript).

### launchd (macOS)

Save this as `~/Library/LaunchAgents/com.flacscan.scan.plist`, replacing the `node` and `flacscan` paths with your own (`which node`, `which flacscan`) and adjusting the interval:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.flacscan.scan</string>
	<key>ProgramArguments</key>
	<array>
		<string>/opt/homebrew/bin/node</string>
		<string>/opt/homebrew/bin/flacscan</string>
		<string>scan</string>
		<string>--notify</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>/opt/homebrew/bin:/usr/bin:/bin</string>
	</dict>
	<key>StartCalendarInterval</key>
	<dict>
		<key>Hour</key>
		<integer>4</integer>
		<key>Minute</key>
		<integer>0</integer>
	</dict>
	<key>StandardOutPath</key>
	<string>/tmp/flacscan.launchd.log</string>
	<key>StandardErrorPath</key>
	<string>/tmp/flacscan.launchd.log</string>
</dict>
</plist>
```

Load it with `launchctl load ~/Library/LaunchAgents/com.flacscan.scan.plist` (`launchctl unload ...` to stop).

### cron

```cron
0 4 * * * /opt/homebrew/bin/flacscan scan --notify
```

Same `PATH` caveat applies; set it in the crontab or wrap the command in a small script that exports it.

## License

MIT
