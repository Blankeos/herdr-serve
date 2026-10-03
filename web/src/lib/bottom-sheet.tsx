import Drawer from "@corvu/drawer";
import { type JSX } from "solid-js";
import "./bottom-sheet.css";

/** Keep mounted: Corvu owns presence, focus restoration, and exit transitions. */
export function BottomSheet(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: JSX.Element;
}) {
  return (
    <Drawer open={props.open} onOpenChange={props.onOpenChange} side="bottom" breakPoints={[0.75]}>
      {(drawer) => (
        <Drawer.Portal>
          <Drawer.Overlay
            class="bottom-sheet-overlay"
            style={{ "background-color": `rgb(0 0 0 / ${0.6 * drawer.openPercentage})` }}
          />
          <Drawer.Content class="bottom-sheet">
            <div class="bottom-sheet-handle" aria-hidden="true"><span /></div>
            <header class="bottom-sheet-header">
              <div>
                <Drawer.Label as="h2" class="bottom-sheet-title">{props.title}</Drawer.Label>
                <Drawer.Description class="bottom-sheet-description">{props.description}</Drawer.Description>
              </div>
              <Drawer.Close class="bottom-sheet-close" aria-label={`Close ${props.title.toLowerCase()}`} data-corvu-no-drag>
                <span aria-hidden="true">×</span>
              </Drawer.Close>
            </header>
            {props.children}
          </Drawer.Content>
        </Drawer.Portal>
      )}
    </Drawer>
  );
}
