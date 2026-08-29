# Contributing to Crosslink

Thanks for helping improve Crosslink. Changes to cryptography, wire formats,
authorization, persistence, and network trust boundaries deserve especially
careful review.

## Development setup

Crosslink requires Node.js 20.19 or newer and npm.

```bash
npm install
npm run check:ci
```

Use the root scripts so every workspace is built and checked consistently.
Add tests for behavioral changes and update public documentation when an API,
protocol, or security property changes.

## Pull requests

- Keep each change focused and explain its user-visible and security impact.
- Do not commit credentials, pairing data, private keys, or generated local state.
- Preserve backward compatibility unless the change is explicitly marked breaking.
- Run `npm run check:ci` before requesting review.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

By contributing, you agree that your contribution is licensed under Apache-2.0.

## Releases

All public packages share one version. Before a release:

1. Update every public package version and every internal `^x.y.z` dependency range together.
2. Move the relevant changelog entries from `Unreleased` to a dated version.
3. Run `npm install` to update `package-lock.json`, then run `npm run check:ci`.
4. Run `npm run release:dry-run`. This builds and dry-runs every public package in dependency order and verifies its tarball entry points.
5. Authenticate to npm with an account authorized for the `@crosslink` scope.
6. Run `npm run release:publish`. It repeats all tarball checks before publishing in dependency order and stops on the first failure.
7. Tag the exact release commit and create release notes from `CHANGELOG.md`.

Never publish an individual dependent package ahead of the version it references.
