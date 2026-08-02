import { config } from "../../package.json";
import {
  MARGIN_ANNOTATION_TYPES,
  type MarginAnnotationType,
} from "../core/types";
import { AnnotationStore } from "./annotation-store";
import { ReaderSession } from "./reader-session";
import { TOOLBAR_STYLES } from "./styles";

const TOOLBAR_STYLE_ID = "zmc-toolbar-styles";
const PREFERENCE_PANE_ROOT_ID = "zotero-prefpane-margincomments";
const COMPACT_NOTE_SETTING_SELECTOR = '[data-zmc-setting="compact-note-icons"]';

export class PluginController {
  private readonly store = new AnnotationStore();
  private readonly sessions = new Map<any, ReaderSession>();
  private readonly preferenceDocuments = new Set<Document>();
  private visibleTypes = new Set<MarginAnnotationType>(MARGIN_ANNOTATION_TYPES);
  private compactNoteIcons = false;
  private preferencePaneID?: string;
  private notifierID?: string;
  private enabled = true;
  private started = false;

  private readonly onRenderToolbar = (event: any) => {
    const { reader, doc, append } = event;
    if (!this.isPdfReader(reader)) return;
    const button = this.createToolbarButton(doc, reader);
    append(button);
    void this.ensureSession(reader);
  };

  private readonly onAnnotationContextMenu = (event: any) => {
    const { reader, params, append } = event;
    if (!this.isPdfReader(reader)) return;
    const ids = Array.isArray(params?.ids) ? params.ids.map(String) : [];
    append({
      label: "在页边显示/编辑评论",
      disabled: ids.length === 0,
      onCommand: () => void this.reveal(reader, ids),
    });
  };

  private readonly notifierObserver = {
    notify: (event: string, type: string) => {
      if (type === "tab") {
        this.pruneSessions();
        return;
      }
      if (type !== "item" || !["add", "modify", "delete", "trash"].includes(event)) {
        return;
      }
      this.pruneSessions();
      for (const session of this.sessions.values()) void session.refresh();
    },
  };

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.enabled = this.readEnabledPreference();
    this.visibleTypes = this.readVisibleTypesPreference();
    this.compactNoteIcons = this.readCompactNoteIconsPreference();

    await this.registerPreferencePane();

    const readerApi = (Zotero as any).Reader;
    readerApi.registerEventListener(
      "renderToolbar",
      this.onRenderToolbar,
      config.addonID,
    );
    readerApi.registerEventListener(
      "createAnnotationContextMenu",
      this.onAnnotationContextMenu,
      config.addonID,
    );
    this.notifierID = (Zotero.Notifier as any).registerObserver(
      this.notifierObserver,
      ["item", "tab"],
      config.addonID,
    );

    for (const reader of readerApi._readers ?? []) {
      if (!this.isPdfReader(reader)) continue;
      void this.ensureSession(reader);
      setTimeout(() => this.installFallbackToolbarButton(reader), 350);
    }
  }

  registerWindow(_win: Window): void {}

  unregisterWindow(_win: Window): void {}

  async stop(): Promise<void> {
    this.started = false;
    (Zotero as any).Reader?._unregisterEventListenerByPluginID?.(config.addonID);
    if (this.notifierID) {
      (Zotero.Notifier as any).unregisterObserver(this.notifierID);
      this.notifierID = undefined;
    }

    for (const session of this.sessions.values()) session.destroy();
    this.sessions.clear();
    this.preferenceDocuments.clear();
    if (this.preferencePaneID) {
      try {
        (Zotero as any).PreferencePanes?.unregister?.(this.preferencePaneID);
      } catch (error) {
        (Zotero as any).logError?.(error);
      }
      this.preferencePaneID = undefined;
    }
    for (const reader of (Zotero as any).Reader?._readers ?? []) {
      this.removeToolbarUi(reader?._iframeWindow?.document);
    }
  }

  registerPreferencePaneWindow(win: Window): void {
    const doc = win.document;
    const root = doc.getElementById(PREFERENCE_PANE_ROOT_ID);
    if (!root) return;
    this.preferenceDocuments.add(doc);

    root.querySelectorAll<HTMLInputElement>("[data-zmc-type]").forEach((checkbox) => {
      const type = checkbox.dataset.zmcType as MarginAnnotationType | undefined;
      if (!type || !MARGIN_ANNOTATION_TYPES.includes(type)) return;
      checkbox.checked = this.visibleTypes.has(type);
      if (checkbox.dataset.zmcBound === "true") return;
      checkbox.dataset.zmcBound = "true";
      checkbox.addEventListener("change", () => {
        this.setTypeVisible(type, checkbox.checked);
      });
    });

    const compactNoteCheckbox = root.querySelector<HTMLInputElement>(
      COMPACT_NOTE_SETTING_SELECTOR,
    );
    if (compactNoteCheckbox) {
      compactNoteCheckbox.checked = this.compactNoteIcons;
      if (compactNoteCheckbox.dataset.zmcBound !== "true") {
        compactNoteCheckbox.dataset.zmcBound = "true";
        compactNoteCheckbox.addEventListener("change", () => {
          this.setCompactNoteIcons(compactNoteCheckbox.checked);
        });
      }
    }
  }

  private async ensureSession(reader: any): Promise<ReaderSession | undefined> {
    if (!this.started || !this.isPdfReader(reader)) return undefined;
    const existing = this.sessions.get(reader);
    if (existing) {
      existing.setVisibleTypes(this.visibleTypes);
      existing.setCompactNoteIcons(this.compactNoteIcons);
      await existing.start(this.enabled);
      return existing;
    }

    const session = new ReaderSession(reader, this.store, () => this.updateToolbarButtons());
    session.setVisibleTypes(this.visibleTypes);
    session.setCompactNoteIcons(this.compactNoteIcons);
    this.sessions.set(reader, session);
    try {
      await session.start(this.enabled);
      return session;
    } catch (error) {
      this.sessions.delete(reader);
      session.destroy();
      (Zotero as any).logError?.(error);
      return undefined;
    }
  }

  private async reveal(reader: any, keys: string[]): Promise<void> {
    const session = await this.ensureSession(reader);
    await session?.reveal(keys);
  }

  private toggleEnabled(): void {
    this.enabled = !this.enabled;
    try {
      (Zotero.Prefs as any).set(`${config.prefsPrefix}.enabled`, this.enabled, true);
    } catch (error) {
      (Zotero as any).logError?.(error);
    }
    for (const session of this.sessions.values()) session.setEnabled(this.enabled);
    this.updateToolbarButtons();
  }

  private readEnabledPreference(): boolean {
    try {
      const value = (Zotero.Prefs as any).get(`${config.prefsPrefix}.enabled`, true);
      return value === undefined ? true : Boolean(value);
    } catch {
      return true;
    }
  }

  private readVisibleTypesPreference(): Set<MarginAnnotationType> {
    const result = new Set<MarginAnnotationType>();
    for (const type of MARGIN_ANNOTATION_TYPES) {
      try {
        const value = (Zotero.Prefs as any).get(
          `${config.prefsPrefix}.types.${type}`,
          true,
        );
        if (value === undefined || Boolean(value)) result.add(type);
      } catch {
        result.add(type);
      }
    }
    return result;
  }

  private readCompactNoteIconsPreference(): boolean {
    try {
      const value = (Zotero.Prefs as any).get(
        `${config.prefsPrefix}.compactNoteIcons`,
        true,
      );
      return value === undefined ? false : Boolean(value);
    } catch {
      return false;
    }
  }

  private setTypeVisible(type: MarginAnnotationType, visible: boolean): void {
    if (visible) {
      this.visibleTypes.add(type);
    } else {
      this.visibleTypes.delete(type);
    }
    try {
      (Zotero.Prefs as any).set(
        `${config.prefsPrefix}.types.${type}`,
        visible,
        true,
      );
    } catch (error) {
      (Zotero as any).logError?.(error);
    }
    for (const session of this.sessions.values()) {
      session.setVisibleTypes(this.visibleTypes);
    }
    this.syncPreferenceCheckboxes();
  }

  private setCompactNoteIcons(enabled: boolean): void {
    this.compactNoteIcons = enabled;
    try {
      (Zotero.Prefs as any).set(
        `${config.prefsPrefix}.compactNoteIcons`,
        enabled,
        true,
      );
    } catch (error) {
      (Zotero as any).logError?.(error);
    }
    for (const session of this.sessions.values()) {
      session.setCompactNoteIcons(enabled);
    }
    this.syncPreferenceCheckboxes();
  }

  private async registerPreferencePane(): Promise<void> {
    const preferencePanes = (Zotero as any).PreferencePanes;
    if (!preferencePanes?.register) return;
    try {
      this.preferencePaneID = await preferencePanes.register({
        pluginID: config.addonID,
        id: "margin-comments-preferences",
        label: "页边批注",
        src: `chrome://${config.addonRef}/content/preferences.xhtml`,
        image: `chrome://${config.addonRef}/content/icons/margin-comments.svg`,
        stylesheets: [
          `chrome://${config.addonRef}/content/preferences.css`,
        ],
      });
    } catch (error) {
      (Zotero as any).logError?.(error);
    }
  }

  private createToolbarButton(doc: Document, reader: any): HTMLButtonElement {
    this.ensureToolbarStyles(doc);
    const button = doc.createElement("button");
    const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    const page = doc.createElementNS("http://www.w3.org/2000/svg", "rect");
    const line1 = doc.createElementNS("http://www.w3.org/2000/svg", "path");
    const line2 = doc.createElementNS("http://www.w3.org/2000/svg", "path");
    const card = doc.createElementNS("http://www.w3.org/2000/svg", "rect");
    const leader = doc.createElementNS("http://www.w3.org/2000/svg", "path");

    button.type = "button";
    button.className = "toolbar-button zmc-toolbar-toggle";
    button.title = "页边批注：显示划线解释和独立评论";
    button.setAttribute("aria-label", button.title);
    button.dataset.zmcItemID = String(reader?.itemID ?? "");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    page.setAttribute("x", "2.5");
    page.setAttribute("y", "3");
    page.setAttribute("width", "11");
    page.setAttribute("height", "18");
    page.setAttribute("rx", "1.2");
    page.setAttribute("fill", "none");
    page.setAttribute("stroke", "currentColor");
    page.setAttribute("stroke-width", "1.5");
    line1.setAttribute("d", "M5 8h6M5 11h5");
    line2.setAttribute("d", "M5 14h6");
    line1.setAttribute("stroke", "currentColor");
    line2.setAttribute("stroke", "currentColor");
    line1.setAttribute("stroke-width", "1.3");
    line2.setAttribute("stroke-width", "1.3");
    card.setAttribute("x", "17");
    card.setAttribute("y", "7");
    card.setAttribute("width", "5");
    card.setAttribute("height", "8");
    card.setAttribute("rx", "1");
    card.setAttribute("fill", "currentColor");
    leader.setAttribute("d", "M12 11.5h3l2-1.5");
    leader.setAttribute("fill", "none");
    leader.setAttribute("stroke", "currentColor");
    leader.setAttribute("stroke-width", "1.3");
    svg.append(page, line1, line2, leader, card);
    button.append(svg);
    button.addEventListener("click", () => this.toggleEnabled());
    this.syncToolbarButton(button);
    return button;
  }

  private syncPreferenceCheckboxes(): void {
    for (const doc of [...this.preferenceDocuments]) {
      const root = doc.getElementById(PREFERENCE_PANE_ROOT_ID);
      if (!root) {
        this.preferenceDocuments.delete(doc);
        continue;
      }
      root.querySelectorAll<HTMLInputElement>("[data-zmc-type]").forEach((checkbox) => {
        const type = checkbox.dataset.zmcType as MarginAnnotationType | undefined;
        if (!type) return;
        checkbox.checked = this.visibleTypes.has(type);
      });
      const compactNoteCheckbox = root.querySelector<HTMLInputElement>(
        COMPACT_NOTE_SETTING_SELECTOR,
      );
      if (compactNoteCheckbox) compactNoteCheckbox.checked = this.compactNoteIcons;
    }
  }

  private installFallbackToolbarButton(reader: any): void {
    const doc = reader?._iframeWindow?.document as Document | undefined;
    if (!doc || doc.querySelector(".zmc-toolbar-toggle")) return;
    const customSections = doc.querySelector<HTMLElement>(".toolbar .end .custom-sections");
    if (!customSections) return;
    const section = doc.createElement("div");
    section.className = "section zmc-fallback-section";
    section.append(this.createToolbarButton(doc, reader));
    customSections.append(section);
  }

  private updateToolbarButtons(): void {
    for (const reader of (Zotero as any).Reader?._readers ?? []) {
      const doc = reader?._iframeWindow?.document as Document | undefined;
      doc?.querySelectorAll<HTMLButtonElement>(".zmc-toolbar-toggle").forEach((button) =>
        this.syncToolbarButton(button),
      );
    }
  }

  private syncToolbarButton(button: HTMLButtonElement): void {
    button.classList.toggle("active", this.enabled);
    button.setAttribute("aria-pressed", String(this.enabled));
    button.title = this.enabled
      ? "页边批注已显示（点击隐藏）"
      : "页边批注已隐藏（点击显示）";
  }

  private ensureToolbarStyles(doc: Document): void {
    if (doc.getElementById(TOOLBAR_STYLE_ID)) return;
    const style = doc.createElement("style");
    style.id = TOOLBAR_STYLE_ID;
    style.textContent = TOOLBAR_STYLES;
    doc.head.append(style);
  }

  private removeToolbarUi(doc?: Document): void {
    if (!doc) return;
    doc.querySelectorAll(
      ".zmc-toolbar-toggle,.zmc-fallback-section",
    ).forEach((node) => node.remove());
    doc.getElementById(TOOLBAR_STYLE_ID)?.remove();
  }

  private pruneSessions(): void {
    const live = new Set<any>((Zotero as any).Reader?._readers ?? []);
    for (const [reader, session] of this.sessions) {
      if (live.has(reader)) continue;
      session.destroy();
      this.sessions.delete(reader);
    }
  }

  private isPdfReader(reader: any): boolean {
    return !!reader && (reader._type === "pdf" || reader.type === "pdf");
  }
}
