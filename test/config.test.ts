import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ConfigurationError, parseConfig } from "../src/index.js";

describe("application configuration", () => {
  it("validates the committed dry-run example", async () => {
    const value = JSON.parse(
      await readFile("config/local.example.json", "utf8"),
    ) as unknown;

    const config = parseConfig(value);

    expect(config.version).toBe(1);
    expect(config.dryRun).toBe(true);
    expect(config.rules).toHaveLength(1);
  });

  it("reports multiple actionable configuration issues together", () => {
    expect(() =>
      parseConfig({
        version: 2,
        pollIntervalMinutes: 0,
        actionMaximumAttempts: 0,
        dryRun: "yes",
        provider: {},
        printers: {},
        actions: {},
        rules: [],
      }),
    ).toThrow(ConfigurationError);

    try {
      parseConfig({ version: 2, printers: {}, actions: {}, rules: [] });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).issues.length).toBeGreaterThan(3);
    }
  });

  it("rejects live printing while placeholder printers remain", async () => {
    const value = JSON.parse(
      await readFile("config/local.example.json", "utf8"),
    ) as Record<string, unknown>;
    value.dryRun = false;

    expect(() => parseConfig(value)).toThrow(/Configuration is invalid/u);
  });

  it("rejects unknown label and command placeholders", async () => {
    const value = JSON.parse(
      await readFile("config/local.example.json", "utf8"),
    ) as {
      printers: Record<string, { arguments: string[] }>;
      actions: Record<string, { lines?: string[] }>;
    };
    const printer = value.printers["address-label-printer"];
    const action = value.actions["print-address-label"];
    if (printer === undefined || action === undefined) {
      throw new Error("Synthetic configuration fixture is incomplete.");
    }
    printer.arguments = ["{unknown}"];
    action.lines = ["{secretField}"];

    expect(() => parseConfig(value)).toThrow(ConfigurationError);
  });
});
