# Changesets

This folder holds [changesets](https://github.com/changesets/changesets): small markdown
files describing user-facing changes and the version bump they warrant.

Add one for every user-facing change:

```bash
pnpm changeset
```

Commit the generated file with your PR. On merge to `main`, the release workflow opens (or
updates) a **Version Packages** PR that consumes the pending changesets, bumps versions and
writes `CHANGELOG.md` files. Merging that PR publishes to npm.

All `@collabnode/*` packages and `collabnode` are versioned in lockstep (`fixed` in
`config.json`), so one changeset moves the whole suite to the same version.
