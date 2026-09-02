# Third-party notices

Honey Bee source is licensed under the MIT License. The principal directly used third-party projects are:

| Project             | Purpose                        | License |
| ------------------- | ------------------------------ | ------- |
| Electron            | Windows Desktop runtime        | MIT     |
| React / React DOM   | Desktop renderer               | MIT     |
| Zod                 | Desktop IPC runtime validation | MIT     |
| xterm.js / FitAddon | Workspace terminal renderer    | MIT     |
| node-pty            | PowerShell pseudoterminal      | MIT     |

Exact versions and transitive dependencies are recorded in `pnpm-lock.yaml`.
`corepack pnpm licenses list --json --prod` is the source of truth for the
production dependency audit.

Third-party names and trademarks belong to their respective owners. Their
inclusion does not imply endorsement.
