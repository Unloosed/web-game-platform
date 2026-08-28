import { describe, expect, it } from "vitest";
import { clientEventSchema, directionSchema, tagInputSchema } from "../src/index.js";

describe("protocol", () => {
  it("rejects oversized chat", () =>
    expect(
      clientEventSchema.safeParse({ type: "chat", text: "x".repeat(501) })
        .success,
    ).toBe(false));
  it("accepts the generic input envelope", () =>
    expect(
      clientEventSchema.safeParse({ type: "input", seq: 0, direction: "up" })
        .success,
    ).toBe(true));
  it("requires a nonnegative integer seq on input envelopes", () =>
    expect(
      clientEventSchema.safeParse({ type: "input", seq: -1, direction: "up" })
        .success,
    ).toBe(false));
  it("accepts ready toggle", () =>
    expect(
      clientEventSchema.safeParse({ type: "ready", ready: true }).success,
    ).toBe(true));
  it("validates the tag game payload strictly", () => {
    expect(tagInputSchema.safeParse({ type: "input", seq: 1, direction: "left" }).success).toBe(true);
    expect(tagInputSchema.safeParse({ type: "input", seq: 1, direction: "none" }).success).toBe(false);
    expect(directionSchema.safeParse("up").success).toBe(true);
  });
});
