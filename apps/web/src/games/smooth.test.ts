import { describe, expect, it } from "vitest";
import { lerpPositions } from "./smooth";

describe("lerpPositions", () => {
  it("interpolates both axes at fraction k", () => {
    const out = lerpPositions(
      { a: { x: 0, y: 10 } },
      { a: { x: 100, y: 20 } },
      0.25,
    );
    expect(out.a).toEqual({ x: 25, y: 12.5 });
  });

  it("clamps k into 0..1", () => {
    expect(lerpPositions({ a: { x: 0, y: 0 } }, { a: { x: 8, y: 0 } }, -1).a.x).toBe(0);
    expect(lerpPositions({ a: { x: 0, y: 0 } }, { a: { x: 8, y: 0 } }, 2).a.x).toBe(8);
  });

  it("snaps new players to their target and drops departed ones", () => {
    const out = lerpPositions(
      { a: { x: 0, y: 0 }, gone: { x: 5, y: 5 } },
      { a: { x: 10, y: 0 }, fresh: { x: 42, y: 7 } },
      0.5,
    );
    expect(out.a).toEqual({ x: 5, y: 0 });
    expect(out.fresh).toEqual({ x: 42, y: 7 });
    expect(out.gone).toBeUndefined();
  });
});
