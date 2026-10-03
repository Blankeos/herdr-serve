/** Own wheel input completely. Returning true lets xterm's alternate-screen
 * fallback send Up/Down keys as well, inadvertently cycling prompt history. */
export function createRelayWheelHandler(
  connected: () => boolean,
  sendScroll: (direction: "up" | "down", lines: number, clientX: number, clientY: number) => void,
): (event: WheelEvent) => false {
  let accumulator = 0;
  return (event) => {
    if (!connected()) {
      accumulator = 0;
      return false;
    }
    event.preventDefault();
    accumulator += event.deltaY;
    const lines = Math.sign(accumulator) * Math.floor(Math.abs(accumulator) / 40);
    if (lines !== 0) {
      accumulator -= lines * 40;
      sendScroll(lines < 0 ? "up" : "down", Math.abs(lines), event.clientX, event.clientY);
    }
    // Even a partial wheel tick must not fall through to xterm arrow keys.
    return false;
  };
}
