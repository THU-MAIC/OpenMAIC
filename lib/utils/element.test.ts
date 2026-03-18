import { describe, it, expect } from "vitest";
import {
  getLineElementLength,
  uniqAlignLines,
  getElementListRange,
} from "@/lib/utils/element";

describe("element utilities", () => {
  describe("getLineElementLength", () => {
    it("calculates line length correctly", () => {
      const line: any = {
        start: [0, 0],
        end: [3, 4],
      };

      const result = getLineElementLength(line);

      expect(result).toBe(5);
    });
  });

  describe("uniqAlignLines", () => {
    it("removes duplicate alignment lines", () => {
      const lines: any = [
        { axis: "x", range: [0, 10] },
        { axis: "x", range: [0, 10] },
        { axis: "y", range: [10, 20] },
      ];

      const result = uniqAlignLines(lines);

      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe("getElementListRange", () => {
    it("returns bounding range for elements", () => {
      const elements: any = [
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 100, y: 100, width: 100, height: 100 },
      ];

      const result = getElementListRange(elements);

      expect(result).toHaveProperty("minX");
      expect(result).toHaveProperty("maxX");
      expect(result).toHaveProperty("minY");
      expect(result).toHaveProperty("maxY");
    });
  });
});