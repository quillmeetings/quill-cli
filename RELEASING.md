# Releasing

Quill CLI publishes to npm as `@quillmeetings/cli`.

## Prerequisites

- npm trusted publishing configured for `@quillmeetings/cli`:
  - repository: `quillmeetings/quill-cli`
  - workflow: `.github/workflows/publish-npm.yml`
  - environment: `npm-release`
- Node 20+.
- Clean working tree except intentional release changes.

## Release

```bash
npm run check
npm test
npm pack --dry-run
npm version patch
git push origin main
git push origin v<version>
```

Use `npm version minor` or `npm version major` instead of `patch` when the change warrants it.

Pushing the tag starts the GitHub Actions publish workflow. The `npm-release` environment should require approval before publishing.

For emergency local publish only:

```bash
npm publish --access public --otp <code>
```

## Verify

From a clean directory:

```bash
npx @quillmeetings/cli --help
npx @quillmeetings/cli doctor
bunx @quillmeetings/cli --help
```
