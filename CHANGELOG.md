# Changelog

Notable changes for each release. Versions up to 0.12.5 were internal builds and were not published.

## 0.12.6 – 2026-10-22

First public release.

- Released under the MIT License. The About page states the license.
- Added a contributing guide, security policy, code of conduct, issue forms and CI.
- The repository no longer depends on machine-specific paths.

## 0.12.5 – 2026-10-22

- "Unify colours" answers locally, without a model request, when the scope has only one colour. When the unchanged prompt of "Unify colours" or "Explain model" is sent, the scope is counted locally and the counts are attached to the first request.
- The DeepSeek Flash effort descriptions moved into the depth dropdown.
- Rendered views sent to the model are re-encoded as JPEG when that is at least 25% smaller. Comparison metrics are unchanged.
- The system prompt states physical units (1 LDU = 0.4 mm, 1 stud = 8 mm, 1 plate = 3.2 mm).
- Fixed an uncaught error while closing the window. End-to-end tests now fail on any undeclared page error.

## 0.12.4 – 2026-10-21

- "Check and fix" and "Replace with factory parts" run the check locally first and skip the model request when nothing needs fixing.
- The DeepSeek Flash Fast / Balanced / Deep setting takes effect (Fast turns thinking off).
- Opaque reference images are re-encoded as JPEG after downscaling when that is at least 25% smaller.

## 0.12.3 – 2026-10-20

- A status line shows whether the model is still generating. Retries back off and respect the provider's wait headers, and a silent stream is detected by idle time.
- Faster AI write operations on large models.
- Image-to-model plans no longer fail on bounding-box arithmetic: the app derives each component's extent.
- Reference images are downscaled once to the provider's recommended size, so requests with several large images are smaller.

## 0.12.2 – 2026-10-20

- Image-to-model failures show their cause.
- Truncated output, dropped connections, server errors and rate limits are retried within the round.
- Context follows the model's real capacity and is compacted only near the limit. A usage bar and a "New conversation" button were added, and failed rounds are left out of the context.
- Removed the default limits on rounds and operations.

## 0.12.1 – 2026-10-20

- Credential keys no longer live in the cache folder, so clearing the cache can't delete them.
- Opening a `.brkl` project frames the whole model.
- Hardened the first window resize on startup.

## 0.12.0 – 2026-10-19

- AI settings: account sign-in or API key, searchable provider presets and a connection test in one form.
- Fixed colour resolution in build scripts.

## 0.11.0 – 2026-10-19

- Build animation: play the model layer by layer or step by step, choose how parts move and how the camera behaves, and export a 1080p MP4.

## 0.10.0 – 2026-10-18

- AI workbench: 3D review of every AI change, several AI tasks at once, and asking about a selection.
- Script-based building: the AI writes build scripts that the app runs and checks, and image-to-model uses them.

## 0.9.0 – 2026-10-16

- First internal build: parts library with demo factory data, connection snapping and collision checks, submodels, macros, steps, instruction PDFs, BOM and 3D exports, `.io` import and export, crash recovery, an AI assistant with image-to-model and mosaic, and an MCP server for external agents.
