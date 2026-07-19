# Visual asset provenance

The four SVG files in this directory are deterministic, repository-owned source assets created for the GitHub portfolio presentation of Business Agent Kit.

## Sources of truth

- Visual direction, dimensions, palette and accessibility rules: workspace feature `github-open-source-portfolio-polish`, document `02B-UI设计.md`.
- Product wording and architecture: `README.md`, `kit/core/command-manifest.yaml`, `docs/support-matrix.md`, `docs/scaffold-guide.md` and `docs/production-profile.md`.
- Published-version boundary: immutable `v0.3.0` tag plus `CHANGELOG.md`.

## Production method

- Hand-authored SVG using only deterministic XML primitives.
- No generated photography, stock imagery, external fonts, scripts, embedded raster data or network-loaded resources.
- System font fallbacks are declared inside each SVG; GitHub may render the nearest available system face.
- All factual commands and claims shown in a visual also appear as searchable text in `README.md`.

## Reproduction and review

1. Validate XML with `xmllint --noout docs/assets/*.svg`.
2. Confirm each root `width`, `height` and `viewBox` against `visual-manifest.json`.
3. Recalculate SHA-256 digests and compare them with the manifest.
4. Render locally and inspect at full size and narrow width; text must not clip and color must not be the only carrier of meaning.

`social-preview.svg` is the deterministic source for the GitHub repository social preview. The untracked `social-preview.png` is the 1280×640 raster export used for GitHub Settings; its checksum is recorded in `visual-manifest.json`, while the binary stays outside the source-only package. Verify the live repository setting separately.
