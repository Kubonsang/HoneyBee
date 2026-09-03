import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import pngToIco from "png-to-ico";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(appRoot, "resources", "brand", "honeybee.png");
const target = path.join(appRoot, "resources", "brand", "honeybee.ico");
const png = await readFile(source);
if (png.length < 1024) throw new Error("HoneyBee brand PNG is unexpectedly small.");
await writeFile(target, await pngToIco(source));
process.stdout.write(`Built ${target}\n`);
