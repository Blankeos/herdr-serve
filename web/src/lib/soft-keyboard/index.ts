export { default as SoftKeyboard } from "./SoftKeyboard";
export { createDomSoftKeyboard } from "./dom-keyboard";
export type { DomSoftKeyboard, DomSoftKeyboardOptions } from "./dom-keyboard";
export { createDictation, speechSupported } from "./speech";
export {
  AUTO_RETURN_PUNCT,
  EDGE_MOD_FLEX,
  PUNCT_FLEX,
  isAutoReturnPunct,
  layoutRows,
} from "./layouts";
export type {
  SoftKeyDef,
  SoftKeyId,
  SoftKeyboardHandlers,
  SoftKeyboardLayout,
  SoftKeyboardProps,
} from "./types";
