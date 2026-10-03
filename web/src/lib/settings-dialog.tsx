import Dialog from "@corvu/dialog";
import { type JSX } from "solid-js";
import { scrollFade } from "./scroll-fade";
import "./settings-dialog.css";

/** Nest inside the settings sheet so Corvu dismisses only the topmost dialog. */
export function SettingsDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: JSX.Element;
  footer: JSX.Element;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay class="settings-dialog-overlay" />
        <Dialog.Content class="settings-dialog" data-corvu-no-drag>
          <header class="settings-dialog-header">
            <div>
              <Dialog.Label class="settings-dialog-title">{props.title}</Dialog.Label>
              <Dialog.Description class="settings-dialog-description">{props.description}</Dialog.Description>
            </div>
            <Dialog.Close class="bottom-sheet-close" aria-label={`Close ${props.title.toLowerCase()}`}>
              <span aria-hidden="true">×</span>
            </Dialog.Close>
          </header>
          <div class="settings-dialog-body" use:scrollFade="vertical">{props.children}</div>
          <footer class="settings-dialog-footer">{props.footer}</footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  );
}
