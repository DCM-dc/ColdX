# Official model display names

Verified against live DeepSeek documentation on 2026-09-12. The current release
is **DeepSeek-V4.1-Flash**, and **DeepSeek-V4-Pro** remains available. The official
pages use these names without ColdX's capability or compatibility suffixes.
Sources: [First API call](https://api-docs.deepseek.com/zh-cn/) and
[official change log](https://api-docs.deepseek.com/updates/).

| Previous ColdX default | Display name |
| --- | --- |
| DeepSeek V4.1 Flash · Vision | DeepSeek-V4.1-Flash |
| DeepSeek Flash · 兼容名称 | DeepSeek-V4-Flash |
| DeepSeek Flash · Vision 兼容名称 | DeepSeek-V4-Flash-Vision-Exp |
| DeepSeek V4 Pro | DeepSeek-V4-Pro |

The older Flash and experimental Vision entries keep their historical official
names, also documented in the [Vision release](https://api-docs.deepseek.com/news/news260821/).
The current official API routes those older aliases to the new release. ColdX
does not assume that an independently configured provider follows the same
alias routing. This change does not rename model identifiers, switch selections,
or change capabilities.

`lib/profile.mjs` refreshes the product-owned generated model table during each
`ensureProfile()` call, so existing profiles receive the names as well as fresh
profiles. Native user settings can contain their own model array and override
that table; those files remain unchanged.

For an existing catalog with old product labels, `lib/model-names.mjs` provides
a conservative, read-only metadata projection. It recognizes the packaged
model identifiers and only replaces a missing/raw-identifier label or the
exact corresponding old ColdX default. Other user-authored labels, including
labels that contain “Vision”, are preserved. Unrecognized identifiers keep
the provider's original name, or its original identifier when unnamed.

The same pure function is embedded in the existing pinned DeepSeek adapter
patch at `modelInfo()`. Native `listModels()` / model resolution, the Host model
catalog, and `ModelDirectory.groups` consequently carry one name to the native
model dropdown, composer trigger, and ColdX model card. Session selections do
not persist a separate display name. No client-only renaming rule is needed.

Apply and verify from the ColdX project directory:

```sh
pnpm install
node --test test/model-names.test.mjs test/profile.test.mjs
```

Restart the existing ColdX backend through its normal launcher after applying
the native patch: an already-running Node process retains its imported adapter
module. The normal frontend build and reload can be combined with other UI
changes. Desktop staging already copies `lib` and applies the registered native
patches, so it needs no additional packaging entry.

The tests exercise the actual pinned native metadata projection using the
strict desktop patch engine, and guard against drift between its embedded
function and the reviewed source. They also check an existing profile update,
custom labels, unknown models, and unchanged user configuration and routing.
