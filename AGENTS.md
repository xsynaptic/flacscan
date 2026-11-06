# AGENTS.md

- `pnpm check` reports, `pnpm fix` mutates. Run `fix` once after a chunk of work, not after every edit
- `check` is green end to end, so anything it reports is yours
- The operator's global `flacscan` is linked to this checkout, so `pnpm build` replaces the binary their real scans run
- Without `--config`, `--db-path` and `--log-path`, every command uses the operator's real config, database and log in `~/.flacscan/`. Test runs pass all three, pointed at scratch files
- flacscan never deletes a file in the operator's collection. Writing to an original is fine when it is opt-in and the file is re-verified afterwards, as `--fix` does
- UI says `accept`/`accepted`; the DB column and internal helpers say `acknowledged` (`acknowledged_at`, `acknowledgeAllIssues`), and `list --json` emits `acknowledged_at`
- Query the live database through a copy of `flacscan.db` and `flacscan.db-wal`; `immutable=1` skips the WAL
