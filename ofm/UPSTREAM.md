# Upstream provenance

This directory is a verbatim copy of [Ebony-Vinyl/dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) (MIT licensed).

- Pinned commit: `4ed5955f942e805b815c86d4d70914e72df7c1c1` (branch `main`, cloned 2026-10-11)
- Excluded from the copy: `.git/`, `.github/`
- **Do not edit anything under `ofm/`.** The whole point of this layout is that the upstream tree stays pristine so it can be refreshed by re-copying. All project-specific files live outside this directory.
- The standalone entry point is `ofm/packages/standalone/cli.mjs`; it imports shared code from `ofm/src/` via relative paths and loads `ofm/vendor/channel-pack/qoder-auth-wasm.wasm` at runtime — the full tree must be kept.
