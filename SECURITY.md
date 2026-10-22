# Security policy

## Supported versions

Only the latest release receives security fixes.

## Reporting a vulnerability

Please report security issues privately, not in a public issue. Use **Report a vulnerability** on the repository's [Security tab](../../security/advisories/new). This opens a private advisory that only the maintainers can see.

Include:

- the Brickloop version and your Windows version;
- what an attacker could do, and under which conditions;
- steps or a file that reproduces the problem.

Leave out real API keys, tokens and personal data, even in reproduction files.

This is a small project maintained in spare time. Reports are read and answered on a best-effort basis. Once a fix is released, the advisory is published with credit to the reporter, unless they prefer otherwise.

## Areas of interest

These are the parts of Brickloop where a security problem would matter most:

- **Stored credentials.** API keys and sign-in tokens are encrypted with Electron `safeStorage` (Windows DPAPI) in the user's data folder.
- **The MCP server.** External agents connect through a named pipe that only the current Windows user can open, or, if the user enables it, a loopback HTTP port that requires a bearer token. Each client has to be approved in the app before it can read or change a project.
- **AI tool calls.** The AI can only change a document through editing commands. When "only change the selection" is on, edits outside the selection are rejected.
- **File import.** `.brkl`, `.io`, LDraw files, `.brklpack` packs and images are parsed from untrusted sources.
- **The Electron setup.** Renderer sandboxing, context isolation and the content security policy are described in [apps/desktop/README.md](apps/desktop/README.md).
