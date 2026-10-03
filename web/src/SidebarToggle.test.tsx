import { Show, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
import { SidebarToggle } from "./SidebarToggle";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

describe("SidebarToggle", () => {
  it("toggles its accessible state and uses the panel icon", () => {
    const [open, setOpen] = createSignal(true);
    dispose = render(() => <SidebarToggle open={open()} onClick={() => setOpen(!open())} />, document.body);
    const button = document.querySelector("button")!;
    expect(button.getAttribute("aria-controls")).toBe("workspace-sidebar");
    expect(button.getAttribute("aria-label")).toBe("Close sidebar");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");

    button.click();
    expect(button.getAttribute("aria-label")).toBe("Open sidebar");
    expect(button.title).toBe("Open sidebar");
    expect(button.getAttribute("aria-expanded")).toBe("false");

    button.click();
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.title).toBe("Close sidebar");
  });

  it("supports the sidebar's own close control", () => {
    const [open, setOpen] = createSignal(true);
    dispose = render(() => <SidebarToggle class="sidebar-close-btn" open={open()} onClick={() => setOpen(false)} />, document.body);
    const button = document.querySelector("button")!;
    expect(button.classList.contains("sidebar-close-btn")).toBe(true);
    button.click();
    expect(open()).toBe(false);
  });

  it("alternates between the sidebar close and header open controls", () => {
    const [open, setOpen] = createSignal(true);
    dispose = render(() => (
      <>
        <Show when={open()}>
          <SidebarToggle class="sidebar-close-btn" open onClick={() => setOpen(false)} />
        </Show>
        <Show when={!open()}>
          <div class="sidebar-toggle">
            <SidebarToggle open={false} onClick={() => setOpen(true)} />
          </div>
        </Show>
      </>
    ), document.body);

    expect(document.querySelectorAll("button")).toHaveLength(1);
    expect(document.querySelector(".sidebar-toggle")).toBeNull();
    document.querySelector<HTMLButtonElement>(".sidebar-close-btn")!.click();
    expect(document.querySelector(".sidebar-close-btn")).toBeNull();
    expect(document.querySelectorAll("button")).toHaveLength(1);
    const headerButton = document.querySelector<HTMLButtonElement>(".sidebar-toggle button")!;
    expect(headerButton.getAttribute("aria-label")).toBe("Open sidebar");
    headerButton.click();
    expect(document.querySelector(".sidebar-toggle")).toBeNull();
    expect(document.querySelectorAll("button")).toHaveLength(1);
  });
});
