# Changesets

This folder is managed by [changesets](https://github.com/changesets/changesets).

Workflow:

1. Make a user-facing change (a fix, feature, or breaking change). Internal-only work like tests or refactors does not need a changeset.
2. Run `pnpm changeset` and describe the change, picking a semver bump (patch / minor / major). This writes a markdown file under `.changeset/`; commit it alongside your work.
3. When ready to publish, run `pnpm changeset version` to apply the bump and update `CHANGELOG.md`, then commit the result.
4. Run `pnpm release` to check, publish to npm, and push the version commit and tags.

The `access: public` setting in `config.json` ensures `flacscan` publishes publicly.
