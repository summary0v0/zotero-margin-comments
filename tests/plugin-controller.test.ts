import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginController } from "../src/zotero/plugin-controller";

describe("PluginController annotation type settings", () => {
  beforeEach(() => {
    document.head.replaceChildren();
    document.body.replaceChildren();
    vi.stubGlobal("Zotero", {
      Prefs: {
        get: vi.fn(() => true),
        set: vi.fn(),
      },
      PreferencePanes: {
        register: vi.fn().mockResolvedValue("margin-comments-preferences"),
        unregister: vi.fn(),
      },
      Reader: { _readers: [] },
      logError: vi.fn(),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("registers a preference pane and persists type changes immediately", async () => {
    const controller = new PluginController() as any;
    const session = { setVisibleTypes: vi.fn() };
    controller.sessions.set({}, session);
    await controller.registerPreferencePane();

    expect((Zotero as any).PreferencePanes.register).toHaveBeenCalledWith({
      pluginID: "margin-comments@local.zotero",
      id: "margin-comments-preferences",
      label: "页边批注",
      src: "chrome://margincomments/content/preferences.xhtml",
      image: "chrome://margincomments/content/icons/margin-comments.svg",
      stylesheets: ["chrome://margincomments/content/preferences.css"],
    });

    const pane = document.createElement("section");
    pane.id = "zotero-prefpane-margincomments";
    for (const type of ["highlight", "underline", "note", "text", "image"]) {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.zmcType = type;
      pane.append(checkbox);
    }
    document.body.append(pane);
    controller.registerPreferencePaneWindow(window);

    const checkboxes = pane.querySelectorAll<HTMLInputElement>("[data-zmc-type]");
    expect(checkboxes).toHaveLength(5);
    expect(
      (Array.from(checkboxes) as HTMLInputElement[]).map(
        (checkbox) => checkbox.dataset.zmcType,
      ),
    ).toEqual(["highlight", "underline", "note", "text", "image"]);

    const underline = pane.querySelector<HTMLInputElement>(
      '[data-zmc-type="underline"]',
    )!;
    underline.click();

    expect(underline.checked).toBe(false);
    expect((Zotero as any).Prefs.set).toHaveBeenCalledWith(
      "extensions.zotero.margincomments.types.underline",
      false,
      true,
    );
    const visibleTypes = session.setVisibleTypes.mock.calls.at(-1)![0] as Set<string>;
    expect(visibleTypes.has("underline")).toBe(false);
    expect(visibleTypes.has("highlight")).toBe(true);
  });
});
