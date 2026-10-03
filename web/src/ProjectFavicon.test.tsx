import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectFavicon } from "./ProjectFavicon";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

describe("ProjectFavicon activity", () => {
  it("adds and removes the outer ping without remounting the logo", () => {
    const [running, setRunning] = createSignal(false);
    dispose = render(() => <ProjectFavicon cwd="/project" label="Project" running={running()} />, document.body);
    const logo = document.querySelector(".project-favicon");
    const image = document.querySelector("img")!;
    image.dispatchEvent(new Event("load"));
    expect(document.querySelector(".project-favicon-ping")).toBeNull();

    setRunning(true);
    const ping = document.querySelector(".project-favicon-ping")!;
    expect(ping.getAttribute("aria-hidden")).toBe("true");
    expect(ping.parentElement).toBe(logo?.parentElement);
    expect(logo?.contains(ping)).toBe(false);
    expect(document.querySelector("img")).toBe(image);
    expect(image.classList.contains("project-favicon-img-hidden")).toBe(false);

    setRunning(false);
    expect(document.querySelector(".project-favicon-ping")).toBeNull();
    expect(document.querySelector(".project-favicon")).toBe(logo);
  });

  it("supports the letter fallback and leaves inactive logos unchanged", () => {
    dispose = render(() => <ProjectFavicon cwd="" label="Workspace" running />, document.body);
    expect(document.querySelector(".project-favicon-letter")?.textContent).toBe("w");
    expect(document.querySelector(".project-favicon-ping")).not.toBeNull();
    expect(document.querySelector("img")).toBeNull();
  });
});
