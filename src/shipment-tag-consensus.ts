import type { ShipmentTagDetection } from "./april-tag.js";

export interface ShipmentTagConsensus {
  readonly tagId: number | null;
  readonly matchingReads: number;
  readonly requiredReads: number;
}

export interface ShipmentTagConsensusObservation {
  readonly consensus: ShipmentTagConsensus;
  readonly accepted: boolean;
  readonly confirmedTagId?: number;
}

const REQUIRED_TAG_READS = 5;

export function emptyShipmentTagConsensus(): ShipmentTagConsensus {
  return { tagId: null, matchingReads: 0, requiredReads: 0 };
}

export function observeShipmentTagDetection(
  current: ShipmentTagConsensus,
  detection: ShipmentTagDetection,
  knownTagIds: ReadonlySet<number>,
): ShipmentTagConsensusObservation {
  const known = knownTagIds.has(detection.tagId);
  if (!known && detection.hammingDistance !== 0) {
    return { consensus: current, accepted: false };
  }

  const requiredReads = REQUIRED_TAG_READS;
  const matchingReads =
    current.tagId === detection.tagId ? current.matchingReads + 1 : 1;
  const consensus = {
    tagId: detection.tagId,
    matchingReads,
    requiredReads,
  };
  return {
    consensus,
    accepted: true,
    ...(matchingReads >= requiredReads
      ? { confirmedTagId: detection.tagId }
      : {}),
  };
}
