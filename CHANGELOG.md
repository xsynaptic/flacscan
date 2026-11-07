# flacscan

## 4.3.1

### Patch Changes

- An unreadable file is no longer pruned or reset: it keeps its row, acceptance and healthy history, and its unreadable entry clears once it reads again; `--fix` also clears a stale recovery outcome so `recover` offers the file again

## 4.3.0

### Minor Changes

- Flag regressions, files that turn up corrupt after verifying healthy with no content change in between: `REGRESSED` in `scan` and `recheck`, a count in `status` and the `--notify` banner, a tag in `report`, `list regressed`, and `last_healthy_at` in the log and `list --json`; existing healthy rows are backfilled on upgrade. `recheck` now writes the same `corrupt`, ID3 and `unreadable` log events as `scan`

## 4.2.0

### Minor Changes

- Moves now survive case-only renames and reused names; discovery prunes rows for missing files; configured directories match their on-disk case; `scan`, `recheck`, `recover` and `accept` refuse to run concurrently (exit 2); `recover` no longer rounds a rejected loss down to its limit

## 4.1.1

### Patch Changes

- Update runtime dependencies: better-sqlite3 13 (now built on N-API, with prebuilt binaries shipped in the package) and chalk 6

## 4.1.0

### Minor Changes

- Moved or renamed files keep their verification state and acknowledgement when the move is unambiguous, instead of re-alarming as new corruption
- Opt-in `--notify` (or `notify: true` config) sends a macOS notification when a scan finds new corruption; readme gains a launchd/cron scheduling guide

## 4.0.0

### Major Changes

- Removed scan-time severity prediction (critical/recoverable/unknown) and its CLI surface (list/recover severity filters, status breakdown); recover itself now solely decides recoverability at run time

## 3.0.0

### Major Changes

- New `flacscan accept` command and acceptance baseline: exit code 1 now means NEW (not-yet-accepted) corruption; status/report/list/log split new vs accepted issues

## 2.2.2

### Patch Changes

- Formerly-unreadable files rejoin scanning as soon as they stat again; mid-walk ENOENT is no longer recorded as an issue; directory matching no longer catches sibling directories sharing a prefix; list exits 2 on stdout errors

## 2.2.1

### Patch Changes

- Record correct verdicts when flac dies by signal or fails to spawn; never persist an unsuitable recovery verdict during shutdown

## 2.2.0

### Minor Changes

- Harden config handling and exit codes, and speed up discovery.

  - Config files are validated on load (clear errors for malformed values) and `~` is expanded in YAML `directories`.
  - Unexpected crashes now exit 2 (tool error) instead of 1 (corruption), honoring the documented exit-code contract; a post-fix file-stat crash path is guarded.
  - Discovery is faster on large collections: prepared statements are cached per database handle and writes are batched into chunked transactions.
  - Much broader test coverage across discovery, verification, recovery preflight, the command lifecycle, and config validation.
