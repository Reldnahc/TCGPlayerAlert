import { describe, expect, it } from "vitest";
import {
  MarketplaceValidationError,
  orderRefKey,
  parseConnectionId,
  parseOrderRefKey,
  parseProviderId,
  parseProviderOrderRef,
  parseRemoteId,
  sameOrderRef,
} from "../src/marketplaces/identity.js";

describe("marketplace identity", () => {
  it("round-trips a qualified Unicode remote order ID canonically", () => {
    const ref = {
      connectionId: "example-store-2",
      remoteId: "order/α beta?100%",
    };

    const key = orderRefKey(ref);

    expect(key).toBe("example-store-2/order%2F%CE%B1%20beta%3F100%25");
    expect(parseOrderRefKey(key)).toEqual(ref);
    expect(sameOrderRef(parseOrderRefKey(key), ref)).toBe(true);
  });

  it.each([
    "",
    "UPPERCASE",
    "starts_with_symbol",
    "two--bad?",
    `a${"b".repeat(64)}`,
  ])("rejects an invalid connection ID: %s", (value) => {
    expect(() => parseConnectionId(value)).toThrow(MarketplaceValidationError);
  });

  it("validates provider IDs as open slugs rather than a closed union", () => {
    expect(parseProviderId("third-marketplace")).toBe("third-marketplace");
    expect(() => parseProviderId("ThirdMarketplace")).toThrow(
      MarketplaceValidationError,
    );
  });

  it.each(["", "   ", "remote\u0000id", "x".repeat(257), "\ud800"])(
    "rejects a hostile remote ID",
    (value) => {
      expect(() => parseRemoteId(value)).toThrow(MarketplaceValidationError);
    },
  );

  it("counts Unicode code points for the 256-character remote ID limit", () => {
    expect(parseRemoteId("😀".repeat(256))).toBe("😀".repeat(256));
    expect(() => parseRemoteId("😀".repeat(257))).toThrow(
      MarketplaceValidationError,
    );
  });

  it.each([
    "missing-separator",
    "/missing-connection",
    "valid/two/slashes",
    "valid/%",
    "valid/%2f",
    "valid/%41",
    "UPPER/remote",
  ])("rejects a malformed or noncanonical map key: %s", (value) => {
    expect(() => parseOrderRefKey(value)).toThrow(MarketplaceValidationError);
  });

  it("parses only structured qualified references", () => {
    expect(
      parseProviderOrderRef({ connectionId: "store-main", remoteId: "100" }),
    ).toEqual({ connectionId: "store-main", remoteId: "100" });
    expect(() => parseProviderOrderRef("store-main/100")).toThrow(
      MarketplaceValidationError,
    );
  });
});
