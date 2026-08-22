import { createEffect, createSignal, Show } from "solid-js";
import { projectFaviconUrl } from "./api";

const loadedProjectFaviconSrcs = new Set<string>();

type LoadStatus = "loading" | "loaded" | "error";

export function ProjectFavicon(props: {
  cwd: string;
  label?: string;
  class?: string;
}) {
  const src = () => {
    const cwd = props.cwd.trim();
    if (!cwd) return null;
    return projectFaviconUrl(cwd);
  };

  // Check the module cache synchronously so a remount never paints the letter
  // avatar for one frame before the effect flips the image visible.
  const initialSrc = src();
  const [status, setStatus] = createSignal<LoadStatus>(
    initialSrc && loadedProjectFaviconSrcs.has(initialSrc) ? "loaded" : "loading",
  );

  createEffect(() => {
    const next = src();
    setStatus(next && loadedProjectFaviconSrcs.has(next) ? "loaded" : "loading");
  });

  const letter = () => (props.label?.trim()?.[0] ?? ".").toLowerCase();
  const showLetter = () => status() !== "loaded";

  return (
    <span class={`project-favicon${props.class ? ` ${props.class}` : ""}`}>
      <Show when={showLetter()}>
        <span class="project-favicon-letter" aria-hidden="true">
          {letter()}
        </span>
      </Show>
      <Show when={src()}>
        {(url) => (
          <img
            src={url()}
            alt=""
            class="project-favicon-img"
            classList={{ "project-favicon-img-hidden": status() !== "loaded" }}
            onLoad={() => {
              const currentSrc = src();
              if (!currentSrc) return;
              loadedProjectFaviconSrcs.add(currentSrc);
              setStatus("loaded");
            }}
            onError={() => setStatus("error")}
          />
        )}
      </Show>
    </span>
  );
}
