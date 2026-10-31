# Third-party notices

The native build stages these files under `dist/licenses`:

| File | Source |
| --- | --- |
| `dependencies.md` | Vite's bundled Web code license report |
| `openbot-web.txt` | The shared UI project's MIT license |
| `dm-sans.txt`, `dm-mono.txt` | Original OFL files from the installed font packages |
| `fonts.json` | Font package names, versions and notice file names |
| `native-dependencies.md` | Vite's bundled native JavaScript adapter license report |
| `rust.html` | The checked Rust dependency notice collection |

The fixed Web tarball includes its code and font notices. Updating this snapshot
also updates its source patch, provenance hashes and pnpm lock integrity.
The existing code report was already present in the previous fixed tarball.
The earlier inventory overlooked it; this is not a newly added Web code report.

## Rust collection

`vendor/third-party/rust.json` records the pinned cargo-about version, input
hashes, generated HTML hash and package inventory. The current collection has
529 dependencies, 225 collected license texts, and 937 original notice files.
Original files are grouped by hash to avoid repeating identical text.

The collector also reads AUTHORS files, files inside notice directories, and
original license headers when a crate has no separate notice file.
For 32 dependency packages, a reviewed index in
`dev/notices/rust-upstream.json` supplies original files from their recorded
source commits. Fifteen distinct upstream files are saved under
`vendor/third-party/upstream`. Source URLs and SHA-256 hashes are retained.
The collector checks each crate version, repository and VCS commit before
using an upstream record. No branch name or latest-version URL is used.

The two old WinAPI import-library packages do not have VCS metadata.
Their original source license headers are retained without inventing a
source commit. Both r-efi versions retain their original AUTHORS files,
which include license terms and contributors. The selectors crate retains
its MPL source header alongside the full collected license text.

Ordinary builds check the index and every saved upstream file in addition
to the generated HTML. Changing an upstream file fails the integrity check.
Git preserves those original file bytes, including any original line endings.
Adding a dependency with no original notice, source header or reviewed upstream
record stops notice generation instead of silently accepting a generic fallback.

The graph includes build dependencies and all target platforms. It is a
superset of the dependencies in any one app. The application is private in
Cargo and is excluded from the dependency collection. No application license
or public release is implied.

A normal `pnpm build` checks the manifest, lock file, collector configuration,
collector source and generated HTML hashes. It fails if the notices are stale.
The generated collection is stored with app source; ordinary builds do not
install a scanner or fetch notice files.

To check or refresh from the pinned development shell:

```sh
devenv shell -- pnpm notices:check
devenv shell -- cargo install --locked --version 0.9.3 --features cli --root .cache/license-tools cargo-about
devenv shell -- env CARGO_ABOUT=.cache/license-tools/bin/cargo-about pnpm notices:generate
```

Generation uses the locked dependency graph and does not pass `--offline`:
cargo-about may retrieve missing license information from upstream sources.
The collector preserves original local LICENSE, COPYING, NOTICE and copyright
files as well as the generated report. Repository source has LF checkout
rules, and generated HTML normalizes line endings before hashing.

## Review limits

A generated collection does not establish complete release compliance.
Every package in the collected graph now has original notice material from
the package or its recorded source commit. The record keeps the distinction
between local package files and supplied upstream files.
Cargo-about still lists 71 packages using a generic license text at least once;
the original notice material is included alongside those texts. This is a
collection result, not an assertion that all license choices or source
requirements have been approved for every release artifact.

The prior Ubuntu-baseline AppImage already contains 131 system package
copyright files under `usr/share/doc` in its AppDir. Linux system libraries,
AppImage tools, Android framework/plugin dependencies and Apple/Windows runtime
components need target-specific review. This Rust/Web collection does not
replace those records or corresponding source requirements.

The saved APKs and previous Linux packages were not rebuilt by the notice
collection step. Their old artifact hashes and acceptance evidence remain valid
for those old files; new source does not change their recorded contents.

The collector follows cargo-about's
[generation and output documentation](https://embarkstudios.github.io/cargo-about/cli/generate/index.html).
Web code reports use Vite's
[build.license option](https://vite.dev/config/build-options.html#build-license).
