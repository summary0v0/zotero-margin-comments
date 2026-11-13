/** Self-contained: installed in the Reader window to precede PDF capture handlers. */
export function setEditorSelectionGuard(enabled: boolean): boolean {
  const root = window as Window & Record<string, any>;
  const key = "__zmcEditorSelectionGuard";
  const previous = root[key];
  const view = root._reader?._primaryView;
  if (previous && (!enabled || previous.view !== view)) {
    previous.destroy();
    delete root[key];
  }
  if (!enabled) return true;
  if (root[key]) return true;
  const pdfWindow = view?._iframeWindow;
  if (!pdfWindow || !("_nativeTextSelection" in view)) return false;
  const originalNative = view._nativeTextSelection;
  // Desktop PDFView leaves the native-selection hook null. Supply the same
  // disabled/default behaviour while using its early interception points.
  const native = originalNative ?? {
    enabled: false,
    handlePointerDown: () => false,
    shouldDeferEvent: () => false,
    handlePointerUp() {},
    shouldAllowNativeTouch: () => false,
    handleContextMenu: () => false,
    hasSelection: () => false,
    syncNow: () => false,
    updateEnabledState() {},
    destroy() {},
    clear() { view._setSelectionRanges(); },
    handleTextLayerRendered(layer: HTMLElement) { layer.draggable = true; },
  };
  if (typeof native.handlePointerDown !== "function"
    || typeof native?.shouldDeferEvent !== "function") return false;

  const originalDown = native.handlePointerDown;
  const originalDefer = native.shouldDeferEvent;
  let editor: HTMLElement | undefined;
  let releaseTimer: number | undefined;
  const cardFor = (event: Event) => {
    const target = event.target as Element | null;
    return target?.closest?.(".zmc-card");
  };
  const reset = () => {
    if (releaseTimer !== undefined) root.clearTimeout(releaseTimer);
    releaseTimer = undefined;
    editor = undefined;
  };
  const release = () => {
    // Keep ownership through window's pointerup handler, then allow the next
    // PDF gesture normally. Never cancel the browser's native selection action.
    if (releaseTimer !== undefined) root.clearTimeout(releaseTimer);
    releaseTimer = root.setTimeout(reset, 0);
  };
  const down = function (this: any, event: MouseEvent) {
    const card = cardFor(event);
    if (event.button === 0) {
      reset();
      const target = event.target as Element | null;
      const input = target?.closest?.<HTMLElement>(".zmc-card-editor");
      if (input && card) editor = input;
    }
    // PDFView calls this hook before clearing the DOM selection or beginning
    // its own selectText action, including its window-capture mousedown path.
    return card ? true : originalDown.call(this, event);
  };
  const defer = function (this: any, event: Event) {
    if (editor && !editor.isConnected) reset();
    // Once a note owns the drag, moving over the underlying PDF cannot start
    // a PDF selection. The guard also covers pointerup/dragover, not just down.
    return Boolean(cardFor(event) || editor) || originalDefer.call(this, event);
  };
  native.handlePointerDown = down;
  native.shouldDeferEvent = defer;
  view._nativeTextSelection = native;
  pdfWindow.addEventListener("pointerup", release, true);
  pdfWindow.addEventListener("mouseup", release, true);
  pdfWindow.addEventListener("pointercancel", release, true);
  pdfWindow.addEventListener("blur", reset);
  root[key] = {
    view,
    destroy() {
      reset();
      if (native.handlePointerDown === down) native.handlePointerDown = originalDown;
      if (native.shouldDeferEvent === defer) native.shouldDeferEvent = originalDefer;
      if (!originalNative && view._nativeTextSelection === native) view._nativeTextSelection = originalNative;
      pdfWindow.removeEventListener("pointerup", release, true);
      pdfWindow.removeEventListener("mouseup", release, true);
      pdfWindow.removeEventListener("pointercancel", release, true);
      pdfWindow.removeEventListener("blur", reset);
    },
  };
  return true;
}
