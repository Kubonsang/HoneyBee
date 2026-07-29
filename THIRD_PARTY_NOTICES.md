# Third-party notices

Honey Bee source is licensed under the MIT License. Its current production
dependency graph contains six packages whose package metadata declares MIT.
The principal directly used third-party projects are:

| Project                         | Purpose                            | License |
| ------------------------------- | ---------------------------------- | ------- |
| Zod                             | Runtime schema validation          | MIT     |
| node-pty                        | PTY and Windows ConPTY integration | MIT     |
| xterm.js and `@xterm/addon-fit` | Raw terminal UI and resize support | MIT     |
| Monaco Editor                   | Multiline prompt editor            | MIT     |

Exact versions and transitive dependencies are recorded in `pnpm-lock.yaml`.
`corepack pnpm licenses list --json --prod` is the source of truth for the
production dependency audit.

The extension build places this notice, the Honey Bee license, generated
bundle legal comments when present, and the full license texts for production
dependencies under `apps/vscode-extension/dist`. node-pty's license file also
contains the applicable winpty and Microsoft ConPTY notices and remains beside
its packaged native assets.

Third-party names and trademarks belong to their respective owners. Their
inclusion does not imply endorsement.
