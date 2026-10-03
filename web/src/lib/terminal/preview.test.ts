// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { terminalPreview } from "./preview";

afterEach(() => { document.body.innerHTML = ""; });

function terminal() {
  const element = document.createElement("div");
  element.className = "xterm xterm-dom-renderer-owner-1";
  element.innerHTML = '<style>.xterm-dom-renderer-owner-1 .ansi { color: rgb(255, 80, 90); }</style><div class="xterm-screen" style="width: 390px; height: 720px"><div class="xterm-rows"><div style="height: 12px"><span class="ansi" style="background-color: rgb(20, 60, 100); font-weight: bold">colored output</span></div></div><div class="xterm-helpers"><textarea tabindex="0" id="input"></textarea></div></div>';
  document.body.append(element);
  return { element };
}

describe("terminalPreview", () => {
  it("preserves ANSI foreground, background, emphasis, and cell geometry", () => {
    const term = terminal();
    const snapshot = terminalPreview(term)!;
    document.body.append(snapshot);
    const cell = snapshot.querySelector<HTMLElement>(".ansi")!;
    expect(getComputedStyle(cell).color).toBe("rgb(255, 80, 90)");
    expect(cell.style.backgroundColor).toBe("rgb(20, 60, 100)");
    expect(cell.style.fontWeight).toBe("bold");
    expect(snapshot.querySelector<HTMLElement>(".xterm-screen")!.style.width).toBe("390px");
    expect(snapshot.querySelector(".xterm-rows")?.textContent).toBe("colored output");
  });

  it("does not create a second input target or change the live terminal", () => {
    const term = terminal();
    const snapshot = terminalPreview(term)!;
    expect(snapshot.querySelector("textarea, .xterm-helpers, [id], [tabindex]")).toBeNull();
    expect(snapshot.inert).toBe(true);
    expect(snapshot.getAttribute("aria-hidden")).toBe("true");
    snapshot.querySelector(".ansi")!.textContent = "snapshot only";
    expect(term.element.querySelector(".ansi")!.textContent).toBe("colored output");
    expect(term.element.querySelector("textarea")).not.toBeNull();
  });

  it("copies literal terminal text without interpreting it as HTML", () => {
    const term = terminal();
    term.element.querySelector(".ansi")!.textContent = "<script>literal text</script>";
    const snapshot = terminalPreview(term)!;
    expect(snapshot.querySelector("script")).toBeNull();
    expect(snapshot.querySelector(".ansi")!.textContent).toBe("<script>literal text</script>");
  });

  it("returns no preview before the terminal has been opened", () => {
    expect(terminalPreview({ element: undefined })).toBeNull();
  });
});
