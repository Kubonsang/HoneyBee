import { fileURLToPath } from "node:url";

export const echoFixtureCliPath = fileURLToPath(new URL("./echo-cli.js", import.meta.url));
