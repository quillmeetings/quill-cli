# Releasing

Quill CLI publishes to npm as `@quillmeetings/cli`.

## Prerequisites

- npm account with publish access to the `@quillmeetings` scope.
- Node 20+.
- Clean working tree except intentional release changes.

## Release

```bash
npm run check
npm test
npm pack --dry-run
npm publish --access public
```

For later releases, run `npm version patch`, `npm version minor`, or `npm version major` before publishing when the change warrants it.

## Verify

From a clean directory:

```bash
npx @quillmeetings/cli --help
npx @quillmeetings/cli doctor
bunx @quillmeetings/cli --help
```

For the first release, create and push the `v0.1.0` git tag after verification.
