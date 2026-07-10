# Desktop releases

Desktop releases are reproducible builds from stable tags. The bundled runtime is
Node.js `26.5.0`, downloaded from nodejs.org and verified against the official
`SHASUMS256.txt`.

## Prepare a release

1. Set the same stable version in `package.json`, `src-tauri/Cargo.toml`,
   `src-tauri/Cargo.lock` and `src-tauri/tauri.conf.json`:

   ```sh
   pnpm version:set 1.2.3
   pnpm version:check 1.2.3
   ```

2. Commit the version change, create the tag `v1.2.3` on that commit and push it.

Only tags matching `vX.Y.Z` exactly start the release workflow. The workflow can
also be started manually with an existing stable tag. Before any build starts,
it verifies that all three source versions match the tag.

## Build outputs

The workflow builds four independent targets:

- macOS Apple Silicon (`aarch64-apple-darwin`)
- macOS Intel (`x86_64-apple-darwin`)
- Windows x64 (`x86_64-pc-windows-msvc`)
- Linux x64 (`x86_64-unknown-linux-gnu`)

Each job downloads the Node.js runtime for its own OS and architecture. Bundle
filenames include the Rust target to avoid collisions. Each target also produces
a `SHA256SUMS-<target>.txt` file.

Build outputs are retained as workflow artifacts. A single draft GitHub release
is created only after every target succeeds. Review that draft before publishing
it; rerunning a workflow for a tag that already has a release fails instead of
creating a duplicate.

## Optional signing

Signing is optional. Missing or incomplete secrets produce unsigned installers
without failing the build.

For macOS, configure all of:

- `APPLE_CERTIFICATE`: base64-encoded PKCS#12 certificate
- `APPLE_CERTIFICATE_PASSWORD`: PKCS#12 password
- `APPLE_SIGNING_IDENTITY`: codesigning identity
- `APPLE_ID`: Apple Developer account email
- `APPLE_PASSWORD`: app-specific password
- `APPLE_TEAM_ID`: Apple Developer team identifier

For Windows, configure both:

- `WINDOWS_CERTIFICATE`: base64-encoded PKCS#12 certificate
- `WINDOWS_CERTIFICATE_PASSWORD`: PKCS#12 password

The custom Tauri signing command signs the Windows application executable,
uninstaller, and final installers before checksums are generated; signatures
are timestamped through DigiCert. When all six Apple secrets are present, Tauri
signs, notarizes, and staples the macOS bundles. If only the certificate secrets
are present, it signs without notarizing.

## Future automatic updates

Do not enable Tauri's updater until its signing key exists. Enabling
`createUpdaterArtifacts` without a private key makes release builds fail.

To activate it later:

1. Generate a Tauri updater keypair and commit only the public key.
2. Add `tauri-plugin-updater` to Rust and the updater capability/configuration.
3. Set `bundle.createUpdaterArtifacts` to `true` and point the endpoint to:

   ```text
   https://github.com/midudev/gojs/releases/latest/download/latest.json
   ```

4. Configure both GitHub secrets:
   - `TAURI_SIGNING_PRIVATE_KEY`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
5. Add those secrets to the release build environment and verify that the draft
   contains `latest.json` plus the expected `.sig` files before publishing it.

## Local runtime targets

`pnpm node:fetch` defaults to the current machine. Cross-target selection is
available for release automation:

```sh
NODE_PLATFORM=darwin NODE_ARCH=arm64 pnpm node:fetch
```

`NODE_PLATFORM` accepts `darwin`, `linux` or `win32`.
`NODE_ARCH` accepts `arm64` or `x64`.
