# Logo, model names and file entry — 2026-09-12

- Generated a new transparent original logo with built-in imagegen. Preserved the master and exact prompt; client, favicon and desktop assets share its artwork. The client uses a 13 KB 128px PNG, not the full-resolution original. SVG exports are PNG wrappers.
- Removed the independent Files button from the React tree beside Work panel. Work panel → Files loads the workspace root, and existing file references, artifacts and previews use that same pane.
- Default model names now use verified official names in native model metadata, including known previous ColdX defaults. Custom labels, unknown models and all routing/credentials remain unchanged. Desktop composer has room for the full current name; narrow-screen rules remain bounded.

Verification:

- `pnpm test`: 441 passed; `.runtime/brand-model-files-unit-20260912.log`.
- Model, work panel and UI consistency browsers: 3 passed; `.runtime/brand-model-files-browser-20260912.log`.
- Composer, model control and PDF browser checks: 27 passed; `.runtime/brand-model-layout-browser-20260912.log`. Classic-scrollbar PDF resize scenario remained stable for 10 seconds with zero frame commits.
- Independent Chromium review decoded the generated PNG and SVG favicon, preserving transparency.
- Actual ColdX browser: sidebar 24px and home 48px images loaded in light/dark themes; restored the original light setting. Restarted the local backend, then verified `DeepSeek-V4.1-Flash` in the input and model card. Opened Work panel → Files and verified workspace browsing with no standalone header file button.

No paid model generation was needed for UI validation. Desktop icon assets were updated; platform installers were not built in this change.
