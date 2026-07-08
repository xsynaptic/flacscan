# flacscan

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
