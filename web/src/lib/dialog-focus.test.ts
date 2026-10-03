// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { manageDialogFocus } from "./dialog-focus";

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; document.body.innerHTML = ""; });

function setup(focusInput = true) {
  document.body.innerHTML = '<button id="trigger">New agent</button><form tabindex="-1"><button id="close" type="button">Close</button><select><option>Project</option></select><button disabled>Unavailable</button><input><button id="submit">Create</button></form>';
  const trigger = document.querySelector<HTMLButtonElement>("#trigger")!;
  trigger.focus();
  const panel = document.querySelector<HTMLFormElement>("form")!;
  const dismiss = vi.fn();
  cleanup = manageDialogFocus(panel, dismiss, { focusInput });
  return { panel, trigger, dismiss };
}

const key = (value: string, shiftKey = false) => document.dispatchEvent(new KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true }));

describe("dialog focus", () => {
  it("focuses the first text field (not the select, so its dropdown stays shut) and returns focus to the trigger", () => {
    const { trigger } = setup();
    expect(document.activeElement?.tagName).toBe("INPUT");
    cleanup!(); cleanup = undefined;
    expect(document.activeElement).toBe(trigger);
  });
  it("focuses the panel on mobile without blocking deliberate input focus", () => {
    const { panel, trigger } = setup(false);
    expect(document.activeElement).toBe(panel);
    const input = panel.querySelector("input")!;
    input.focus();
    expect(document.activeElement).toBe(input);
    cleanup!(); cleanup = undefined;
    expect(document.activeElement).toBe(trigger);
  });
  it("tabs from the mobile panel into controls in either direction", () => {
    const { panel } = setup(false);
    key("Tab", true);
    expect(document.activeElement?.id).toBe("submit");
    panel.focus();
    // The browser handles forward Tab naturally; don't cancel it.
    expect(key("Tab")).toBe(true);
  });
  it("wraps Tab and Shift+Tab around enabled controls", () => {
    setup();
    document.querySelector<HTMLButtonElement>("#submit")!.focus();
    expect(key("Tab")).toBe(false);
    expect(document.activeElement?.id).toBe("close");
    key("Tab", true);
    expect(document.activeElement?.id).toBe("submit");
  });
  it("contains focus that has moved outside and dismisses on Escape", () => {
    const { trigger, dismiss } = setup();
    trigger.focus(); key("Tab");
    expect(document.activeElement?.id).toBe("close");
    key("Escape"); expect(dismiss).toHaveBeenCalledOnce();
  });
  it("holds focus on the panel while every control is disabled", () => {
    const { panel } = setup();
    panel.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>("button,input,select").forEach(el => el.disabled = true);
    key("Tab");
    expect(document.activeElement).toBe(panel);
  });
});
