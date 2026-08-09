import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

const [sourcePath, outputPath] = process.argv.slice(2);
if (sourcePath === undefined || outputPath === undefined) {
  throw new Error(
    "Usage: node scripts/generate-apriltag-family.mjs <tag36h11.c> <output.ts>",
  );
}

const source = await readFile(sourcePath, "utf8");
const codeBlock =
  /static uint64_t codedata\[587\] = \{(?<codes>[\s\S]*?)\n\};/u.exec(source)
    ?.groups?.codes;
if (codeBlock === undefined) {
  throw new Error("The official tag36h11 code table was not found.");
}

const codes = [...codeBlock.matchAll(/0x(?<code>[0-9a-f]+)UL/gu)].map(
  (match) => match.groups?.code,
);
if (codes.length !== 587 || codes.some((code) => code === undefined)) {
  throw new Error("The official tag36h11 code table is incomplete.");
}

const coordinates = Array.from({ length: 36 }, (_, index) => {
  const x = new RegExp(
    `tf->bit_x\\[${String(index)}\\] = (?<value>\\d+);`,
    "u",
  ).exec(source)?.groups?.value;
  const y = new RegExp(
    `tf->bit_y\\[${String(index)}\\] = (?<value>\\d+);`,
    "u",
  ).exec(source)?.groups?.value;
  if (x === undefined || y === undefined) {
    throw new Error(
      `The official tag36h11 bit coordinate ${String(index)} is missing.`,
    );
  }
  return [Number(x), Number(y)];
});

const output = `/**
 * Generated from AprilRobotics/apriltag tag36h11.c at
 * fb2a4096ec5f84b9ec18e501dfa129ffeaaf774e (AprilTag 3.4.3).
 * BSD-2-Clause; see src/web/public/vendor/apriltag-js/LICENSE.
 */

export const TAG36H11_CODES = [
${codes.map((code) => `  0x${code}n,`).join("\n")}
] as const;

export const TAG36H11_BIT_COORDINATES = [
${coordinates.map(([x, y]) => `  [${String(x)}, ${String(y)}],`).join("\n")}
] as const;
`;

await writeFile(outputPath, output, "utf8");
