import { createSignal, onMount } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BottomSheet } from "./bottom-sheet";
import { SettingsDialog } from "./settings-dialog";

// Corvu's drawer/dialog measure content with ResizeObserver, which jsdom lacks.
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
// on its own: dialog presence waits for `animationend` before unmounting.
function fireDialogAnimationEnd() {
  document
    .querySelectorAll(".settings-dialog, .settings-dialog-overlay")
    .forEach((el) => {
      for (const type of ["animationend", "animationcancel"]) {
        const event = new Event(type, { bubbles: true }) as Event & { animationName?: string };
        event.animationName = "";
        el.dispatchEvent(event);
      }
    });
}

async function settleDialogClose() {
  await flush();
  fireDialogAnimationEnd();
  await flush();
}

const sheet = () => document.querySelector<HTMLElement>(".bottom-sheet");
const nested = () => document.querySelector<HTMLElement>(".settings-dialog");
const nestedOverlay = () => document.querySelector<HTMLElement>(".settings-dialog-overlay");

function renderDialog(initial = true) {
  const [open, setOpen] = createSignal(initial);
  const onOpenChange = vi.fn((next: boolean) => setOpen(next));
  dispose = render(
    () => (
      <SettingsDialog
        open={open()}
        onOpenChange={onOpenChange}
        title="Edit shortcut"
        description="Choose a key or build a sequence for your shortcut bar."
        footer={<button type="button" data-testid="dialog-save">Add shortcut</button>}
      >
        <p data-testid="dialog-body">Dialog body</p>
      </SettingsDialog>
    ),
    document.body,
  );
  return { open, setOpen, onOpenChange };
}

function renderNested(opts: { sheetOpen?: boolean; dialogOpen?: boolean } = {}) {
  const [sheetOpen, setSheetOpen] = createSignal(opts.sheetOpen ?? true);
  const [dialogOpen, setDialogOpen] = createSignal(opts.dialogOpen ?? true);
  const onSheetOpenChange = vi.fn((next: boolean) => setSheetOpen(next));
  const onDialogOpenChange = vi.fn((next: boolean) => setDialogOpen(next));
  dispose = render(
    () => (
      <BottomSheet
        open={sheetOpen()}
        onOpenChange={onSheetOpenChange}
        title="Settings"
        description="Tune things"
      >
        <button type="button" data-testid="opener" onClick={() => setDialogOpen(true)}>
          Edit shortcut
        </button>
        {/* Nest inside the sheet so Corvu dismisses only the topmost dialog. */}
        <SettingsDialog
          open={dialogOpen()}
          onOpenChange={onDialogOpenChange}
          title="Edit shortcut"
          description="Choose a key or build a sequence for your shortcut bar."
          footer={<button type="button" data-testid="dialog-save">Add shortcut</button>}
        >
          <label class="field">
            <span>Button label</span>
            <input data-testid="dialog-field" value="fresh" />
          </label>
        </SettingsDialog>
      </BottomSheet>
    ),
    document.body,
  );
  return { sheetOpen, setSheetOpen, dialogOpen, setDialogOpen, onSheetOpenChange, onDialogOpenChange };
}

describe("settings dialog", () => {
  it("exposes an accessible dialog name and description", async () => {
    renderDialog();
    await flush();

    const content = nested();
    expect(content).not.toBeNull();
    expect(content?.getAttribute("role")).toBe("dialog");
    expect(content?.getAttribute("aria-modal")).toBe("true");
    const labelId = content?.getAttribute("aria-labelledby");
    const descriptionId = content?.getAttribute("aria-describedby");
    expect(labelId).toBeTruthy();
    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(labelId!)?.textContent).toBe("Edit shortcut");
    expect(document.getElementById(descriptionId!)?.textContent).toBe(
      "Choose a key or build a sequence for your shortcut bar.",
    );
    expect(content?.querySelector(".bottom-sheet-close")?.getAttribute("aria-label")).toBe(
      "Close edit shortcut",
    );
  });

  it("keeps the footer outside the scrollport", async () => {
    renderDialog();
    await flush();

    const content = nested()!;
    const body = document.querySelector<HTMLElement>(".settings-dialog-body")!;
    const footer = document.querySelector<HTMLElement>(".settings-dialog-footer")!;
    expect(content).not.toBeNull();
    expect(body).not.toBeNull();
    expect(footer).not.toBeNull();
    // Footer is a sibling of the scrollport, never a descendant of it.
    expect(body.contains(footer)).toBe(false);
    expect(content.contains(footer)).toBe(true);
    expect(footer.parentElement).toBe(content);
    expect(body.querySelector('[data-testid="dialog-body"]')).not.toBeNull();
    expect(footer.querySelector('[data-testid="dialog-save"]')?.textContent).toBe("Add shortcut");
  });

  it("Escape closes only the nested dialog, leaving the parent sheet open", async () => {
    // Open sequentially like the app does (sheet first, nested later): opening
    // both at once races the two focus traps and auto-dismisses the nested
    // dialog before any key is pressed.
    const { setDialogOpen, onSheetOpenChange, onDialogOpenChange } = renderNested({
      dialogOpen: false,
    });
    await flush();
    expect(nested()).toBeNull();

    setDialogOpen(true);
    await flush();
    expect(sheet()?.hasAttribute("data-open")).toBe(true);
    expect(nested()?.hasAttribute("data-open")).toBe(true);
    onSheetOpenChange.mockClear();
    onDialogOpenChange.mockClear();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();

    expect(onDialogOpenChange).toHaveBeenCalledWith(false);
    expect(onSheetOpenChange).not.toHaveBeenCalled();
    // Controlled signals follow the mock: nested parks closed, sheet stays open.
    expect(nested()?.hasAttribute("data-closed")).toBe(true);
    expect(sheet()?.hasAttribute("data-open")).toBe(true);
  });

  it("outside pointer closes only the nested dialog, leaving the parent sheet open", async () => {
    const { setDialogOpen, onSheetOpenChange, onDialogOpenChange } = renderNested({
      dialogOpen: false,
    });
    await flush();
    expect(nested()).toBeNull();

    setDialogOpen(true);
    await flush();
    expect(sheet()).not.toBeNull();
    expect(nested()?.hasAttribute("data-open")).toBe(true);
    onSheetOpenChange.mockClear();
    onDialogOpenChange.mockClear();

    // The scrims sit outside both contents, so a pointer release on body
    // (outside the nested content node) dismisses only the topmost layer.
    document.body.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, cancelable: true }));
    await flush();

    expect(onDialogOpenChange).toHaveBeenCalledWith(false);
    expect(onSheetOpenChange).not.toHaveBeenCalled();
    expect(nested()?.hasAttribute("data-closed")).toBe(true);
    expect(sheet()?.hasAttribute("data-open")).toBe(true);
  });

  it("restores focus to the opener when the nested dialog closes", async () => {
    const { setDialogOpen } = renderNested({ dialogOpen: false });
    await flush();
    expect(nested()).toBeNull();
    expect(sheet()).not.toBeNull();

    const opener = document.querySelector<HTMLButtonElement>('[data-testid="opener"]')!;
    opener.focus();
    expect(document.activeElement).toBe(opener);

    setDialogOpen(true);
    await flush();

    const content = nested()!;
    expect(content.hasAttribute("data-open")).toBe(true);
    // Corvu traps initial focus inside the newly opened nested dialog.
    expect(content.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(opener);

    setDialogOpen(false);
    await flush();

    // Focus trap restores the element focused before the nested dialog opened.
    expect(document.activeElement).toBe(opener);

    // Settling presence unmounts the nested dialog without moving focus away.
    await settleDialogClose();
    expect(nested()).toBeNull();
    expect(nestedOverlay()).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(sheet()?.hasAttribute("data-open")).toBe(true);
  });

  it("unmounts content so closing and reopening does not reuse stale children", async () => {
    // NOTE: the field is declared inline so each reactive render creates a
    // fresh node — hoisting the JSX out of render would reuse one DOM node.
    let mounts = 0;
    function Field() {
      onMount(() => {
        mounts += 1;
      });
      return <input data-testid="dialog-field" value="fresh" />;
    }
    const [sheetOpen, setSheetOpen] = createSignal(true);
    const [dialogOpen, setDialogOpen] = createSignal(false);
    const onSheetOpenChange = vi.fn((next: boolean) => setSheetOpen(next));
    const onDialogOpenChange = vi.fn((next: boolean) => setDialogOpen(next));
    dispose = render(
      () => (
        <BottomSheet
          open={sheetOpen()}
          onOpenChange={onSheetOpenChange}
          title="Settings"
          description="Tune things"
        >
          <button type="button" data-testid="opener">Edit shortcut</button>
          <SettingsDialog
            open={dialogOpen()}
            onOpenChange={onDialogOpenChange}
            title="Edit shortcut"
            description="Choose a key or build a sequence for your shortcut bar."
            footer={<button type="button" data-testid="dialog-save">Add shortcut</button>}
          >
            <Field />
          </SettingsDialog>
        </BottomSheet>
      ),
      document.body,
    );
    await flush();
    expect(nested()).toBeNull();

    // Open after the sheet settles, like the app does (avoids the dual
    // focus-trap race that auto-dismisses a simultaneously opened nested).
    setDialogOpen(true);
    await flush();

    const first = document.querySelector<HTMLInputElement>('[data-testid="dialog-field"]')!;
    expect(mounts).toBe(1);
    expect(first.value).toBe("fresh");
    first.value = "dirty edit";

    setDialogOpen(false);
    await settleDialogClose();
    expect(document.querySelector('[data-testid="dialog-field"]')).toBeNull();
    expect(nested()).toBeNull();
    // The parent sheet stays mounted while the nested dialog exits.
    expect(sheet()).not.toBeNull();
    expect(sheet()?.hasAttribute("data-open")).toBe(true);

    setDialogOpen(true);
    await flush();

    const second = document.querySelector<HTMLInputElement>('[data-testid="dialog-field"]')!;
    expect(mounts).toBe(2);
    expect(second).not.toBe(first);
    expect(second.value).toBe("fresh");
    expect(nested()?.hasAttribute("data-open")).toBe(true);
  });
});
