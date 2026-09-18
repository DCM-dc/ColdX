# Superpowers in ColdX

This directory vendors the original Markdown skills and their Markdown reference
resources from [obra/superpowers](https://github.com/obra/superpowers), release
`6.3.0`, commit `b36e0829c6d0140e93cfef2ca599b1b07d4a7797`.

The 40 upstream files are unchanged. `manifest.json` records their byte lengths,
SHA-256 digests and Git blob IDs. The upstream [MIT license](./LICENSE), including
Jesse Vincent's copyright notice, applies to those files. This README and the
manifest are ColdX distribution metadata.

ColdX supplies the platform adapter in `plugin/superpowers-adapter.mjs` and loads
the skills through agent-scoped native DSH skill providers. No upstream startup
scripts, npm hooks, host integrations or visual-companion executables are run or
included. Where optional scripts are referenced by an original skill, the ColdX
adapter explicitly directs the model to available native tools instead.

Skills are disabled by default. GitHub updates are downloaded as separate,
validated candidates and require the user's explicit **装载更新** action. The
bundled directory is never rewritten by the updater.
