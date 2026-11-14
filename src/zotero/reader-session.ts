import {
  annotationAnchor,
  compactNoteAnchor,
  shouldDisplayAnnotation,
} from "../core/annotation-model";
import {
  layoutCollapsibleMargin,
  type PositionedLayoutItem,
} from "../core/margin-layout";
import { assignMarginSides, canUseEitherMargin } from "../core/margin-side";
import { imageMarkdown } from "../core/image-reference";
import { DEFAULT_FONT_SIZE, normalizeFontSize } from "../core/font-size";
import {
  placeMarginInWhitespace,
  normalizeCardWidth,
  PREFERRED_CARD_WIDTH,
  type MarginPlacement,
  type PageWhitespace,
} from "../core/page-whitespace";
import {
  MARGIN_ANNOTATION_TYPES,
  type MarginAnnotation,
  type MarginAnnotationType,
  type PageAnchor,
} from "../core/types";
import { AnnotationStore } from "./annotation-store";
import { renderCommentImages, renderMarkdownComment } from "./markdown-preview";
import { ImageAssets, copyImageBytes, type ImportedImage, type ImageCleanupResult } from "./image-assets";
import { renderAssetImage, openImageLightbox } from "./image-preview";
import { captureEditorRange, insertImageText } from "./image-insertion";
import {
  readStoredComment,
  renderStoredComment,
  selectEditorContents,
} from "./rich-text-editor";
import {
  type PdfPageHandle,
  Zotero9ReaderAdapter,
} from "./reader-adapter";
import { PDF_STYLES } from "./styles";

const SVG_NS = "http://www.w3.org/2000/svg";
const STYLE_ID = "zmc-pdf-styles";
const LAYOUT_PADDING = 8;
const CARD_GAP = 8;
const SUMMARY_HEIGHT = 34;
const EXPANDED_TOP_PADDING = 48;
const FILTER_UI_SETTLE_MS = 80;

type MarginSide = PageAnchor["side"];

interface CardRuntime {
  annotation: MarginAnnotation;
  anchor: PageAnchor;
  card: HTMLElement;
  preview: HTMLDivElement;
  editor: HTMLElement;
  imagePreview: HTMLElement;
  state: HTMLElement;
  originalValue: string;
  currentValue: string;
  dirty: boolean;
  saving: boolean;
  pendingImages: number;
  imageEpoch: number;
  closeAfterImage?: boolean;
  cleanupHold?: () => void;
  measuredHeight?: number;
  heightMode?: string;
  timer?: ReturnType<typeof setTimeout>;
  statusTimer?: ReturnType<typeof setTimeout>;
}

interface MountedPage {
  handle: PdfPageHandle;
  overlay: HTMLElement;
  lines: SVGSVGElement;
  cards: HTMLElement;
  columns: Record<MarginSide, MarginColumnRuntime>;
  runtimes: CardRuntime[];
  positions: Map<string, PositionedLayoutItem>;
  whitespace?: PageWhitespace;
  pendingWhitespace?: PageWhitespace;
  whitespaceRotation?: number;
  whitespaceRequested?: boolean;
}

interface MarginColumnRuntime {
  side: MarginSide;
  root: HTMLElement;
  scrollport: HTMLElement;
  content: HTMLElement;
  toggle: HTMLButtonElement;
  placement: MarginPlacement;
}

export class ReaderSession {
  private readonly adapter: Zotero9ReaderAdapter;
  private readonly images: ImageAssets;
  private closeLightbox?: () => void;
  private imageCleanup?: Promise<ImageCleanupResult>;
  private readonly forcedKeys = new Set<string>();
  private readonly mountedPages = new Map<number, MountedPage>();
  private readonly expandedMargins = new Set<string>();
  private readonly marginSides = new Map<string, {
    position: string;
    rotations: Map<number, MarginSide>;
  }>();
  private visibleTypes = new Set<MarginAnnotationType>(MARGIN_ANNOTATION_TYPES);
  private annotations: MarginAnnotation[] = [];
  private annotationsSignature = "";
  private nativeVisibleIDs?: ReadonlySet<string>;
  private activeKey?: string;
  private hoveredKey?: string;
  private compactNoteIcons = false;
  private collapseNotes = true;
  private cardWidth = PREFERRED_CARD_WIDTH;
  private fontSize = DEFAULT_FONT_SIZE;
  private enabled = true;
  private started = false;
  private adapterReady = false;
  private destroyed = false;
  private initializePromise?: Promise<void>;
  private pendingRefresh = false;
  private cancelRenderFrame?: () => void;
  private cancelVisibilityFrame?: () => void;
  private visibilityTimer?: ReturnType<typeof setTimeout>;
  private pendingVisibilityPages: MountedPage[] = [];
  private renderFramesRemaining = 0;
  private centerFramesRemaining = 0;
  private overlayRoot?: HTMLElement;

  constructor(
    readonly reader: any,
    private readonly store: AnnotationStore,
    private readonly onStateChange: () => void,
  ) {
    this.adapter = new Zotero9ReaderAdapter(reader);
    this.images = new ImageAssets(this.attachmentID);
  }

  get attachmentID(): number {
    return Number(this.reader?.itemID);
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  async start(enabled: boolean): Promise<void> {
    if (this.destroyed) return;
    this.enabled = enabled;
    this.initializePromise ??= this.initialize();
    await this.initializePromise;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (enabled && this.adapterReady) {
      void this.refresh();
    } else {
      this.removeUi();
    }
    this.onStateChange();
  }

  setVisibleTypes(types: ReadonlySet<MarginAnnotationType>): void {
    if (
      this.visibleTypes.size === types.size
      && [...types].every((type) => this.visibleTypes.has(type))
    ) {
      return;
    }
    this.visibleTypes = new Set(types);
    if (!this.enabled || !this.adapterReady) return;
    if (this.hasBlockingEditor()) {
      this.pendingRefresh = true;
      return;
    }
    this.render();
  }

  setCompactNoteIcons(enabled: boolean): void {
    if (this.compactNoteIcons === enabled) return;
    this.compactNoteIcons = enabled;
    if (this.adapterReady) {
      this.syncCompactNoteIcons();
      if (this.enabled) this.render();
    }
  }

  setCollapseNotes(enabled: boolean): void {
    if (this.collapseNotes === enabled) return;
    this.collapseNotes = enabled;
    if (this.enabled && this.adapterReady) this.render();
  }

  setCardWidth(value: number): void {
    const width = normalizeCardWidth(value);
    if (width === this.cardWidth) return;
    this.cardWidth = width;
    if (this.enabled && this.adapterReady) this.render();
  }

  setFontSize(value: number): void {
    const size = normalizeFontSize(value);
    if (size === this.fontSize) return;
    this.fontSize = size;
    if (this.enabled && this.adapterReady) {
      // Relayout existing cards without replacing a draft or its DOM selection.
      for (const mounted of this.mountedPages.values()) this.layoutPage(mounted);
    }
  }

  async reveal(keys: readonly string[]): Promise<void> {
    keys.forEach((key) => this.forcedKeys.add(String(key)));
    if (!this.enabled) this.setEnabled(true);
    await this.refresh(true);
    const first = keys[0] && String(keys[0]);
    if (!first) return;

    this.setActive(first);
    setTimeout(() => {
      const runtime = this.cardRuntimes().find(
        (candidate) => candidate.annotation.key === first,
      );
      if (runtime) this.openEditor(runtime, true);
    }, 0);
  }

  async refresh(force = false): Promise<void> {
    if (this.destroyed || !Number.isInteger(this.attachmentID)) return;
    if (!force && this.hasBlockingEditor()) {
      this.pendingRefresh = true;
      return;
    }

    this.pendingRefresh = false;
    this.annotations = this.store.list(this.attachmentID);
    this.annotationsSignature = JSON.stringify(this.annotations);
    const keys = new Set(this.annotations.map((annotation) => annotation.key));
    for (const key of this.marginSides.keys()) {
      if (!keys.has(key)) this.marginSides.delete(key);
    }
    if (this.adapterReady) {
      // A save notification can arrive before the debounced Reader callback.
      // Never classify a newly saved card against the IDs cached on PDF open.
      this.nativeVisibleIDs = this.adapter.visibleAnnotationIDs();
      this.syncCompactNoteIcons();
    }
    if (this.enabled && this.adapterReady) this.render();
  }

  destroy(): void {
    this.destroyed = true;
    this.adapterReady = false;
    this.cancelRenderFrame?.();
    this.cancelRenderFrame = undefined;
    this.cancelVisibilityFrame?.();
    this.cancelVisibilityFrame = undefined;
    if (this.visibilityTimer) clearTimeout(this.visibilityTimer);
    this.visibilityTimer = undefined;
    this.pendingVisibilityPages = [];
    this.renderFramesRemaining = 0;
    this.centerFramesRemaining = 0;
    this.removeUi();
    this.marginSides.clear();
    this.images.clear();
    this.adapter.destroy();
  }

  private scheduleRender(frames = 4): void {
    if (this.destroyed || !this.enabled || !this.adapterReady) return;
    this.renderFramesRemaining = Math.max(this.renderFramesRemaining, frames);
    if (this.cancelRenderFrame) return;
    this.cancelRenderFrame = this.adapter.scheduleAnimationFrame(() => {
      this.cancelRenderFrame = undefined;
      if (this.hasBlockingEditor()) {
        this.pendingRefresh = true;
        // Keep drafts and side choices while tracking PDF zoom immediately.
        for (const mounted of this.mountedPages.values()) {
          const handle = this.adapter.page(mounted.handle.pageIndex);
          if (!handle || handle.element !== mounted.handle.element) continue;
          mounted.handle = handle;
          for (const runtime of mounted.runtimes) {
            runtime.anchor = this.annotationAnchorForHandle(
              runtime.annotation, handle, runtime.anchor.side,
            ) ?? runtime.anchor;
          }
          this.layoutPage(mounted);
        }
      } else {
        this.render();
      }
      if (this.centerFramesRemaining) {
        this.adapter.centerCurrentPageHorizontally();
        this.centerFramesRemaining = Math.max(0, this.centerFramesRemaining - 1);
      }
      this.renderFramesRemaining = Math.max(0, this.renderFramesRemaining - 1);
      if (this.renderFramesRemaining) this.scheduleRender(0);
    });
  }

  private render(): void {
    if (!this.started || !this.adapterReady || this.destroyed || !this.enabled) return;
    const doc = this.adapter.document();
    const viewer = this.adapter.viewerElement();
    this.ensureStyles(doc);

    const displayable = this.annotations.filter(
      (annotation) =>
        this.visibleTypes.has(annotation.type)
        && shouldDisplayAnnotation(annotation, this.forcedKeys),
    );
    const hasDisplayableAnnotations = displayable.length > 0;
    viewer.classList.toggle("zmc-viewer", hasDisplayableAnnotations);
    if (hasDisplayableAnnotations) {
      this.ensureOverlayRoot(doc, viewer);
    } else {
      viewer.style.removeProperty("--zmc-gutter-width");
      for (const pageIndex of [...this.mountedPages.keys()]) {
        this.unmountPage(pageIndex);
      }
      this.overlayRoot?.remove();
      this.overlayRoot = undefined;
      return;
    }
    const pageIndexes = new Set(
      displayable.map((annotation) => annotation.position.pageIndex),
    );

    for (const pageIndex of [...this.mountedPages.keys()]) {
      if (!pageIndexes.has(pageIndex)) this.unmountPage(pageIndex);
    }

    let waitingForPage = false;
    for (const pageIndex of pageIndexes) {
      const handle = this.adapter.page(pageIndex);
      if (!handle) {
        const mounted = this.mountedPages.get(pageIndex);
        if (mounted && !mounted.handle.element.isConnected) {
          this.unmountPage(pageIndex);
        }
        if (pageIndex < this.adapter.pageCount()) waitingForPage = true;
        continue;
      }
      const pageAnnotations = displayable.filter(
        (annotation) => annotation.position.pageIndex === pageIndex,
      );
      this.renderPage(handle, pageAnnotations);
    }
    this.syncActiveCards();
    this.syncViewerGutters(viewer);
    if (waitingForPage) this.scheduleRender(1);
  }

  private async initialize(): Promise<void> {
    await this.adapter.ready();
    if (this.destroyed) return;

    this.adapterReady = true;
    this.started = true;
    this.nativeVisibleIDs = this.adapter.visibleAnnotationIDs();
    this.adapter.onLayoutChange((reason) => {
      if (reason === "pagerendered") {
        for (const mounted of this.mountedPages.values()) {
          if (!mounted.whitespace) mounted.whitespaceRequested = false;
        }
      }
      if (reason === "scalechanging") {
        this.centerFramesRemaining = Math.max(this.centerFramesRemaining, 4);
      }
      this.scheduleRender();
    });
    this.adapter.onAnnotationVisibilityChange(() => {
      this.scheduleVisibilityUpdate();
    });
    this.adapter.onNativeSelectionChange((ids) => {
      if (ids.length === 1) this.setActive(ids[0]);
    });
    await this.refresh(true);
    if (!this.destroyed && typeof this.store.listAllComments === "function") {
      this.imageCleanup = this.images.cleanupUnused(
        () => this.store.listAllComments(this.attachmentID), () => !this.destroyed,
      );
      void this.imageCleanup.catch((error) => (Zotero as any).logError?.(error));
    }
    this.onStateChange();
  }

  private renderPage(
    handle: PdfPageHandle,
    annotations: MarginAnnotation[],
  ): void {
    const prepared = this.preparePageAnnotations(handle, annotations);
    const existing = this.mountedPages.get(handle.pageIndex);
    if (
      existing?.handle.element === handle.element &&
      this.updateMountedPage(existing, handle, prepared)
    ) {
      return;
    }

    this.unmountPage(handle.pageIndex);
    const doc = handle.element.ownerDocument;
    const overlay = doc.createElement("div");
    const lines = doc.createElementNS(SVG_NS, "svg") as SVGSVGElement;
    const cards = doc.createElement("div");
    const columns = {
      left: this.createMarginColumn(doc, "left"),
      right: this.createMarginColumn(doc, "right"),
    };
    overlay.className = "zmc-page-overlay";
    overlay.classList.toggle("zmc-no-collapse", !this.collapseNotes);
    lines.classList.add("zmc-line-layer");
    cards.className = "zmc-card-layer";
    cards.append(columns.left.root, columns.right.root);
    overlay.append(lines, cards);
    handle.element.classList.add("zmc-page");
    this.overlayRoot?.append(overlay);

    const mounted: MountedPage = {
      handle,
      overlay,
      lines,
      cards,
      columns,
      runtimes: [],
      positions: new Map(),
    };
    this.mountedPages.set(handle.pageIndex, mounted);
    for (const column of [columns.left, columns.right]) {
      column.toggle.addEventListener("click", () => {
        this.toggleMargin(mounted, column.side);
      });
      column.scrollport.addEventListener("scroll", () => {
        this.redrawLeaderLines(mounted);
      });
    }

    for (const { annotation, anchor } of prepared) {
      const runtime = this.createCard(doc, annotation, anchor, handle.pageIndex);
      runtime.card.classList.toggle(
        "zmc-filtered",
        !this.isNativeAnnotationVisible(annotation.key),
      );
      mounted.runtimes.push(runtime);
      columns[anchor.side].content.append(runtime.card);
    }
    this.layoutPage(mounted);
  }

  private updateMountedPage(
    mounted: MountedPage,
    handle: PdfPageHandle,
    prepared: { annotation: MarginAnnotation; anchor: PageAnchor }[],
  ): boolean {
    if (prepared.length !== mounted.runtimes.length) return false;
    const byKey = new Map(
      prepared.map((entry) => [entry.annotation.key, entry] as const),
    );
    if (
      mounted.runtimes.some(
        (runtime) => !byKey.has(runtime.annotation.key),
      )
    ) {
      return false;
    }

    mounted.handle = handle;
    if (mounted.pendingWhitespace) {
      mounted.whitespace = mounted.pendingWhitespace;
      mounted.pendingWhitespace = undefined;
    }
    mounted.overlay.classList.toggle("zmc-no-collapse", !this.collapseNotes);
    for (const runtime of mounted.runtimes) {
      const entry = byKey.get(runtime.annotation.key)!;
      const annotationChanged = runtime.annotation !== entry.annotation;
      const wasReadOnly = runtime.annotation.readOnly;
      const previousSide = runtime.anchor.side;
      runtime.annotation = entry.annotation;
      runtime.anchor = entry.anchor;
      if (previousSide !== entry.anchor.side) {
        runtime.card.classList.toggle("zmc-card-left", entry.anchor.side === "left");
        runtime.card.classList.toggle("zmc-card-right", entry.anchor.side === "right");
        mounted.columns[entry.anchor.side].content.append(runtime.card);
      }

      if (annotationChanged) {
        runtime.card.style.setProperty("--zmc-color", entry.annotation.color);
        runtime.editor.contentEditable = String(!entry.annotation.readOnly);
        runtime.editor.dataset.placeholder =
          entry.annotation.type === "note"
            ? "点击输入独立评论…"
            : "点击输入划线解释…";
        runtime.editor.setAttribute(
          "aria-readonly",
          String(entry.annotation.readOnly),
        );
        const annotationLabel = typeLabel(entry.annotation.type);
        const pageLabel = entry.annotation.pageLabel || handle.pageIndex + 1;
        runtime.preview.setAttribute(
          "aria-label",
          `${entry.annotation.readOnly ? "查看" : "编辑"}${annotationLabel}，第 ${pageLabel} 页`,
        );
        runtime.editor.setAttribute(
          "aria-label",
          `${annotationLabel}，第 ${pageLabel} 页`,
        );
      }

      if (!runtime.dirty && runtime.currentValue !== entry.annotation.comment) {
        runtime.currentValue = entry.annotation.comment;
        this.renderComment(runtime.editor, entry.annotation.comment);
        runtime.originalValue = entry.annotation.comment;
        this.updatePreview(runtime);
        runtime.measuredHeight = undefined;
      }
      if (wasReadOnly !== entry.annotation.readOnly) {
        const button = runtime.card.querySelector<HTMLButtonElement>(".zmc-insert-image");
        if (button) button.hidden = entry.annotation.readOnly;
        runtime.state.textContent = entry.annotation.readOnly ? "只读" : "";
        runtime.measuredHeight = undefined;
      }
    }
    this.layoutPage(mounted);
    return true;
  }

  private createMarginColumn(
    doc: Document,
    side: MarginSide,
  ): MarginColumnRuntime {
    const root = doc.createElement("section");
    const scrollport = doc.createElement("div");
    const content = doc.createElement("div");
    const toggle = doc.createElement("button");
    root.className = `zmc-margin-column zmc-margin-column-${side}`;
    scrollport.className = "zmc-margin-scrollport";
    content.className = "zmc-margin-content";
    toggle.type = "button";
    toggle.className = "zmc-margin-toggle";
    toggle.hidden = true;
    scrollport.append(content);
    root.append(scrollport, toggle);
    return {
      side, root, scrollport, content, toggle,
      placement: { x: 0, width: this.cardWidth, mode: "outside" },
    };
  }

  private toggleMargin(mounted: MountedPage, side: MarginSide): void {
    const key = this.marginStateKey(mounted.handle.pageIndex, side);
    const column = mounted.columns[side];
    if (column.root.classList.contains("zmc-margin-expanded")) {
      this.expandedMargins.delete(key);
      const activeEditor = mounted.runtimes.find(
        (runtime) =>
          runtime.anchor.side === side &&
          runtime.editor.ownerDocument.activeElement === runtime.editor,
      );
      activeEditor?.editor.blur();
      column.scrollport.scrollTop = 0;
    } else {
      this.expandedMargins.add(key);
    }
    this.layoutPage(mounted);
  }

  private marginStateKey(pageIndex: number, side: MarginSide): string {
    return `${pageIndex}:${side}`;
  }

  private createCard(
    doc: Document,
    annotation: MarginAnnotation,
    anchor: PageAnchor,
    pageIndex: number,
  ): CardRuntime {
    const card = doc.createElement("article");
    const preview = doc.createElement("div");
    const editor = doc.createElement("div");
    const footer = doc.createElement("footer");
    const state = doc.createElement("span");
    const imagePreview = doc.createElement("div");
    const insertImage = doc.createElement("button");

    card.className = `zmc-card zmc-card-${anchor.side}`;
    card.dataset.annotationKey = annotation.key;
    card.style.setProperty("--zmc-color", annotation.color);
    const annotationLabel = typeLabel(annotation.type);
    preview.tabIndex = 0;
    preview.setAttribute("role", "button");
    preview.className = "zmc-card-preview";
    preview.setAttribute(
      "aria-label",
      `${annotation.readOnly ? "查看" : "编辑"}${annotationLabel}，第 ${annotation.pageLabel || pageIndex + 1} 页`,
    );
    editor.className = "zmc-card-editor zmc-editor-hidden";
    editor.contentEditable = String(!annotation.readOnly);
    editor.dataset.placeholder = annotation.type === "note" ? "点击输入独立评论…" : "点击输入划线解释…";
    editor.spellcheck = false;
    editor.dir = "auto";
    editor.setAttribute("role", "textbox");
    editor.setAttribute("aria-multiline", "true");
    editor.setAttribute("aria-readonly", String(annotation.readOnly));
    editor.setAttribute("aria-label", `${annotationLabel}，第 ${annotation.pageLabel || pageIndex + 1} 页`);
    this.renderComment(editor, annotation.comment);
    footer.className = "zmc-card-footer";
    state.className = "zmc-save-state";
    state.textContent = annotation.readOnly ? "只读" : "";
    imagePreview.className = "zmc-editor-images";
    insertImage.className = "zmc-insert-image";
    insertImage.type = "button";
    insertImage.textContent = "插入图片";
    insertImage.hidden = annotation.readOnly;

    footer.append(state, insertImage);
    card.append(preview, editor, imagePreview, footer);

    const runtime: CardRuntime = {
      annotation,
      anchor,
      card,
      preview,
      editor,
      imagePreview,
      state,
      originalValue: annotation.comment,
      currentValue: annotation.comment,
      dirty: false,
      saving: false,
      pendingImages: 0,
      imageEpoch: 0,
    };
    this.updatePreview(runtime);
    card.classList.toggle("zmc-hovered", this.hoveredKey === annotation.key);

    card.addEventListener("pointerenter", () =>
      this.setHovered(runtime.annotation.key),
    );
    card.addEventListener("pointerleave", () => this.setHovered());
    card.addEventListener("pointerdown", () => {
      this.setActive(runtime.annotation.key);
      this.adapter.selectAnnotation(runtime.annotation.key);
    });
    preview.addEventListener("click", (event) => {
      if (this.openClickedImage(event, preview)) return;
      const link = (event.target as Element).closest?.("a[href]");
      if (link && preview.contains(link)) {
        event.preventDefault();
        event.stopPropagation();
        (Zotero as any).launchURL?.(link.getAttribute("href"));
        return;
      }
      if (!runtime.annotation.readOnly) this.openEditor(runtime);
    });
    preview.addEventListener("keydown", (event) => {
      if (event.target !== preview) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        if (!runtime.annotation.readOnly) this.openEditor(runtime);
      }
    });
    editor.addEventListener("focus", () => {
      this.setActive(runtime.annotation.key);
      (doc as any).execCommand?.("defaultParagraphSeparator", false, "br");
    });
    // Keep text editing inside the card. Letting these events bubble to the
    // card would call selectAnnotation(), which navigates the PDF on every
    // drag start and collapses a mouse selection back to a single caret.
    // Do not preventDefault(): native selection and the clipboard context
    // menu still need their normal browser behaviour.
    for (const eventName of [
      "pointerdown",
      "mousedown",
      "click",
      "dblclick",
      "contextmenu",
    ]) {
      editor.addEventListener(eventName, (event) => event.stopPropagation());
    }
    const editorSelection = (): Selection | undefined => {
      const selection = doc.defaultView?.getSelection();
      if (
        !selection
        || selection.isCollapsed
        || !selection.anchorNode
        || !selection.focusNode
        || !editor.contains(selection.anchorNode)
        || !editor.contains(selection.focusNode)
      ) {
        return undefined;
      }
      return selection;
    };
    editor.addEventListener("copy", (event) => {
      const selection = editorSelection();
      if (!selection) return;
      event.stopPropagation();
      const text = selection.toString();
      const copied = this.copyTextToClipboard(text);
      if (event.clipboardData) {
        event.clipboardData.setData("text/plain", text);
      }
      if (copied || event.clipboardData) event.preventDefault();
    });
    editor.addEventListener("cut", (event) => event.stopPropagation());
    editor.addEventListener("paste", (event) => {
      event.stopPropagation();
      if (runtime.annotation.readOnly) return;
      const items = Array.from(event.clipboardData?.items ?? []);
      let files = items.filter((item) => item.kind === "file" && /^image\//i.test(item.type))
        .map((item) => item.getAsFile()).filter((file): file is File => !!file);
      if (!files.length) files = Array.from(event.clipboardData?.files ?? []).filter((file) => /^image\//i.test(file.type));
      const types = Array.from(event.clipboardData?.types ?? []);
      const nativePNG = !files.length && event.isTrusted && !types.some((type) => /^text\//i.test(type))
        ? this.images.readClipboardPNG() : undefined;
      if (!files.length && !nativePNG) return;
      event.preventDefault();
      const range = captureEditorRange(editor);
      void this.insertImages(runtime, range, async () => {
        const images: ImportedImage[] = [];
        if (nativePNG) images.push(await this.images.importBytes(nativePNG, "粘贴图片.png"));
        for (const file of files) {
          images.push(await this.images.importBytes(copyImageBytes(await file.arrayBuffer()), file.name || "粘贴图片"));
        }
        return images;
      });
    });
    imagePreview.addEventListener("click", (event) => this.openClickedImage(event, imagePreview));
    for (const name of ["pointerdown", "mousedown"]) {
      insertImage.addEventListener(name, (event) => { event.preventDefault(); event.stopPropagation(); });
    }
    insertImage.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const range = captureEditorRange(editor);
      const epoch = runtime.imageEpoch;
      void this.insertImages(runtime, range, async () => {
        const path = await this.images.pickFile();
        if (this.isImageTargetCurrent(runtime, epoch)) {
          runtime.closeAfterImage = false;
          editor.focus({ preventScroll: true });
        }
        return path ? [await this.images.importFile(path)] : [];
      });
    });
    editor.addEventListener("input", () => {
      if (runtime.annotation.readOnly) return;
      runtime.currentValue = this.readComment(editor);
      runtime.dirty = runtime.currentValue !== runtime.originalValue;
      if (runtime.statusTimer) clearTimeout(runtime.statusTimer);
      runtime.statusTimer = undefined;
      runtime.state.dataset.error = "false";
      runtime.state.textContent = runtime.dirty ? "未保存" : "";
      this.updatePreview(runtime);
      runtime.measuredHeight = undefined;
      const mounted = this.mountedPages.get(pageIndex);
      if (mounted) this.layoutPage(mounted);
      this.queueSave(runtime);
    });
    editor.addEventListener("keydown", (event) => {
      const modifier = (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey;
      const key = event.key.toLowerCase();
      const formatCommand = event.key.toLowerCase() === "b"
        ? "bold"
        : event.key.toLowerCase() === "i"
          ? "italic"
          : undefined;
      if (modifier && key === "a") {
        event.preventDefault();
        event.stopPropagation();
        selectEditorContents(editor);
      } else if (modifier && key === "c") {
        event.preventDefault();
        event.stopPropagation();
        const selection = editorSelection();
        if (selection && !this.copyTextToClipboard(selection.toString())) {
          (doc as any).execCommand?.("copy", false, null);
        }
      } else if (modifier && key === "x") {
        event.stopPropagation();
        if (editorSelection() && (doc as any).execCommand?.("cut", false, null)) {
          event.preventDefault();
        }
      } else if (modifier && ["v", "z", "y"].includes(key)) {
        // Keep native paste/undo/redo, but do not let the PDF reader treat
        // the shortcut as a document command.
        event.stopPropagation();
      } else if (modifier && formatCommand) {
        event.preventDefault();
        event.stopPropagation();
        (doc as any).execCommand?.(formatCommand, false, null);
        editor.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.cancelEdit(runtime);
      } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void this.persist(runtime).then(() => editor.blur());
      }
    });
    const finishEditing = () => {
      if (runtime.pendingImages) {
        runtime.closeAfterImage = true;
        return;
      }
      void this.persist(runtime).finally(() => {
        this.closeEditor(runtime, pageIndex);
        this.flushPendingRefresh();
      });
    };
    editor.addEventListener("blur", (event) => {
      if (event.relatedTarget !== insertImage) finishEditing();
    });
    insertImage.addEventListener("blur", (event) => {
      if (event.relatedTarget !== editor) finishEditing();
    });
    return runtime;
  }

  private layoutPage(mounted: MountedPage): void {
    mounted.overlay.style.setProperty("--zmc-font-size", `${this.fontSize}px`);
    this.positionOverlay(mounted);
    this.requestWhitespace(mounted);
    const { width, height } = this.pageDimensions(mounted.handle);
    mounted.positions.clear();

    for (const side of ["left", "right"] as const) {
      const column = mounted.columns[side];
      const sideRuntimes = mounted.runtimes.filter(
        (runtime) =>
          runtime.anchor.side === side &&
          !runtime.card.classList.contains("zmc-filtered"),
      );
      column.root.hidden = sideRuntimes.length === 0;
      const stateKey = this.marginStateKey(mounted.handle.pageIndex, side);
      const editing = sideRuntimes.some((runtime) =>
        runtime.card.classList.contains("zmc-editing"),
      );
      const requestedExpanded = this.expandedMargins.has(stateKey);
      const runtimeByID = new Map(
        sideRuntimes.map((runtime) => [runtime.annotation.key, runtime] as const),
      );
      const layout = (placement: MarginPlacement) => {
        column.placement = placement;
        setPixelStyle(column.root, "left", placement.x);
        setPixelStyle(column.root, "width", placement.width);
        column.root.dataset.placement = placement.mode;
        return layoutCollapsibleMargin(
          sideRuntimes.map((runtime) => ({
            id: runtime.annotation.key,
            anchorY: runtime.anchor.y,
            height: this.measureRuntimeHeight(runtime, mounted),
          })),
          {
            pageHeight: height,
            padding: LAYOUT_PADDING,
            gap: CARD_GAP,
            summaryHeight: SUMMARY_HEIGHT,
            expandedTopPadding: this.collapseNotes ? EXPANDED_TOP_PADDING : LAYOUT_PADDING,
            expanded: !this.collapseNotes || requestedExpanded || editing,
          },
        );
      };
      const result = layout({ ...column.placement, width: this.cardWidth });
      // Width is independent of the paper margin, so measure/wrap only once.
      // Position against the narrowest whitespace over the full card heights.
      const placement = placeMarginInWhitespace(mounted.whitespace, {
        side, pageWidth: width, pageHeight: height, cardWidth: this.cardWidth,
        bands: result.overflow ? undefined : result.positions.map((position) => ({
          top: position.y, bottom: position.y + position.height,
        })),
      });
      column.placement = placement;
      setPixelStyle(column.root, "left", placement.x);
      column.root.dataset.placement = placement.mode;
      const expanded = result.overflow && (!this.collapseNotes || requestedExpanded || editing);
      if (!result.overflow) this.expandedMargins.delete(stateKey);
      if (!expanded) column.scrollport.scrollTop = 0;

      column.root.classList.toggle("zmc-margin-expanded", expanded);
      column.root.classList.toggle("zmc-margin-overflow", result.overflow);
      column.toggle.hidden = !this.collapseNotes || !result.overflow;
      column.toggle.setAttribute("aria-expanded", String(expanded));
      const toggleText = expanded
        ? "收起评论"
        : `还有 ${result.hiddenIDs.length} 条 · 展开`;
      if (column.toggle.textContent !== toggleText) {
        column.toggle.textContent = toggleText;
      }
      column.toggle.title = toggleText;
      column.toggle.setAttribute("aria-label", toggleText);
      const toggleTop = `${expanded ? LAYOUT_PADDING : result.summaryY ?? 0}px`;
      if (column.toggle.style.top !== toggleTop) column.toggle.style.top = toggleTop;
      const contentHeight = `${result.contentHeight}px`;
      if (column.content.style.height !== contentHeight) {
        column.content.style.height = contentHeight;
      }

      const visibleIDs = new Set(result.positions.map((position) => position.id));
      for (const runtime of sideRuntimes) {
        runtime.card.classList.toggle(
          "zmc-overflow-hidden",
          !visibleIDs.has(runtime.annotation.key),
        );
      }
      for (const position of result.positions) {
        mounted.positions.set(position.id, position);
        const runtime = runtimeByID.get(position.id);
        if (runtime) {
          const top = `${position.y}px`;
          if (runtime.card.style.top !== top) runtime.card.style.top = top;
        }
      }
    }

    const usedColumns = Object.values(mounted.columns).filter((column) => !column.root.hidden);
    const lineLeft = Math.min(0, ...usedColumns.map((column) => column.placement.x));
    const lineRight = Math.max(width, ...usedColumns.map((column) => column.placement.x + column.placement.width));
    mounted.lines.style.left = `${lineLeft}px`;
    mounted.lines.setAttribute("width", String(lineRight - lineLeft));
    mounted.lines.setAttribute("height", String(Math.max(1, height)));
    mounted.lines.setAttribute(
      "viewBox",
      `${lineLeft} 0 ${lineRight - lineLeft} ${Math.max(1, height)}`,
    );
    this.redrawLeaderLines(mounted);
    this.syncViewerGutters(this.adapter.viewerElement());
  }

  private redrawLeaderLines(mounted: MountedPage): void {
    const { width, height } = this.pageDimensions(mounted.handle);
    mounted.lines.replaceChildren();
    for (const runtime of mounted.runtimes) {
      const position = mounted.positions.get(runtime.annotation.key);
      if (!position) continue;
      const column = mounted.columns[runtime.anchor.side];
      const expanded = column.root.classList.contains("zmc-margin-expanded");
      const cardY = position.y - (expanded ? column.scrollport.scrollTop : 0);
      const lineEndY = cardY + Math.min(26, position.height / 2);
      if (expanded && (lineEndY < 0 || lineEndY > height)) continue;
      this.drawLeaderLine(mounted.lines, runtime, cardY, position.height, column.placement);
    }
  }

  private scheduleVisibilityUpdate(): void {
    if (this.destroyed || !this.enabled || !this.adapterReady) return;
    if (this.visibilityTimer) clearTimeout(this.visibilityTimer);
    this.cancelVisibilityFrame?.();
    this.cancelVisibilityFrame = undefined;
    this.pendingVisibilityPages = [];
    this.visibilityTimer = setTimeout(() => {
      this.visibilityTimer = undefined;
      if (this.destroyed || !this.enabled || !this.adapterReady) return;
      this.nativeVisibleIDs = this.adapter.visibleAnnotationIDs();
      // Reader changes cover content as well as filtering. Reload saved data
      // when it changed; keep the cheaper per-page visibility path for filters.
      // refresh() defers rebuilding cards while a local editor is active.
      const annotations = this.store.list(this.attachmentID);
      if (JSON.stringify(annotations) !== this.annotationsSignature) {
        void this.refresh();
      }
      const currentPageIndex = this.adapter.currentPageIndex();
      this.pendingVisibilityPages = [...this.mountedPages.values()].sort(
        (left, right) =>
          Math.abs(left.handle.pageIndex - currentPageIndex) -
          Math.abs(right.handle.pageIndex - currentPageIndex),
      );
      this.processNextVisibilityPage(true);
    }, FILTER_UI_SETTLE_MS);
  }

  private processNextVisibilityPage(prioritizeCurrentPage = false): void {
    if (this.cancelVisibilityFrame || !this.pendingVisibilityPages.length) return;
    const schedule = prioritizeCurrentPage
      ? this.adapter.scheduleAnimationFrame.bind(this.adapter)
      : this.adapter.scheduleIdleCallback.bind(this.adapter);
    this.cancelVisibilityFrame = schedule(() => {
      this.cancelVisibilityFrame = undefined;
      const mounted = this.pendingVisibilityPages.shift();
      if (
        mounted &&
        this.mountedPages.get(mounted.handle.pageIndex) === mounted
      ) {
        this.applyNativeVisibility(mounted);
      }
      if (this.pendingVisibilityPages.length) this.processNextVisibilityPage(false);
    });
  }

  private applyNativeVisibility(mounted: MountedPage): void {
    let changed = false;
    for (const runtime of mounted.runtimes) {
      const filtered = !this.isNativeAnnotationVisible(runtime.annotation.key);
      if (runtime.card.classList.contains("zmc-filtered") === filtered) continue;
      runtime.card.classList.toggle("zmc-filtered", filtered);
      changed = true;
    }
    if (changed) this.layoutPage(mounted);
  }

  private isNativeAnnotationVisible(key: string): boolean {
    return this.nativeVisibleIDs === undefined || this.nativeVisibleIDs.has(key);
  }

  private drawLeaderLine(
    svg: SVGSVGElement,
    runtime: CardRuntime,
    cardY: number,
    cardHeight: number,
    placement: MarginPlacement,
  ): void {
    const doc = svg.ownerDocument;
    const line = doc.createElementNS(SVG_NS, "polyline");
    const dot = doc.createElementNS(SVG_NS, "circle");
    const endY = cardY + Math.min(26, cardHeight / 2);
    const isLeft = runtime.anchor.side === "left";
    const endX = isLeft ? placement.x + placement.width : placement.x;
    const elbowX = endX + (isLeft ? 6 : -6);
    line.classList.add("zmc-line");
    line.dataset.annotationKey = runtime.annotation.key;
    line.classList.toggle("zmc-hovered", this.hoveredKey === runtime.annotation.key);
    line.setAttribute(
      "points",
      `${runtime.anchor.x},${runtime.anchor.y} ${elbowX},${runtime.anchor.y} ${endX},${endY}`,
    );
    line.setAttribute("stroke", runtime.annotation.color);
    dot.classList.add("zmc-line-dot");
    dot.dataset.annotationKey = runtime.annotation.key;
    dot.classList.toggle("zmc-hovered", this.hoveredKey === runtime.annotation.key);
    dot.setAttribute("cx", String(runtime.anchor.x));
    dot.setAttribute("cy", String(runtime.anchor.y));
    dot.setAttribute("r", "2.5");
    dot.setAttribute("fill", runtime.annotation.color);
    svg.append(line, dot);
  }

  private queueSave(runtime: CardRuntime): void {
    if (runtime.timer) clearTimeout(runtime.timer);
    runtime.timer = setTimeout(() => {
      runtime.timer = undefined;
      void this.persist(runtime);
    }, 700);
  }

  private async persist(runtime: CardRuntime): Promise<void> {
    if (runtime.timer) clearTimeout(runtime.timer);
    runtime.timer = undefined;
    if (!runtime.dirty || runtime.saving || runtime.annotation.readOnly || runtime.pendingImages) return;

    const value = runtime.currentValue;
    runtime.saving = true;
    if (runtime.statusTimer) clearTimeout(runtime.statusTimer);
    runtime.statusTimer = undefined;
    runtime.state.dataset.error = "false";
    runtime.state.textContent = "正在保存…";
    try {
      await this.store.saveComment(runtime.annotation.itemID, value);
      runtime.originalValue = value;
      runtime.annotation.comment = value;
      runtime.dirty = runtime.currentValue !== value;
      this.updatePreview(runtime);
      runtime.state.textContent = runtime.dirty ? "有新修改" : "已保存";
      if (!runtime.dirty) {
        runtime.statusTimer = setTimeout(() => {
          runtime.statusTimer = undefined;
          if (!runtime.dirty && !runtime.saving && !runtime.annotation.readOnly) {
            runtime.state.textContent = "";
            runtime.measuredHeight = undefined;
            this.relayoutRuntime(runtime);
          }
        }, 1200);
      }
      if (value.trim()) this.forcedKeys.delete(runtime.annotation.key);
    } catch (error) {
      runtime.dirty = true;
      runtime.state.dataset.error = "true";
      runtime.state.textContent = error instanceof Error ? error.message : "保存失败";
      (Zotero as any).logError?.(error);
    } finally {
      runtime.saving = false;
      if (!runtime.dirty && !runtime.card.classList.contains("zmc-editing")) {
        runtime.cleanupHold?.();
        runtime.cleanupHold = undefined;
      }
      if (runtime.dirty && runtime.currentValue !== value) this.queueSave(runtime);
      this.flushPendingRefresh();
    }
  }

  private cancelEdit(runtime: CardRuntime): void {
    runtime.imageEpoch += 1;
    runtime.pendingImages = 0;
    runtime.closeAfterImage = false;
    if (runtime.timer) clearTimeout(runtime.timer);
    runtime.timer = undefined;
    runtime.currentValue = runtime.originalValue;
    this.renderComment(runtime.editor, runtime.originalValue);
    runtime.annotation.comment = runtime.originalValue;
    runtime.dirty = false;
    runtime.state.dataset.error = "false";
    runtime.state.textContent = runtime.annotation.readOnly ? "只读" : "已取消";
    if (!runtime.annotation.readOnly) {
      runtime.statusTimer = setTimeout(() => {
        runtime.statusTimer = undefined;
        runtime.state.textContent = "";
        runtime.measuredHeight = undefined;
        this.relayoutRuntime(runtime);
      }, 1200);
    }
    this.updatePreview(runtime);
    runtime.editor.blur();
  }

  private openEditor(runtime: CardRuntime, selectAll = false): void {
    if (runtime.annotation.readOnly) return;
    runtime.cleanupHold ??= this.images.holdCleanup();
    if (!runtime.card.classList.contains("zmc-editing")) {
      // Markdown source can occupy fewer lines than its rendered preview.
      // Keep that reading space when switching modes, then let the editable
      // block grow naturally. Do not introduce a second scrollport here.
      runtime.editor.style.minHeight = `${Math.max(37, runtime.preview.offsetHeight)}px`;
    }
    runtime.card.classList.add("zmc-editing");
    runtime.preview.classList.add("zmc-preview-hidden");
    runtime.editor.classList.remove("zmc-editor-hidden");
    const mounted = this.mountedPages.get(runtime.annotation.position.pageIndex);
    if (mounted) this.layoutPage(mounted);
    runtime.editor.focus({ preventScroll: true });
    if (selectAll) selectEditorContents(runtime.editor);
  }

  private closeEditor(runtime: CardRuntime, pageIndex: number): void {
    runtime.card.classList.remove("zmc-editing");
    runtime.editor.classList.add("zmc-editor-hidden");
    runtime.preview.classList.remove("zmc-preview-hidden");
    runtime.editor.style.removeProperty("min-height");
    if (!runtime.dirty && !runtime.saving && !runtime.pendingImages) {
      runtime.cleanupHold?.();
      runtime.cleanupHold = undefined;
    }
    const mounted = this.mountedPages.get(pageIndex);
    if (mounted) this.layoutPage(mounted);
  }

  private updatePreview(runtime: CardRuntime): void {
    const value = runtime.currentValue;
    if (value) {
      try {
        const options = { image: (reference: string, alt: string) => renderAssetImage(
          runtime.preview.ownerDocument, this.images, reference, alt,
          () => {
            if (!runtime.card.isConnected) return;
            runtime.measuredHeight = undefined;
            this.relayoutRuntime(runtime);
          },
        ) };
        renderMarkdownComment(runtime.preview, value, options);
        if (runtime.preview.querySelector(".zmc-inline-image")) renderCommentImages(runtime.imagePreview, value, options);
        else runtime.imagePreview.replaceChildren();
      } catch (error) {
        runtime.preview.textContent = value;
        (Zotero as any).logError?.(error);
      }
    } else {
      runtime.preview.textContent = runtime.editor.dataset.placeholder ?? "";
      runtime.imagePreview.replaceChildren();
    }
    runtime.card.classList.toggle("zmc-has-images", !!runtime.preview.querySelector(".zmc-inline-image"));
    runtime.preview.classList.toggle("zmc-empty-preview", !value);
  }

  private isImageTargetCurrent(runtime: CardRuntime, epoch: number): boolean {
    return !this.destroyed && this.enabled && runtime.card.isConnected
      && runtime.imageEpoch === epoch && !runtime.annotation.readOnly;
  }

  private async insertImages(
    runtime: CardRuntime, range: Range, produce: () => Promise<ImportedImage[]>,
  ): Promise<void> {
    const epoch = runtime.imageEpoch;
    if (!this.isImageTargetCurrent(runtime, epoch)) return;
    const releaseCleanup = this.images.holdCleanup();
    runtime.pendingImages += 1;
    if (runtime.timer) clearTimeout(runtime.timer);
    runtime.timer = undefined;
    if (runtime.statusTimer) clearTimeout(runtime.statusTimer);
    runtime.statusTimer = undefined;
    runtime.state.dataset.error = "false";
    runtime.state.textContent = "正在插入图片…";
    try {
      const images = await produce();
      if (!this.isImageTargetCurrent(runtime, epoch)) return;
      if (images.length) {
        const text = images.map((image) => imageMarkdown(image.reference, image.name)).join("\n");
        if (!insertImageText(runtime.editor, range, `\n${text}\n`)) throw new Error("插入位置已失效，请重新粘贴图片");
        // Some Gecko execCommand paths emit input themselves; repeat reading is harmless.
        const input = runtime.editor.ownerDocument.createEvent("Event");
        input.initEvent("input", true, false);
        runtime.editor.dispatchEvent(input);
      } else runtime.state.textContent = "";
    } catch (error) {
      if (this.isImageTargetCurrent(runtime, epoch)) {
        runtime.state.dataset.error = "true";
        runtime.state.textContent = `插入图片失败：${(error as Error)?.message || "无法保存图片"}`;
      }
      (Zotero as any).logError?.(error);
    } finally {
      releaseCleanup();
      if (!this.destroyed && runtime.card.isConnected && runtime.imageEpoch === epoch) {
        runtime.pendingImages = Math.max(0, runtime.pendingImages - 1);
        if (!runtime.pendingImages) {
          if (runtime.closeAfterImage) {
            runtime.closeAfterImage = false;
            await this.persist(runtime);
            this.closeEditor(runtime, runtime.annotation.position.pageIndex);
            this.flushPendingRefresh();
          } else if (runtime.dirty) this.queueSave(runtime);
          else if (runtime.state.dataset.error !== "true") runtime.state.textContent = "";
        }
      }
    }
  }

  private openClickedImage(event: MouseEvent, root: HTMLElement): boolean {
    const image = (event.target as Element).closest?.(".zmc-inline-image img") as HTMLImageElement | null;
    if (!image || image.hidden || !root.contains(image)) return false;
    event.preventDefault();
    event.stopPropagation();
    this.closeLightbox?.();
    this.closeLightbox = openImageLightbox(root.ownerDocument, image);
    return true;
  }

  private renderComment(root: HTMLElement, value: string): void {
    try {
      renderStoredComment(root, value);
    } catch (error) {
      // A rich-text compatibility failure must not prevent every annotation
      // on the page from mounting. Plain text remains editable and visible.
      root.textContent = value;
      (Zotero as any).logError?.(error);
    }
  }

  private readComment(root: HTMLElement): string {
    try {
      return readStoredComment(root);
    } catch (error) {
      (Zotero as any).logError?.(error);
      return root.textContent?.trim() ?? "";
    }
  }

  private copyTextToClipboard(value: string): boolean {
    try {
      const copy = (Zotero as any).Utilities?.Internal?.copyTextToClipboard;
      if (typeof copy !== "function") return false;
      copy.call((Zotero as any).Utilities.Internal, value);
      return true;
    } catch (error) {
      (Zotero as any).logError?.(error);
      return false;
    }
  }

  private measureRuntimeHeight(
    runtime: CardRuntime,
    mounted: MountedPage,
  ): number {
    const mode = [
      String(this.fontSize),
      this.collapseNotes ? "collapsed" : "full",
      runtime.card.classList.contains("zmc-editing") ? "editing" : "preview",
      runtime.state.textContent ? "status" : "plain",
      String(mounted.columns[runtime.anchor.side].placement.width),
      mounted.columns[runtime.anchor.side].placement.mode,
    ].join(":");
    if (runtime.measuredHeight === undefined || runtime.heightMode !== mode) {
      runtime.measuredHeight = measureHeight(runtime.card, runtime.currentValue, this.pageScale(mounted.handle).y);
      runtime.heightMode = mode;
    }
    return runtime.measuredHeight;
  }

  private relayoutRuntime(runtime: CardRuntime): void {
    const mounted = this.mountedPages.get(runtime.annotation.position.pageIndex);
    if (mounted) this.layoutPage(mounted);
  }

  private setActive(key: string): void {
    this.activeKey = key;
    this.syncActiveCards();
  }

  private setHovered(key?: string): void {
    if (this.hoveredKey === key) return;
    const previous = this.hoveredKey;
    this.hoveredKey = key;
    if (previous) this.adapter.setAnnotationHover(previous, false);
    if (key) this.adapter.setAnnotationHover(key, true);

    for (const runtime of this.cardRuntimes()) {
      runtime.card.classList.toggle("zmc-hovered", runtime.annotation.key === key);
    }
    const lineElements = Array.from(
      this.adapter.document().querySelectorAll(".zmc-line, .zmc-line-dot"),
    ) as unknown as SVGElement[];
    for (const element of lineElements) {
      element.classList.toggle("zmc-hovered", element.dataset.annotationKey === key);
    }
  }

  private syncActiveCards(): void {
    for (const runtime of this.cardRuntimes()) {
      runtime.card.classList.toggle("zmc-active", runtime.annotation.key === this.activeKey);
    }
  }

  private syncCompactNoteIcons(): void {
    this.adapter.setCompactNoteIcons(
      this.compactNoteIcons,
      this.annotations
        .filter((annotation) => annotation.type === "note")
        .map((annotation) => annotation.key),
    );
  }

  private hasBlockingEditor(): boolean {
    return this.cardRuntimes().some(
      (runtime) =>
        runtime.saving || runtime.pendingImages > 0 || (
          runtime.card.classList.contains("zmc-editing")
          && runtime.card.contains(runtime.editor.ownerDocument.activeElement)
        ),
    );
  }

  private flushPendingRefresh(): void {
    if (this.pendingRefresh && !this.hasBlockingEditor()) void this.refresh(true);
  }

  private cardRuntimes(): CardRuntime[] {
    return [...this.mountedPages.values()].flatMap((page) => page.runtimes);
  }

  private ensureStyles(doc: Document): void {
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = PDF_STYLES;
    doc.head.append(style);
  }

  private requestWhitespace(mounted: MountedPage): void {
    const rotation = mounted.handle.viewport.rotation ?? 0;
    if (mounted.whitespaceRotation !== rotation) {
      mounted.whitespaceRotation = rotation;
      mounted.whitespace = undefined;
      mounted.pendingWhitespace = undefined;
      mounted.whitespaceRequested = false;
    }
    if (mounted.whitespaceRequested) return;
    mounted.whitespaceRequested = true;
    void this.adapter.pageWhitespace(mounted.handle).then((profile) => {
      if (
        !profile || this.destroyed || !this.enabled
        || this.mountedPages.get(mounted.handle.pageIndex) !== mounted
        || mounted.whitespaceRotation !== rotation
      ) return;
      if (this.hasBlockingEditor()) {
        mounted.pendingWhitespace = profile;
        this.pendingRefresh = true;
        return;
      }
      mounted.whitespace = profile;
      this.scheduleRender(1);
    });
  }

  private syncViewerGutters(viewer: HTMLElement): void {
    let left = 0;
    let right = 0;
    for (const mounted of this.mountedPages.values()) {
      const { width } = this.pageDimensions(mounted.handle);
      const scale = this.pageScale(mounted.handle).x;
      for (const side of ["left", "right"] as const) {
        if (!mounted.runtimes.some((runtime) =>
          runtime.anchor.side === side && !runtime.card.classList.contains("zmc-filtered"),
        )) continue;
        const placement = mounted.columns[side].placement;
        left = Math.max(left, -placement.x * scale);
        right = Math.max(right, (placement.x + placement.width - width) * scale);
      }
    }
    // Symmetric padding preserves the original PDF horizontal zoom centre.
    const gutter = `${Math.ceil(Math.max(left, right))}px`;
    if (viewer.style.getPropertyValue("--zmc-gutter-width") !== gutter) {
      viewer.style.setProperty("--zmc-gutter-width", gutter);
      for (const mounted of this.mountedPages.values()) this.positionOverlay(mounted);
    }
  }

  private ensureOverlayRoot(doc: Document, viewer: HTMLElement): void {
    const host = viewer.closest<HTMLElement>("#viewerContainer")
      ?? viewer.parentElement
      ?? viewer;
    if (!this.overlayRoot) {
      this.overlayRoot = doc.createElement("div");
      this.overlayRoot.className = "zmc-overlay-root";
    }
    if (this.overlayRoot.parentElement !== host) host.append(this.overlayRoot);
  }

  private positionOverlay(mounted: MountedPage): void {
    const root = this.overlayRoot;
    const host = root?.parentElement;
    if (!root || !host) return;
    if (mounted.overlay.parentElement !== root) root.append(mounted.overlay);

    const pageRect = mounted.handle.element.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const left = pageRect.width || pageRect.height
      ? pageRect.left - hostRect.left + host.scrollLeft - host.clientLeft
      : mounted.handle.element.offsetLeft;
    const top = pageRect.width || pageRect.height
      ? pageRect.top - hostRect.top + host.scrollTop - host.clientTop
      : mounted.handle.element.offsetTop;
    const { width, height } = this.pageDimensions(mounted.handle, pageRect);
    setPixelStyle(mounted.overlay, "left", left);
    setPixelStyle(mounted.overlay, "top", top);
    setPixelStyle(mounted.overlay, "width", width);
    setPixelStyle(mounted.overlay, "height", height);
    const scale = this.pageScale(mounted.handle, pageRect);
    mounted.overlay.style.transform = `scale(${scale.x}, ${scale.y})`;
  }

  private preparePageAnnotations(
    handle: PdfPageHandle,
    annotations: MarginAnnotation[],
  ): { annotation: MarginAnnotation; anchor: PageAnchor }[] {
    const rotation = handle.viewport.rotation ?? 0;
    const { width } = this.pageDimensions(handle);
    const previous = new Map<string, MarginSide>();
    const candidates = annotations.flatMap((annotation) => {
      const anchor = this.annotationAnchorForHandle(annotation, handle);
      if (!anchor) return [];
      const isText = annotation.type === "highlight" || annotation.type === "underline";
      const opposite = isText
        ? this.annotationAnchorForHandle(annotation, handle, anchor.side === "left" ? "right" : "left")!
        : anchor;
      const left = anchor.side === "left" ? anchor : opposite;
      const right = anchor.side === "right" ? anchor : opposite;
      const flexible = isText && canUseEitherMargin(left.x, right.x, width);
      const position = JSON.stringify(annotation.position);
      const cached = this.marginSides.get(annotation.key);
      if (flexible && cached?.position === position) {
        const side = cached.rotations.get(rotation);
        if (side) previous.set(annotation.key, side);
      }
      return [{ annotation, anchor, left, right, flexible, position }];
    });
    const sides = assignMarginSides(candidates.map((entry) => ({
      key: entry.annotation.key,
      anchorY: entry.anchor.y,
      preferredSide: entry.flexible ? undefined : entry.anchor.side,
    })), previous);
    return candidates.map((entry) => {
      const side = sides.get(entry.annotation.key)!;
      if (entry.flexible) {
        let cached = this.marginSides.get(entry.annotation.key);
        if (cached?.position !== entry.position) {
          cached = { position: entry.position, rotations: new Map() };
          this.marginSides.set(entry.annotation.key, cached);
        }
        cached.rotations.set(rotation, side);
      }
      return { annotation: entry.annotation, anchor: entry[side] };
    });
  }

  private annotationAnchorForHandle(
    annotation: MarginAnnotation,
    handle: PdfPageHandle,
    side?: MarginSide,
  ): PageAnchor | undefined {
    const anchor = this.compactNoteIcons && annotation.type === "note"
      ? compactNoteAnchor(annotation.position, handle.viewport)
      : annotationAnchor(annotation.position, handle.viewport, side);
    if (!anchor) return undefined;
    const { width, height } = this.pageDimensions(handle);
    const scaleX = handle.viewport.width > 0 ? width / handle.viewport.width : 1;
    const scaleY = handle.viewport.height > 0 ? height / handle.viewport.height : 1;
    return {
      x: Math.max(0, Math.min(width, anchor.x * scaleX)),
      y: Math.max(0, Math.min(height, anchor.y * scaleY)),
      side: anchor.side,
    };
  }

  private pageDimensions(
    handle: PdfPageHandle,
    rect = handle.element.getBoundingClientRect(),
  ): { width: number; height: number } {
    // Lay out at PDF 100%; scale the entire layer instead of rewrapping text.
    // Viewport geometry avoids zoom-dependent integer rounding of page boxes.
    return {
      width: (handle.viewport.width || handle.element.clientWidth || rect.width) / handle.scale,
      height: (handle.viewport.height || handle.element.clientHeight || rect.height) / handle.scale,
    };
  }

  private pageScale(
    handle: PdfPageHandle,
    rect = handle.element.getBoundingClientRect(),
  ): { x: number; y: number } {
    const { width, height } = this.pageDimensions(handle, rect);
    return {
      x: (handle.element.clientWidth || rect.width || handle.viewport.width) / width,
      y: (handle.element.clientHeight || rect.height || handle.viewport.height) / height,
    };
  }

  private unmountPage(pageIndex: number): void {
    const mounted = this.mountedPages.get(pageIndex);
    if (!mounted) return;
    for (const runtime of mounted.runtimes) {
      runtime.cleanupHold?.();
      runtime.cleanupHold = undefined;
      runtime.imageEpoch += 1;
      runtime.pendingImages = 0;
      if (runtime.timer) clearTimeout(runtime.timer);
      if (runtime.statusTimer) clearTimeout(runtime.statusTimer);
    }
    mounted.overlay.remove();
    mounted.handle.element.classList.remove("zmc-page");
    this.mountedPages.delete(pageIndex);
  }

  private removeUi(): void {
    this.closeLightbox?.();
    this.closeLightbox = undefined;
    for (const pageIndex of [...this.mountedPages.keys()]) this.unmountPage(pageIndex);
    try {
      this.adapter.viewerElement().classList.remove("zmc-viewer");
      this.adapter.viewerElement().style.removeProperty("--zmc-gutter-width");
      this.adapter.document().getElementById(STYLE_ID)?.remove();
    } catch {
      // The reader may already be closed.
    }
    this.overlayRoot?.remove();
    this.overlayRoot = undefined;
  }
}

function typeLabel(type: MarginAnnotation["type"]): string {
  return {
    highlight: "高亮解释",
    underline: "下划线解释",
    note: "独立评论",
    text: "文本批注",
    image: "区域批注",
  }[type];
}

function measureHeight(card: HTMLElement, value: string, scale: number): number {
  const measured = card.getBoundingClientRect().height / scale || card.scrollHeight;
  if (measured > 0) return measured;
  return Math.min(210, Math.max(70, 54 + value.split("\n").length * 18));
}

function setPixelStyle(
  element: HTMLElement,
  property: "left" | "top" | "width" | "height",
  value: number,
): void {
  const next = `${value}px`;
  if (element.style[property] !== next) element.style[property] = next;
}
