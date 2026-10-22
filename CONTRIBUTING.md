# Contributing to Brickloop

Thanks for taking the time to help. Issues and pull requests are welcome in English or Chinese.

## Before you start

- **Bugs:** search the existing issues first. If you open a new one, include the Brickloop version (Help → About), your Windows version, the steps to reproduce and what you expected. Attach the project file or a screenshot if you can. Never paste API keys, tokens or the contents of your settings folder.
- **Larger changes:** open an issue to discuss the idea before writing a lot of code, so we can agree on the approach first.
- **Security issues:** don't open a public issue. Follow [SECURITY.md](SECURITY.md).

## Development setup

You need Windows x64, Node.js 22.13 or later and pnpm 10.

```powershell
pnpm run setup      # install dependencies and download the UI fonts
pnpm ldraw:fetch    # download the pinned LDraw parts library into library/ldraw
pnpm dev            # start the app in development mode
```

Use `pnpm run setup`, not `pnpm setup`, which is a built-in pnpm command. All caches, temporary files and test data go to `.devdata/` in the repository. Nothing should be written to `%APPDATA%` or `%LOCALAPPDATA%` during development or tests.

The repository is a pnpm workspace:

- `apps/desktop` is the Electron app (main process, preload, renderer, end-to-end tests).
- `packages/*` hold the shared libraries, such as `core` (document model and commands), `ldraw`, `viewport`, `connect`, `collide`, `io`, `instructions`, `ai` and `mcp`. Each has a README.
- `library/` holds connection, collider, macro and demo pack data. The LDraw parts themselves are downloaded, not committed.
- `docs/user-guide` is the user guide (Chinese) with its screenshots.

## Making a change

- **Editing goes through commands.** The UI, AI tools and MCP tools all change a document through `dispatch(command)`. New editing features should add or reuse commands so undo, recovery and the AI review keep working.
- **User-visible text goes through i18n keys.** Add every new string to both `packages/i18n/locales/zh-CN` and `packages/i18n/locales/en`. `pnpm i18n:check` reports missing keys.
- **TypeScript is strict.** Run `pnpm format` before committing; ESLint and Prettier settings are in the repository.
- **Dependencies:** add new ones only when needed, and only under permissive licenses (MIT, ISC, Apache-2.0, BSD, MPL-2.0 or similar). Record them in [docs/third-party.md](docs/third-party.md).
- **Assets and data:** only add images, models, parts data or fonts that you made or that come with a license allowing redistribution, and state the source. Don't add files taken from other brick design applications or their installation folders.
- **AI code:** tests must not call real AI services. Use the fake model servers in `apps/desktop/e2e` and the fixtures in `packages/ai/test`.

## Tests

```powershell
pnpm verify         # type check, lint, formatting, locale keys and unit tests
pnpm e2e            # build the test version and run the Electron end-to-end tests
```

- Unit tests use Vitest and live next to each package in `test/`.
- End-to-end tests use Playwright with Electron and live in `apps/desktop/e2e`. Start the app through `launchElectron` and import `test` from `./electron-test`. Any uncaught page error fails the test. If a test deliberately causes one, declare it with `allowPageErrors` and give a reason.
- The full end-to-end run takes about 45 minutes. For a pull request, run `pnpm verify` and the specs that cover your change. Say in the PR which ones you ran.
- Performance tests have fixed thresholds. If one fails, say so in the PR rather than changing the threshold.

## Pull requests

- Keep each pull request to one topic, with a short description of what changed and why.
- Include screenshots or a short recording for UI changes.
- Update the user guide when the change affects how something is used. If you can't write Chinese, say so in the PR and the text can be filled in during review.
- By submitting a pull request you agree that your contribution is licensed under the [MIT License](LICENSE).

## Code of Conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). By taking part, you agree to follow it.
