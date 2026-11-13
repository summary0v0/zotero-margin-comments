import {
  COMPACT_NOTE_ICON_OFFSET,
  COMPACT_NOTE_ICON_SIZE,
  ZOTERO_NOTE_ICON_SIZE,
} from "../core/annotation-model";
import type { ViewportLike } from "../core/types";
import { setEditorSelectionGuard } from "./editor-selection-guard";
import {
  analyzePageWhitespace,
  type ContentRect,
  type PageWhitespace,
} from "../core/page-whitespace";

export interface PdfPageHandle {
  pageIndex: number;
  element: HTMLElement;
  viewport: ViewportLike;
  scale: number;
}

type Cleanup = () => void;
const NATIVE_HOVER_STYLE_ID = "zmc-native-hover-styles";
const NATIVE_HOVER_STYLES = `
[data-annotation-id].zmc-native-hover {
  filter: brightness(.9) saturate(1.22) drop-shadow(0 1px 1.5px rgba(0, 0, 0, .28));
  scale: 1.018;
  transform-box: fill-box;
  transform-origin: center;
  transition: filter .14s ease, scale .14s ease;
}
`;

export class Zotero9ReaderAdapter {
  private pdfWindow?: Window & Record<string, any>;
  private pdfDocument?: Document;
  private pdfViewer?: any;
  private internalReader?: any;
  private primaryView?: any;
  private cleanups: Cleanup[] = [];
  private hoveredAnnotationKey?: string;
  private hoveredAnnotationElements: Element[] = [];
  private nativeHoverStyle?: HTMLStyleElement;
  private compactNoteIconsEnabled = false;
  private whitespaceRequests = new Map<string, Promise<PageWhitespace | undefined>>();
  private whitespaceQueue: Promise<unknown> = Promise.resolve();
  private readonly whitespaceBridgeKey = `__zmc_whitespace_${Math.random().toString(36).slice(2)}`;
  private closed = false;

  constructor(readonly reader: any) {}

  async ready(timeoutMs = 10000): Promise<void> {
    await promiseLike(this.reader?._initPromise);
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
      this.internalReader = this.reader?._internalReader;
      this.primaryView = this.internalReader?._primaryView;
      if (this.primaryView) break;
      await delay(30);
    }
    if (!this.primaryView) throw new Error("没有找到 Zotero PDF 主视图");

    // Zotero 9.0.6 exposes internalReader.initializedPromise, but it can remain
    // pending even after the PDF view is fully usable. Zotero itself waits for
    // the concrete primary view instead, so do the same here.
    await promiseLike(this.primaryView?.initializedPromise);

    this.pdfWindow = this.primaryView?._iframeWindow as Window & Record<string, any>;
    this.pdfDocument = this.primaryView?._iframeDocument ?? this.pdfWindow?.document;
    const application = this.pdfWindow?.PDFViewerApplication;
    await promiseLike(application?.initializedPromise);
    this.pdfViewer = application?.pdfViewer;
    await promiseLike(this.pdfViewer?.pagesPromise);

    if (!this.pdfDocument || !this.pdfViewer) {
      throw new Error("Zotero PDF.js 视图尚未就绪");
    }
    this.setEditorSelectionGuard(true);
  }

  viewerElement(): HTMLElement {
    const viewer = this.pdfDocument?.getElementById("viewer");
    if (!viewer || !("classList" in viewer) || !("querySelectorAll" in viewer)) {
      throw new Error("没有找到 PDF 页面容器");
    }
    return viewer as HTMLElement;
  }

  document(): Document {
    if (!this.pdfDocument) throw new Error("ReaderAdapter 尚未就绪");
    return this.pdfDocument;
  }

  page(pageIndex: number): PdfPageHandle | undefined {
    const pageView = this.pdfViewer?.getPageView?.(pageIndex);
    const element = pageView?.div as HTMLElement | undefined;
    const viewport = pageView?.viewport as ViewportLike | undefined;
    if (!element || !viewport) return undefined;
    const rawScale = Number(this.pdfViewer?.currentScale ?? pageView?.scale ?? 1);
    const scale = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1;
    return { pageIndex, element, viewport, scale };
  }

  pageCount(): number {
    return Number(this.pdfViewer?.pagesCount ?? this.pdfViewer?._pages?.length ?? 0);
  }

  /** Render one clean, bounded-size page at a time; cache across zoom changes. */
  pageWhitespace(handle: PdfPageHandle): Promise<PageWhitespace | undefined> {
    const rotation = handle.viewport.rotation ?? 0;
    const key = `${handle.pageIndex}:${rotation}`;
    const cached = this.whitespaceRequests.get(key);
    if (cached) return cached;
    if (this.closed) return Promise.resolve(undefined);
    const request = this.whitespaceQueue.then(async () => {
      if (this.closed) return undefined;
      const pdfWindow = this.pdfWindow;
      const evaluate = pdfWindow?.eval;
      if (typeof evaluate !== "function") return undefined;
      // Gecko's content code cannot read plain JS options created in the
      // privileged addon scope. Build options, canvas and PDF.js calls together
      // in the PDF iframe, then return JSON (never content-owned JS objects).
      const source = `(${renderWhitespaceInPage.toString()})(
        ${Number(handle.pageIndex)}, ${Number(rotation)}, ${JSON.stringify(this.whitespaceBridgeKey)},
        (${analyzePageWhitespace.toString()}), (${textContentRects.toString()})
      )`;
      const serialized = await evaluate.call(pdfWindow, source);
      if (this.closed || typeof serialized !== "string") return undefined;
      return JSON.parse(serialized) as PageWhitespace;
    }).catch((error) => {
      // An unavailable/unsupported render must never hide comments or cover text.
      if (!this.closed) (Zotero as any).logError?.(error);
      return undefined;
    }).then((profile) => {
      // A not-yet-loaded page or transient render failure may succeed on the
      // next pagerendered event. Do not cache a failed scan for the whole session.
      if (!profile) this.whitespaceRequests.delete(key);
      return profile;
    });
    this.whitespaceRequests.set(key, request);
    this.whitespaceQueue = request;
    return request;
  }

  currentPageIndex(): number {
    return Math.max(0, Number(this.pdfViewer?.currentPageNumber ?? 1) - 1);
  }

  onLayoutChange(callback: (reason: string) => void): void {
    const eventBus = this.pdfWindow?.PDFViewerApplication?.eventBus;
    for (const eventName of [
      "pagerendered",
      "scalechanging",
      "rotationchanging",
      "updateviewarea",
      "pagesloaded",
    ]) {
      const schedule = () => {
        if (eventName === "pagerendered" && this.compactNoteIconsEnabled) {
          this.applyCompactNotePatch();
        }
        callback(eventName);
      };
      eventBus?.on?.(eventName, schedule);
      this.cleanups.push(() => eventBus?.off?.(eventName, schedule));
    }

    const resize = () => callback("resize");
    this.pdfWindow?.addEventListener("resize", resize);
    this.cleanups.push(() => this.pdfWindow?.removeEventListener("resize", resize));
  }

  onAnnotationVisibilityChange(callback: () => void): void {
    const internalReader = this.internalReader;
    const originalUpdateState = internalReader?._updateState;
    if (typeof originalUpdateState === "function") {
      let active = true;
      const patchedUpdateState = function (
        this: any,
        state: Record<string, unknown> | undefined,
        ...rest: unknown[]
      ) {
        const result = originalUpdateState.call(this, state, ...rest);
        if (
          active &&
          state &&
          (Object.prototype.hasOwnProperty.call(state, "annotations") ||
            Object.prototype.hasOwnProperty.call(state, "showAnnotations"))
        ) {
          callback();
        }
        return result;
      };

      try {
        internalReader._updateState = patchedUpdateState;
        if (internalReader._updateState === patchedUpdateState) {
          this.cleanups.push(() => {
            active = false;
            if (internalReader._updateState === patchedUpdateState) {
              internalReader._updateState = originalUpdateState;
            }
          });
          return;
        }
      } catch {
        // Some cross-window wrappers can reject method replacement. Poll below.
      }
      active = false;
    }

    const pdfWindow = this.pdfWindow;
    if (!pdfWindow) return;
    let previous = this.annotationVisibilitySignature();
    const timer = pdfWindow.setInterval(() => {
      const next = this.annotationVisibilitySignature();
      if (next === previous) return;
      previous = next;
      callback();
    }, 250);
    this.cleanups.push(() => pdfWindow.clearInterval(timer));
  }

  onNativeSelectionChange(callback: (ids: string[]) => void): void {
    const handler = () => {
      this.pdfWindow?.setTimeout(() => callback(this.selectedAnnotationIDs()), 0);
    };
    this.pdfDocument?.addEventListener("pointerup", handler, true);
    this.pdfDocument?.addEventListener("keyup", handler, true);
    this.cleanups.push(() => {
      this.pdfDocument?.removeEventListener("pointerup", handler, true);
      this.pdfDocument?.removeEventListener("keyup", handler, true);
    });
  }

  selectedAnnotationIDs(): string[] {
    const ids = this.internalReader?._state?.selectedAnnotationIDs;
    return Array.isArray(ids) ? ids.map(String) : [];
  }

  visibleAnnotationIDs(): ReadonlySet<string> | undefined {
    const state = this.internalReader?._state;
    const annotations = state?.annotations;
    if (!Array.isArray(annotations)) return undefined;
    if (state?.showAnnotations === false) return new Set<string>();

    const ids = new Set<string>();
    for (const annotation of annotations) {
      if (!annotation || annotation._hidden) continue;
      const id = annotation.id ?? annotation.key;
      if (id !== undefined && id !== null) ids.add(String(id));
    }
    return ids;
  }

  selectAnnotation(key: string): void {
    this.internalReader?.setSelectedAnnotations?.([key]);
    void this.reader?.navigate?.({ annotationID: key });
  }

  centerCurrentPageHorizontally(): void {
    const viewer = this.viewerElement();
    const viewport = viewer.closest<HTMLElement>("#viewerContainer")
      ?? viewer.parentElement;
    if (!viewport) return;

    const currentPageNumber = Number(this.pdfViewer?.currentPageNumber ?? 1);
    const pageView = this.pdfViewer?.getPageView?.(
      Math.max(0, currentPageNumber - 1),
    );
    const page = pageView?.div as HTMLElement | undefined;
    if (!page) return;

    const viewportRect = viewport.getBoundingClientRect();
    const pageRect = page.getBoundingClientRect();
    if (!(pageRect.width || pageRect.height)) return;
    const viewportWidth = viewport.clientWidth || viewportRect.width;
    if (!(viewportWidth > 0)) return;

    const viewportCenter = viewportRect.left + viewport.clientLeft + viewportWidth / 2;
    const pageCenter = pageRect.left + pageRect.width / 2;
    const delta = pageCenter - viewportCenter;
    if (Number.isFinite(delta) && Math.abs(delta) > 0.5) {
      viewport.scrollLeft += delta;
    }
  }

  setAnnotationHover(key: string, hovered: boolean): void {
    if (!hovered && this.hoveredAnnotationKey !== key) return;
    this.clearAnnotationHover();
    if (!hovered) return;

    this.hoveredAnnotationKey = key;
    this.ensureNativeHoverStyle();
    this.hoveredAnnotationElements = this.nativeAnnotationElements(key);
    for (const element of this.hoveredAnnotationElements) {
      element.classList.add("zmc-native-hover");
    }
  }

  setCompactNoteIcons(enabled: boolean, _annotationKeys: readonly string[]): void {
    this.compactNoteIconsEnabled = enabled;
    this.applyCompactNotePatch();
  }

  scheduleAnimationFrame(callback: () => void): Cleanup {
    const requestFrame = this.pdfWindow?.requestAnimationFrame;
    const cancelFrame = this.pdfWindow?.cancelAnimationFrame;
    if (typeof requestFrame === "function") {
      const id = requestFrame.call(this.pdfWindow, callback);
      return () => cancelFrame?.call(this.pdfWindow, id);
    }
    const timer = setTimeout(callback, 16);
    return () => clearTimeout(timer);
  }

  scheduleIdleCallback(callback: () => void, timeoutMs = 500): Cleanup {
    const requestIdle = this.pdfWindow?.requestIdleCallback;
    const cancelIdle = this.pdfWindow?.cancelIdleCallback;
    if (typeof requestIdle === "function") {
      const id = requestIdle.call(this.pdfWindow, callback, { timeout: timeoutMs });
      return () => cancelIdle?.call(this.pdfWindow, id);
    }
    const pdfWindow = this.pdfWindow;
    if (pdfWindow) {
      const timer = pdfWindow.setTimeout(callback, 32);
      return () => pdfWindow.clearTimeout(timer);
    }
    const timer = setTimeout(callback, 32);
    return () => clearTimeout(timer);
  }

  destroy(): void {
    this.setEditorSelectionGuard(false);
    this.closed = true;
    try {
      this.pdfWindow?.eval?.(`(() => {
        const key = ${JSON.stringify(this.whitespaceBridgeKey)};
        const state = window[key];
        if (state) { state.closed = true; state.task?.cancel(); delete window[key]; }
      })()`);
    } catch {
      // The iframe may already have been destroyed when its Reader closes.
    }
    this.whitespaceRequests.clear();
    this.clearAnnotationHover();
    this.nativeHoverStyle?.remove();
    this.nativeHoverStyle = undefined;
    this.compactNoteIconsEnabled = false;
    this.applyCompactNotePatch();
    for (const cleanup of this.cleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        // Reader teardown can leave dead cross-compartment wrappers.
      }
    }
    this.pdfViewer = undefined;
    this.pdfDocument = undefined;
    this.pdfWindow = undefined;
    this.primaryView = undefined;
    this.internalReader = undefined;
  }

  private setEditorSelectionGuard(enabled: boolean): void {
    const readerWindow = this.reader?._iframeWindow;
    const evaluate = readerWindow?.eval;
    if (typeof evaluate !== "function") return;
    try {
      evaluate.call(readerWindow, `(${setEditorSelectionGuard.toString()})(${enabled})`);
    } catch (error) { (Zotero as any).logError?.(error); }
  }

  private nativeAnnotationElements(key: string): Element[] {
    const shadow = this.annotationShadowRoot();
    const roots = [
      this.primaryView?._annotationRenderRootEl
        ?? shadow?.getElementById("annotation-render-root"),
      shadow,
      this.pdfDocument,
    ].filter((root): root is ParentNode => Boolean(root?.querySelectorAll));
    const matches = new Set<Element>();
    for (const root of roots) {
      const elements = Array.from(
        root.querySelectorAll("[data-annotation-id]"),
      ) as unknown as Element[];
      for (const element of elements) {
        if (element.getAttribute("data-annotation-id") !== key) continue;
        const ancestor = element.parentElement?.closest("[data-annotation-id]");
        if (ancestor?.getAttribute("data-annotation-id") === key) continue;
        matches.add(element);
      }
    }
    return [...matches];
  }

  private annotationVisibilitySignature(): string {
    const state = this.internalReader?._state;
    const annotations = state?.annotations;
    if (!Array.isArray(annotations)) return "unavailable";
    // Polling is also the content-change fallback when _updateState cannot be
    // wrapped. IDs alone never change when the first comment is entered.
    return JSON.stringify([
      state?.showAnnotations !== false,
      annotations.map((annotation: any) => [
        annotation?.id ?? annotation?.key,
        Boolean(annotation?._hidden),
        annotation?.type,
        annotation?.comment,
        annotation?.color,
        annotation?.pageLabel,
        annotation?.position,
        annotation?.readOnly,
      ]),
    ]);
  }

  private applyCompactNotePatch(): void {
    const readerWindow = this.reader?._iframeWindow as
      | (Window & Record<string, any>)
      | undefined;
    const evaluate = readerWindow?.eval;
    if (typeof evaluate !== "function") return;

    try {
      evaluate.call(
        readerWindow,
        compactNotePatchSource(this.compactNoteIconsEnabled),
      );
    } catch (error) {
      (Zotero as any).logError?.(error);
    }
  }

  private ensureNativeHoverStyle(): void {
    const shadow = this.annotationShadowRoot();
    if (!shadow || shadow.getElementById(NATIVE_HOVER_STYLE_ID)) return;
    const style = this.pdfDocument?.createElement("style");
    if (!style) return;
    style.id = NATIVE_HOVER_STYLE_ID;
    style.textContent = NATIVE_HOVER_STYLES;
    shadow.append(style);
    this.nativeHoverStyle = style;
  }

  private annotationShadowRoot(): ShadowRoot | undefined {
    const direct = this.primaryView?._annotationShadowRoot as ShadowRoot | undefined;
    if (direct?.querySelectorAll) return direct;

    const host = this.pdfDocument?.getElementById("annotation-overlay") as
      | (HTMLElement & { shadowRoot?: ShadowRoot | null })
      | null;
    if (host?.shadowRoot) return host.shadowRoot;

    const renderRoot = this.primaryView?._annotationRenderRootEl as
      | HTMLElement
      | undefined;
    const root = renderRoot?.getRootNode?.();
    return root && "host" in root ? root as ShadowRoot : undefined;
  }

  private clearAnnotationHover(): void {
    for (const element of this.hoveredAnnotationElements) {
      element.classList.remove("zmc-native-hover");
    }
    this.hoveredAnnotationElements = [];
    this.hoveredAnnotationKey = undefined;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function promiseLike(value: unknown): Promise<unknown> {
  return value && typeof (value as PromiseLike<unknown>).then === "function"
    ? Promise.resolve(value)
    : Promise.resolve();
}

/** Self-contained: executed in the PDF iframe, not the privileged addon scope. */
async function renderWhitespaceInPage(
  pageIndex: number,
  rotation: number,
  key: string,
  analyze: typeof analyzePageWhitespace,
  textBounds: typeof textContentRects,
): Promise<string | undefined> {
  const root = window as Window & Record<string, any>;
  const pdfPage = root.PDFViewerApplication?.pdfViewer?.getPageView?.(pageIndex)?.pdfPage;
  if (!pdfPage) return undefined;
  const state = root[key] ??= { closed: false, task: undefined };
  if (state.closed) return undefined;
  const native = pdfPage.getViewport({ scale: 1, rotation });
  const scale = Math.min(1.5, 1000 / native.width, 1400 / native.height);
  const viewport = pdfPage.getViewport({ scale, rotation });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  try {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return undefined;
    const task = pdfPage.render({
      canvasContext: context, viewport,
      background: "rgb(255,255,255)", annotationMode: 0,
    });
    state.task = task;
    await task.promise;
    if (state.closed) return undefined;
    const text = await pdfPage.getTextContent();
    if (state.closed) return undefined;
    return JSON.stringify(analyze(
      context.getImageData(0, 0, canvas.width, canvas.height),
      textBounds(text, viewport, canvas.width, canvas.height),
    ));
  } finally {
    state.task = undefined;
    canvas.width = canvas.height = 0;
  }
}

function textContentRects(
  text: any,
  viewport: any,
  width: number,
  height: number,
): ContentRect[] {
  const v = viewport.transform as number[];
  if (!v || v.length !== 6) return [];
  const rects: ContentRect[] = [];
  for (const item of text?.items ?? []) {
    if (!item.str?.trim() || !item.transform) continue;
    const t = item.transform as number[];
    const a = v[0] * t[0] + v[2] * t[1];
    const b = v[1] * t[0] + v[3] * t[1];
    const c = v[0] * t[2] + v[2] * t[3];
    const d = v[1] * t[2] + v[3] * t[3];
    const x = v[0] * t[4] + v[2] * t[5] + v[4];
    const y = v[1] * t[4] + v[3] * t[5] + v[5];
    const advance = Math.abs(item.width) * viewport.scale;
    const length = Math.hypot(a, b) || 1;
    const dx = a / length * advance;
    const dy = b / length * advance;
    const style = text.styles?.[item.fontName];
    const ascent = Number.isFinite(style?.ascent) ? style.ascent : 1;
    const descent = Number.isFinite(style?.descent) ? style.descent : -0.25;
    const points = [
      [x + c * ascent, y + d * ascent],
      [x + c * descent, y + d * descent],
      [x + dx + c * ascent, y + dy + d * ascent],
      [x + dx + c * descent, y + dy + d * descent],
    ];
    rects.push({
      left: (Math.min(...points.map((p) => p[0])) - 1) / width,
      right: (Math.max(...points.map((p) => p[0])) + 1) / width,
      top: (Math.min(...points.map((p) => p[1])) - 1) / height,
      bottom: (Math.max(...points.map((p) => p[1])) + 1) / height,
    });
  }
  return rects;
}

function compactNotePatchSource(enabled: boolean): string {
  return `(() => {
    const enabled = ${enabled ? "true" : "false"};
    const iconSize = ${ZOTERO_NOTE_ICON_SIZE};
    const compactSize = ${COMPACT_NOTE_ICON_SIZE};
    const compactOffset = ${COMPACT_NOTE_ICON_OFFSET};
    const stateKey = "__zmcCompactNotePatchV2";
    const root = window;
    const view = root._reader?._primaryView;
    let state = root[stateKey];
    if (!state) {
      state = root[stateKey] = { rendererPatches: [], viewPatches: [] };
    }

    let changed = false;

    const getPage = (owner, pageIndex) => {
      if (typeof owner?.getPageByIndex === "function") {
        const page = owner.getPageByIndex(pageIndex);
        if (page) return page;
      }
      return owner?._pages?.find?.((page) => page?._pageIndex === pageIndex)
        ?? owner?._pages?.[pageIndex];
    };

    const compactHit = (owner, annotation, position) => {
      if (!annotation?.position?.rects?.[0] || !position?.rects?.[0]) return null;
      const page = getPage(owner, annotation.position.pageIndex);
      const renderer = page?._pageRenderer;
      if (typeof renderer?._p2v !== "function") return null;

      const notePosition = renderer._p2v(annotation.position);
      const pointerPosition = renderer._p2v(position);
      const noteRect = notePosition?.rects?.[0];
      const pointerRect = pointerPosition?.rects?.[0];
      const scale = Number(renderer._scale);
      if (!noteRect || !pointerRect || !(scale > 0)) return null;

      const left = noteRect[0] + compactOffset * scale;
      const top = noteRect[1] + compactOffset * scale;
      const right = left + compactSize * scale;
      const bottom = top + compactSize * scale;
      const x = (pointerRect[0] + pointerRect[2]) / 2;
      const y = (pointerRect[1] + pointerRect[3]) / 2;
      return x >= left && x <= right && y >= top && y <= bottom;
    };

    const installRendererPatch = (renderer) => {
      const prototype = renderer && Object.getPrototypeOf(renderer);
      if (!prototype || typeof prototype._drawNote !== "function") return;
      let patch = state.rendererPatches.find((item) => item.prototype === prototype);
      if (!patch) {
        patch = {
          prototype,
          original: prototype._drawNote,
          wrapper: null,
          enabled: false,
        };
        patch.wrapper = function(annotation) {
          if (!patch.enabled) return patch.original.call(this, annotation);
          if (!this._context || typeof this._p2v !== "function") {
            return patch.original.call(this, annotation);
          }
          const position = this._p2v(annotation.position);
          const viewRect = position?.rects?.[0];
          const scale = Number(this._scale);
          if (!viewRect || !(scale > 0)) return patch.original.call(this, annotation);

          const compactScale = scale * compactSize / iconSize;
          const offset = compactOffset * scale;
          this._context.save();
          this._context.transform(
            compactScale, 0, 0, compactScale,
            viewRect[0] + offset,
            viewRect[1] + offset,
          );
          this._drawNoteIcon(this._context, annotation.color);
          this._context.restore();
        };
        state.rendererPatches.push(patch);
      }

      if (enabled) {
        patch.enabled = true;
        if (prototype._drawNote !== patch.wrapper) {
          patch.original = prototype._drawNote;
          prototype._drawNote = patch.wrapper;
          changed = true;
        }
      }
      else {
        patch.enabled = false;
        if (prototype._drawNote === patch.wrapper) {
          prototype._drawNote = patch.original;
          changed = true;
        }
      }
    };

    const installViewPatch = (owner) => {
      const prototype = owner && Object.getPrototypeOf(owner);
      if (!prototype
        || typeof prototype.getSelectableAnnotations !== "function"
        || typeof prototype.getSelectedAnnotationAction !== "function") return;
      let patch = state.viewPatches.find((item) => item.prototype === prototype);
      if (!patch) {
        patch = {
          prototype,
          originalSelectable: prototype.getSelectableAnnotations,
          originalSelectedAction: prototype.getSelectedAnnotationAction,
          selectableWrapper: null,
          selectedActionWrapper: null,
          enabled: false,
        };
        patch.selectableWrapper = function(position) {
          const result = patch.originalSelectable.apply(this, arguments);
          if (!patch.enabled || !Array.isArray(result)) return result;
          return result.filter((annotation) =>
            annotation?.type !== "note" || compactHit(this, annotation, position) !== false
          );
        };
        patch.selectedActionWrapper = function(annotation, position) {
          if (patch.enabled
            && annotation?.type === "note"
            && compactHit(this, annotation, position) === false) return null;
          return patch.originalSelectedAction.apply(this, arguments);
        };
        state.viewPatches.push(patch);
      }

      if (enabled) {
        patch.enabled = true;
        if (prototype.getSelectableAnnotations !== patch.selectableWrapper) {
          patch.originalSelectable = prototype.getSelectableAnnotations;
          prototype.getSelectableAnnotations = patch.selectableWrapper;
          changed = true;
        }
        if (prototype.getSelectedAnnotationAction !== patch.selectedActionWrapper) {
          patch.originalSelectedAction = prototype.getSelectedAnnotationAction;
          prototype.getSelectedAnnotationAction = patch.selectedActionWrapper;
          changed = true;
        }
      }
      else {
        patch.enabled = false;
        if (prototype.getSelectableAnnotations === patch.selectableWrapper) {
          prototype.getSelectableAnnotations = patch.originalSelectable;
          changed = true;
        }
        if (prototype.getSelectedAnnotationAction === patch.selectedActionWrapper) {
          prototype.getSelectedAnnotationAction = patch.originalSelectedAction;
          changed = true;
        }
      }
    };

    for (const patch of state.rendererPatches) patch.enabled = enabled;
    for (const patch of state.viewPatches) patch.enabled = enabled;
    if (view) {
      installViewPatch(view);
      for (const page of view._pages ?? []) {
        installRendererPatch(page?._pageRenderer);
        installRendererPatch(page?._detailRenderer);
      }
    }

    if (changed) {
      for (const page of view?._pages ?? []) {
        page?._pageRenderer?._invalidateSignature?.();
        page?._detailRenderer?._invalidateSignature?.();
        page?.render?.();
      }
    }
    return true;
  })()`;
}
