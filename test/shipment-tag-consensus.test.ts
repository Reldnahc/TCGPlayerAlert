import { describe, expect, it } from "vitest";
import type { ShipmentTagDetection } from "../src/april-tag.js";
import {
  emptyShipmentTagConsensus,
  observeShipmentTagDetection,
} from "../src/shipment-tag-consensus.js";

function detection(tagId: number, hammingDistance = 0): ShipmentTagDetection {
  return { tagId, hammingDistance, corners: [] };
}

describe("shipment tag camera consensus", () => {
  it("does not declare no match from one unknown camera read", () => {
    const observation = observeShipmentTagDetection(
      emptyShipmentTagConsensus(),
      detection(99),
      new Set([7]),
    );

    expect(observation).toEqual({
      accepted: true,
      consensus: { tagId: 99, matchingReads: 1, requiredReads: 5 },
    });
  });

  it("confirms a known order tag after five matching reads", () => {
    let consensus = emptyShipmentTagConsensus();
    let confirmedTagId: number | undefined;
    for (let read = 0; read < 5; read += 1) {
      const observation = observeShipmentTagDetection(
        consensus,
        detection(7, 1),
        new Set([7]),
      );
      consensus = observation.consensus;
      confirmedTagId = observation.confirmedTagId;
    }

    expect(consensus).toEqual({
      tagId: 7,
      matchingReads: 5,
      requiredReads: 5,
    });
    expect(confirmedTagId).toBe(7);
  });

  it("requires five exact reads before confirming an unknown tag", () => {
    let consensus = emptyShipmentTagConsensus();
    for (let read = 0; read < 4; read += 1) {
      const observation = observeShipmentTagDetection(
        consensus,
        detection(29),
        new Set([7]),
      );
      consensus = observation.consensus;
      expect(observation.confirmedTagId).toBeUndefined();
    }

    expect(
      observeShipmentTagDetection(consensus, detection(29), new Set([7]))
        .confirmedTagId,
    ).toBe(29);
  });

  it("ignores corrected unknown reads instead of replacing good progress", () => {
    const firstKnownRead = observeShipmentTagDetection(
      emptyShipmentTagConsensus(),
      detection(7),
      new Set([7]),
    ).consensus;
    const noisyUnknownRead = observeShipmentTagDetection(
      firstKnownRead,
      detection(99, 2),
      new Set([7]),
    );

    expect(noisyUnknownRead).toEqual({
      accepted: false,
      consensus: firstKnownRead,
    });
  });
});
