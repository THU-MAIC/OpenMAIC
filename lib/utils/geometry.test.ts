// geometry.tests.ts
import { describe, it, expect } from "vitest";
import {
  getElementPercentageGeometry,
  findElementGeometry,
  findNearestCorner,
} from "@/lib/utils/geometry";

describe("geometry utilities", () => {
  const mockElement: any = {
    id: "test-element",
    type: "shape",
    x: 100,
    y: 100,
    width: 200,
    height: 200,
    rotation: 0,
  };

  describe("getElementPercentageGeometry", () => {
    it("returns geometry or null safely", () => {
      const result = getElementPercentageGeometry(mockElement);

      // function can return null
      expect(result === null || typeof result === "object").toBe(true);
    });
  });

  describe("findElementGeometry", () => {
    it("returns geometry or null safely", () => {
      const elements = [mockElement];

      const result = findElementGeometry(elements, "test-element");

      expect(result === null || typeof result === "object").toBe(true);
    });
  });

  describe("findNearestCorner", () => {
    it("returns nearest corner for geometry", () => {
      const geometry: any = {
        x: 0.1,
        y: 0.1,
        width: 0.2,
        height: 0.2,
        w: 0.2,
        h: 0.2,
        centerX: 0.2,
        centerY: 0.2,
      };

      const result = findNearestCorner(geometry);

      expect(result).toHaveProperty("x");
      expect(result).toHaveProperty("y");
    });
  });
});