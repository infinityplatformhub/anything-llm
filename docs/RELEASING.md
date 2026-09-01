# Releasing ApproofWorkspace

## Cut a release

1. Update release notes and verify CI on `approof/main`.
2. Choose a Semantic Versioning tag. Stable releases use `vMAJOR.MINOR.PATCH`; beta releases use `vMAJOR.MINOR.PATCH-beta.N`.
3. Create and push the annotated tag:

   ```bash
   git checkout approof/main
   git pull --ff-only
   git tag -a v1.2.3 -m "ApproofWorkspace v1.2.3"
   git push origin v1.2.3
   ```

Tag push runs `.github/workflows/release.yml`, builds `docker/Dockerfile`, and publishes to `ghcr.io/<owner>/<repository>`.

## Channels and tags

- Stable tag `v1.2.3` publishes image tags `1.2.3`, `1.2`, and `stable`.
- Beta tag `v1.3.0-beta.1` publishes image tags `1.3.0-beta.1`, `1.3`, and `beta`.
- `stable` and `beta` are moving channel tags. Do not use them when reproducible deployment is required.

## Customer pinning

Pin exact immutable versions in production:

```yaml
image: ghcr.io/<owner>/<repository>:1.2.3
```

Use `:stable` or `:beta` only for environments that intentionally follow a channel. For strongest reproducibility, replace tag with image digest emitted by release workflow.

## Required Node version

Development, regression tests, and release CI use Node.js 22, pinned by `.nvmrc` and workflow configuration. Verify locally with:

```bash
nvm use
cd server
yarn install --frozen-lockfile
yarn test
```
