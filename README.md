<div align="center">

<img src="apps/desktop/build/icon.svg" width="88" alt="Brickloop icon">

# Brickloop

Design brick models in 3D, or start from a photo and review what the AI builds, part by part.

**English** · [简体中文](README.zh-CN.md)

[![Release](https://img.shields.io/github/v/release/WangARui666/brickloop?style=flat-square&color=ff9a4b)](../../releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-3fb950?style=flat-square)](LICENSE)
![Platform: Windows x64](https://img.shields.io/badge/platform-Windows%20x64-0078D4?style=flat-square&logo=windows)
[![CI](https://img.shields.io/github/actions/workflow/status/WangARui666/brickloop/ci.yml?branch=main&style=flat-square&label=CI)](../../actions/workflows/ci.yml)

<img src="docs/readme/hero-photo-to-model.png" width="100%" alt="Left: a photo of St. Basil's Cathedral in Moscow. Right: the brick model Brickloop built from it, with the onion domes, the central tower and the red base rendered in coloured bricks.">

<sub>Left: St. Basil's Cathedral, photo by Erik Charlton, CC BY 2.0 (cropped). Right: the 1,194-part model that the image-to-model workflow built from it with DeepSeek.</sub>

[**Download**](../../releases/latest) · [Build from source](#build-from-source) · [User guide](docs/user-guide/README.md) (Chinese) · [Contributing](CONTRIBUTING.md)

</div>

---

Brickloop is a Windows desktop app for designing brick models and getting them ready to build. You place parts in a 3D workspace that snaps them to real connection points, check the model for collisions and parts that can't be produced, and export building instructions, a parts list and a BrickLink Studio file.

An AI assistant works on the same model through the same editing commands you use. It can build a first draft from a reference photo or make the changes you describe, and every change it makes shows up in a 3D review where you keep or undo it.

## Highlights

- **Image to model.** The AI plans the model's components, writes a build script, renders the result, compares the silhouette with your photo and revises it, round after round. The result is an editable model, not a picture.
- **Reviewable AI edits.** Added, removed, recoloured and moved parts are marked in the viewport. Keep or undo each change, a group of changes or the whole round.
- **Bring your own model.** 17 provider presets, including DeepSeek, Qwen, Kimi, OpenAI, Anthropic, Gemini and a local Ollama. Most only need an API key. Keys are encrypted with Windows DPAPI and never leave your machine except in requests to the provider you chose.
- **Works with coding agents.** A built-in MCP server lets Claude Code, Codex and similar tools work on the open project after you approve the connection.
- **Checks for production.** Collisions, floating parts, colours the factory doesn't stock, and part/colour combinations it can't make. Each result links to the parts involved.
- **Real outputs.** Instruction PDFs, a BOM as CSV or XLSX, OBJ, DAE and GLB, `.io` files that open in BrickLink Studio, and a 1080p MP4 of the model being built.

## See it build

The build animation can play a model in two orders and export either one as a video.

### Layer by layer

<img src="docs/readme/hero-build.webp" width="100%" alt="The St. Basil's Cathedral model assembling layer by layer from the base plate while the camera circles it">

<sub>The same model, built up one layer at a time (2× speed).</sub>

### Following the instruction steps

<img src="docs/readme/build-steps.webp" width="100%" alt="The St. Basil's Cathedral model assembling component by component: the base, the main body, the galleries, the towers, the central tent and finally the gold cupola">

<sub>The same model with one instruction step per component, built in step order (2× speed). This is the order the instruction PDF uses.</sub>

## Screens

### Workspace

Parts library and macros on the left, the 3D viewport in the middle, and colours, structure, checks and the AI assistant on the right. Alt+drag orbits the camera and the scroll wheel zooms toward the cursor.

<img src="docs/readme/tour-workspace.webp" width="100%" alt="The St. Basil's Cathedral project open in the workspace; the camera orbits and zooms toward the model">

### Build animation

Pick the order, how parts move and how the camera behaves, preview at up to 4×, then export the video.

<img src="docs/readme/tour-animation.webp" width="100%" alt="The build animation dialog plays the model layer by layer at 4× speed and opens the assembly order options">

### Connecting an AI provider

Choose account sign-in or an API key, search the presets, paste the key and test the connection in the same form.

<img src="docs/readme/tour-ai-setup.webp" width="100%" alt="AI settings: choose API key, search for the DeepSeek preset, and the form shows only the key field and a connection test">

### More

<table>
  <tr>
    <td width="50%"><img src="docs/user-guide/images/ai-review-bar.png" alt="A small house with added, removed, recoloured and moved parts marked, and the 3D review bar below"><br>3D review marks added, removed, recoloured and moved parts. Undo one change or the whole round.</td>
    <td width="50%"><img src="docs/user-guide/images/ai-parallel-tasks.png" alt="Two AI tasks running at once, with a preview of a moved porch over the house"><br>Several AI tasks can run at once while you keep editing.</td>
  </tr>
  <tr>
    <td><img src="docs/user-guide/images/image-round-timeline.png" alt="Image-to-model timeline showing part count and silhouette match rising between rounds"><br>Each image-to-model round shows the part count and how closely the silhouette matches the reference.</td>
    <td><img src="docs/user-guide/images/image-task-report.png" alt="Image-to-model report with passed checks and the final silhouette match"><br>The task report lists checks, the estimated view and the final match, and can export to <code>.io</code>.</td>
  </tr>
  <tr>
    <td><img src="docs/user-guide/images/snap-connectors.png" alt="A placement preview next to an existing brick with connection rings visible"><br>Connection points light up and parts snap into place.</td>
    <td><img src="docs/user-guide/images/checks-overview.png" alt="The checks panel with a collision group expanded to show part positions"><br>Check results are grouped by type and linked to the parts.</td>
  </tr>
  <tr>
    <td><img src="docs/user-guide/images/structure-submodels.png" alt="The structure panel showing a two-colour component and shared references"><br>Edit a shared submodel once and every instance updates.</td>
    <td><img src="docs/user-guide/images/steps-editor.png" alt="The steps view with step numbers, part counts and thumbnails"><br>Build steps can be assigned, reordered and stepped through. The instructions use them directly.</td>
  </tr>
  <tr>
    <td><img src="docs/user-guide/images/instructions-export.png" alt="Instruction PDF export settings"><br>Instruction PDFs: page layout, steps per page, parts lists and image resolution.</td>
    <td><img src="docs/user-guide/images/mosaic-preview.png" alt="The mosaic dialog with the source image, a 32×32 preview and part counts"><br>Mosaic turns an image into a flat pattern using only colours the factory stocks.</td>
  </tr>
</table>

## Install

1. Download `Brickloop-<version>-win-x64-setup.exe` (about 270 MB) from the [latest release](../../releases/latest).
2. Compare its SHA-256 with `SHA256SUMS.txt` from the same release, for example with `Get-FileHash -Algorithm SHA256 .\Brickloop-<version>-win-x64-setup.exe` in PowerShell.
3. Run the installer. It isn't code-signed, so Windows may show "Windows protected your PC". After checking where the file came from, choose More info → Run anyway.
4. The first launch builds the parts cache, which takes 10–20 seconds.

To use the AI features, open Settings → AI and add a provider. Brickloop has no account or server of its own; requests go straight from your machine to the provider you configure.

## Build from source

Requires Windows x64, Node.js 22.13 or later and pnpm 10. Caches, temporary files and test data stay in `.devdata` inside the repository.

```powershell
pnpm run setup      # install dependencies and download the UI fonts
pnpm ldraw:fetch    # download the pinned LDraw parts library into library/ldraw
pnpm dev            # start in development mode
pnpm verify         # type check, lint, formatting, locale keys, unit tests
pnpm e2e            # Electron end-to-end tests (Playwright)
pnpm package        # build the Windows installer into dist/
```

Use `pnpm run setup`, not `pnpm setup`: the latter is a built-in pnpm command. [apps/desktop/README.md](apps/desktop/README.md) covers the desktop app's folder layout, process security settings and tests, and each package under `packages/` has its own README.

## Architecture

Every edit goes through one command bus. The UI, keyboard shortcuts, AI tools and MCP tools all end up calling `dispatch(command)`, so undo, the recovery log and the 3D review behave the same no matter where an edit came from.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/readme/architecture-dark-en.svg">
  <img src="docs/readme/architecture-light-en.svg" width="100%" alt="Brickloop architecture: files, AI providers, external agents and the designer connect to the desktop app. The main process handles project files, the parts library, credentials, the AI runtime and the MCP server. The renderer runs the UI, the three.js viewport, DocumentStore and workers. The two talk over typed IPC, and every edit passes through dispatch(command). Below are the shared packages, grouped as AI and automation, editing and display, delivery, and parts and geometry, on top of core and i18n.">
</picture>

Built with Electron, React, three.js and TypeScript. Package dependencies point downward and `core` depends on nothing else. `mcp` reuses the tool definitions from `ai`. Icons are from [Lucide](https://lucide.dev) (ISC).

## Status

- Version 0.x: features and file details may still change before 1.0.
- Windows x64 only.
- The interface defaults to Simplified Chinese and can be switched to English. The user guide is written in Chinese.
- The factory part and colour lists that ship with the app are demo data. Your own lists can be imported as `.brklpack` packs.
- AI results are drafts. An image-to-model run can take 30–60 minutes and the model still needs a designer's pass.

## Contributing

Bug reports, ideas and pull requests are welcome, in English or Chinese. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first. Report security issues privately as described in [SECURITY.md](SECURITY.md). Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

Changes between versions are listed in [CHANGELOG.md](CHANGELOG.md).

## License

Brickloop is released under the [MIT License](LICENSE). Copyright © 2026 Vesperis (孤独翼梦).

Part geometry comes from the [LDraw.org Parts Library](https://library.ldraw.org/). Copyright belongs to the part authors and contributors, and each file is licensed under CC BY 2.0 and/or CC BY 4.0 as it states. LDraw was created by James Jessiman. Licenses for other dependencies and fonts are listed in [docs/third-party.md](docs/third-party.md).

LEGO® is a trademark of the LEGO Group of companies, which does not sponsor, authorize or endorse this project. BrickLink and BrickLink Studio are trademarks of their respective owners. Brickloop is not affiliated with either.
