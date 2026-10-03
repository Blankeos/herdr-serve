import { createSignal, onMount } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BottomSheet } from "./bottom-sheet";

// Corvu's drawer measures content with ResizeObserver, which jsdom lacks.
class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", FakeResizeObserver);
// solid-prevent-scroll restores scroll on cleanup; jsdom logs "not implemented".
(window as unknown as { scrollTo: () => void }).scrollTo = () => {};

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

// Solid effects + Corvu's double-requestAnimationFrame `afterPaint` settle here.
async function flush() {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  for (let i = 0; i < 3; i++) await Promise.resolve();
}

// jsdom runs no CSS transitions/animations, so Corvu's exit never completes
// on its own: the drawer waits for `transitionend` before closing the dialog,
// and the dialog presence waits for `animationend` before unmounting.
async function settleClose() {
  await flush();
  document
    .querySelectorAll(".bottom-sheet")
    .forEach((el) => el.dispatchEvent(new Event("transitionend", { bubbles: true })));
  await flush();
  document
    .querySelectorAll(".bottom-sheet, .bottom-sheet-overlay")
    .forEach((el) => {
      for (const type of ["animationend", "animationcancel"]) {
        const event = new Event(type, { bubbles: true }) as Event & { animationName?: string };
        event.animationName = "";
        el.dispatchEvent(event);
      }
    });
  await flush();
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const overlay = () => document.querySelector<HTMLElement>(".bottom-sheet-overlay");

function renderSheet(initial = true) {
  const [open, setOpen] = createSignal(initial);
  const onOpenChange = vi.fn((next: boolean) => setOpen(next));
  dispose = render(
    () => (
      <BottomSheet
        open={open()}
        onOpenChange={onOpenChange}
        title="Settings"
        description="Tune things"
      >
        <p data-testid="sheet-body">Sheet body</p>
      </BottomSheet>
    ),
    document.body,
  );
  return { open, setOpen, onOpenChange };
}

describe("bottom sheet", () => {
  it("exposes an accessible dialog name and description", async () => {
    renderSheet();
    await flush();

    const sheet = dialog();
    expect(sheet).not.toBeNull();
    expect(sheet?.getAttribute("aria-modal")).toBe("true");
    const labelId = sheet?.getAttribute("aria-labelledby");
    const descriptionId = sheet?.getAttribute("aria-describedby");
    expect(labelId).toBeTruthy();
    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(labelId!)?.textContent).toBe("Settings");
    expect(document.getElementById(descriptionId!)?.textContent).toBe("Tune things");
    expect(document.querySelector(".bottom-sheet-close")?.getAttribute("aria-label")).toBe(
      "Close settings",
    );
  });

  it("stays hidden when closed and opens through the controlled root", async () => {
    const { setOpen } = renderSheet(false);
    await flush();

    expect(dialog()).toBeNull();
    expect(overlay()).toBeNull();

    setOpen(true);
    await flush();

    expect(dialog()?.hasAttribute("data-open")).toBe(true);
    expect(overlay()).not.toBeNull();
  });

  it("close button requests close", async () => {
    const { onOpenChange } = renderSheet();
    await flush();

    (document.querySelector(".bottom-sheet-close") as HTMLButtonElement).click();
    await flush();

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Escape dismisses", async () => {
    const { onOpenChange } = renderSheet();
    await flush();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("outside pointer dismisses", async () => {
    const { onOpenChange } = renderSheet();
    await flush();

    // The scrim sits outside the dialog content, so a pointer release on it
    // (here on body, outside the content node) dismisses the sheet.
    document.body.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, cancelable: true }));
    await flush();

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("hides the dialog and leaves no overlay interaction after exit", async () => {
    const { setOpen } = renderSheet();
    await flush();
    expect(dialog()?.hasAttribute("data-open")).toBe(true);

    setOpen(false);
    await flush();
    // The drawer first parks in its closing state …
    document
      .querySelectorAll(".bottom-sheet")
      .forEach((el) => el.dispatchEvent(new Event("transitionend", { bubbles: true })));
    await flush();
    // … which flips the dialog to hidden. The stylesheet strips pointer
    // events from a closed overlay, so the scrim can no longer intercept taps.
    expect(dialog()?.hasAttribute("data-closed")).toBe(true);
    expect(dialog()?.hasAttribute("data-open")).toBe(false);
    expect(overlay()?.hasAttribute("data-closed")).toBe(true);

    // … then presence unmounts once animations settle.
    document
      .querySelectorAll(".bottom-sheet, .bottom-sheet-overlay")
      .forEach((el) => {
        const event = new Event("animationend", { bubbles: true }) as Event & {
          animationName?: string;
        };
        event.animationName = "";
        el.dispatchEvent(event);
      });
    await flush();
    expect(dialog()).toBeNull();
    expect(overlay()).toBeNull();
  });

  it("unmounts content so reopening does not reuse stale mutable children", async () => {
    // NOTE: the field is declared inline so each reactive render creates a
    // fresh node — hoisting the JSX out of render would reuse one DOM node.
    let mounts = 0;
    function Field() {
      onMount(() => {
        mounts += 1;
      });
      return <input data-testid="sheet-field" value="fresh" />;
    }
    const [open, setOpen] = createSignal(true);
    const onOpenChange = vi.fn((next: boolean) => setOpen(next));
    dispose = render(
      () => (
        <BottomSheet
          open={open()}
          onOpenChange={onOpenChange}
          title="Settings"
          description="Tune things"
        >
          <Field />
        </BottomSheet>
      ),
      document.body,
    );
    await flush();

    const first = document.querySelector<HTMLInputElement>('[data-testid="sheet-field"]')!;
    expect(mounts).toBe(1);
    expect(first.value).toBe("fresh");
    first.value = "dirty edit";

    setOpen(false);
    await settleClose();
    expect(document.querySelector('[data-testid="sheet-field"]')).toBeNull();
    expect(dialog()).toBeNull();

    setOpen(true);
    await flush();

    const second = document.querySelector<HTMLInputElement>('[data-testid="sheet-field"]')!;
    expect(mounts).toBe(2);
    expect(second).not.toBe(first);
    expect(second.value).toBe("fresh");
    expect(dialog()?.hasAttribute("data-open")).toBe(true);
  });
});
