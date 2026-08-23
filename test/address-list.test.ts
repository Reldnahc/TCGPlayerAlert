import { describe, expect, it } from "vitest";
import {
  addressLines,
  parseAddressList,
  validateAddressLabels,
} from "../src/web/address-list.js";

describe("address-list formatting", () => {
  it("splits blank-separated address blocks and keeps existing label lines", () => {
    expect(
      parseAddressList(
        "Ada Example\n12 First Street\nChicago, IL 60601\n\nGrace Example\n34 Second Avenue\nAustin, TX 78701",
      ),
    ).toEqual({
      labels: [
        { lines: ["Ada Example", "12 First Street", "Chicago, IL 60601"] },
        { lines: ["Grace Example", "34 Second Avenue", "Austin, TX 78701"] },
      ],
      issues: [],
    });
  });

  it("recognizes consecutive multiline addresses by their postal line", () => {
    expect(
      parseAddressList(
        "Ada Example\n12 First Street\nChicago, IL 60601\nGrace Example\n34 Second Avenue\nAustin, TX 78701",
      ).labels,
    ).toHaveLength(2);
  });

  it("formats one comma-separated address per line", () => {
    expect(
      parseAddressList(
        "Ada Example, 12 First Street, Chicago, IL 60601\nGrace Example, 34 Second Avenue, Austin, TX, 78701",
      ).labels,
    ).toEqual([
      { lines: ["Ada Example", "12 First Street", "Chicago, IL 60601"] },
      { lines: ["Grace Example", "34 Second Avenue", "Austin, TX 78701"] },
    ]);
  });

  it("maps CSV headers into conventional postal lines", () => {
    expect(
      parseAddressList(
        'Name,Address 1,Address 2,City,State,Zip,Country\n"Ada Example","12 First Street","Suite 4","Chicago","IL","60601","US"',
      ).labels,
    ).toEqual([
      {
        lines: [
          "Ada Example",
          "12 First Street",
          "Suite 4",
          "Chicago, IL 60601",
          "US",
        ],
      },
    ]);
  });

  it("normalizes edited lines and reports unsafe label sizes", () => {
    expect(addressLines("  Ada Example \r\n\r\n 12 First Street ")).toEqual([
      "Ada Example",
      "12 First Street",
    ]);
    expect(
      validateAddressLabels([{ lines: [] }, { lines: ["x".repeat(129)] }]),
    ).toEqual([
      "Label 1 must contain one to 8 lines.",
      "Every line on label 2 must be 128 characters or fewer.",
    ]);
  });
});
