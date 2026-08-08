# Third-party notices

Honey Bee source is licensed under the MIT License. The principal directly used third-party projects are:

| Project  | Purpose                            | License |
| -------- | ---------------------------------- | ------- |
| Zod      | Runtime schema validation          | MIT     |
| node-pty | PTY and Windows ConPTY integration | MIT     |

Exact versions and transitive dependencies are recorded in `pnpm-lock.yaml`.
`corepack pnpm licenses list --json --prod` is the source of truth for the
production dependency audit.

node-pty's license file contains the applicable winpty and Microsoft ConPTY notices.

Third-party names and trademarks belong to their respective owners. Their
inclusion does not imply endorsement.
