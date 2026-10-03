import { describe, expect, it, vi } from "vitest";
import { createRelayWheelHandler } from "./wheel";

function wheel(deltaY: number, clientX = 100, clientY = 200) {
  return new WheelEvent("wheel", { deltaY, clientX, clientY, cancelable: true });
}

describe("relay wheel handling", () => {
  it("sends scroll at the pointer and suppresses xterm's arrow-key fallback", () => {
    const send = vi.fn();
    const handler = createRelayWheelHandler(() => true, send);
    const event = wheel(-120, 320, 180);
    expect(handler(event)).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(send.mock.calls).toEqual([["up", 3, 320, 180]]);
  });

  it("also suppresses partial ticks and uses the latest pointer position", () => {
    const send = vi.fn();
    const handler = createRelayWheelHandler(() => true, send);
    expect(handler(wheel(15))).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(handler(wheel(25, 40, 50))).toBe(false);
    expect(send.mock.calls).toEqual([["down", 1, 40, 50]]);
  });

  it("does not scroll sideways or accumulate disconnected events", () => {
    const send = vi.fn();
    let connected = true;
    const handler = createRelayWheelHandler(() => connected, send);
    handler(wheel(30));
    connected = false;
    expect(handler(wheel(120))).toBe(false);
    connected = true;
    handler(wheel(10));
    handler(new WheelEvent("wheel", { deltaX: 120, cancelable: true }));
    expect(send).not.toHaveBeenCalled();
  });
});
