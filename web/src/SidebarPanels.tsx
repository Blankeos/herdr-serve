import Resizable from "@corvu/resizable";
import { createSignal, type JSX } from "solid-js";

const STORAGE_KEY = "herdr.sidebarSplit";
const DEFAULT_SIZES = [0.65, 0.35];
const MIN_SIZE = 0.2;

function loadSizes(): number[] {
  try {
    const sizes: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (
      Array.isArray(sizes) &&
      sizes.length === 2 &&
      sizes.every(
        (size) =>
          typeof size === "number" &&
          Number.isFinite(size) &&
          size >= MIN_SIZE &&
          size <= 1 - MIN_SIZE,
      ) &&
      Math.abs(sizes[0] + sizes[1] - 1) < 0.001
    )
      return [sizes[0], 1 - sizes[0]];
  } catch {
    // Missing, corrupt, or blocked storage should never prevent rendering.
  }
  return [...DEFAULT_SIZES];
}

/** Owns the sidebar's vertical split, accessible resizing, and saved proportions. */
export function SidebarPanels(props: { workspaces: JSX.Element; agents: JSX.Element }) {
  const [sizes, setSizes] = createSignal(loadSizes());
  return (
    <Resizable
      orientation="vertical"
      class="sidebar-panels"
      sizes={sizes()}
      onSizesChange={(next) => {
        setSizes(next);
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch {
          // Keep resizing usable even when browser storage is unavailable.
        }
      }}
      keyboardDelta={0.05}
    >
      <Resizable.Panel class="sidebar-workspaces" minSize={MIN_SIZE}>
        {props.workspaces}
      </Resizable.Panel>
      <Resizable.Handle
        class="sidebar-splitter"
        aria-label="Resize workspaces and agents"
        title="Drag to resize · Arrow keys to adjust"
      >
        <span class="sidebar-splitter-grip" aria-hidden="true" />
      </Resizable.Handle>
      <Resizable.Panel class="sidebar-agents" minSize={MIN_SIZE} aria-label="Live agents">
        {props.agents}
      </Resizable.Panel>
    </Resizable>
  );
}
