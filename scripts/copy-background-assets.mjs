import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const source = resolve("src/web/public/vendor/apriltag-js");
const destination = resolve("dist/vendor/apriltag-js");

await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true, force: true });
