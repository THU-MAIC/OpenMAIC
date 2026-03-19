// logger.test.ts
import { describe, it, expect } from "vitest";
import { createLogger } from "@/lib/logger";

describe("logger utilities", () => {
  describe("createLogger", () => {
    it("creates a logger instance", () => {
      const logger = createLogger("test");

      expect(logger).toBeDefined();
      expect(typeof logger).toBe("object");
    });

    it("provides logging methods", () => {
      const logger = createLogger("test");

      expect(logger).toHaveProperty("info");
      expect(logger).toHaveProperty("warn");
      expect(logger).toHaveProperty("error");
      expect(logger).toHaveProperty("debug");
    });

    it("logging methods do not throw errors", () => {
      const logger = createLogger("test");

      expect(() => logger.info("info message")).not.toThrow();
      expect(() => logger.warn("warn message")).not.toThrow();
      expect(() => logger.error("error message")).not.toThrow();
      expect(() => logger.debug("debug message")).not.toThrow();
    });
  });
});