import { IconSidebarPanel } from "./icons";

export function SidebarToggle(props: { open: boolean; onClick: () => void; class?: string }) {
  return (
    <button
      type="button"
      class={`menu-btn${props.class ? ` ${props.class}` : ""}`}
      aria-label={props.open ? "Close sidebar" : "Open sidebar"}
      title={props.open ? "Close sidebar" : "Open sidebar"}
      aria-expanded={props.open}
      aria-controls="workspace-sidebar"
      onClick={props.onClick}
    >
      <IconSidebarPanel class="sidebar-toggle-icon" aria-hidden="true" />
    </button>
  );
}
