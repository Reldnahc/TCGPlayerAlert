import process from "node:process";
import {
  ManagedLoginProofError,
  runManagedLoginProofOfConcept,
} from "../dist/index.js";

const controller = new globalThis.AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

try {
  await runManagedLoginProofOfConcept({
    signal: controller.signal,
    onStatus: (message) => process.stdout.write(`${message}\n`),
  });
  process.stdout.write(
    "Proof complete. The session was not saved and the temporary Edge profile was removed.\n",
  );
} catch (cause) {
  const message =
    cause instanceof ManagedLoginProofError
      ? cause.message
      : "The managed login proof of concept failed unexpectedly.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
