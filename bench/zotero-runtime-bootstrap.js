/* Injected only into the isolated test addon by verify-zotero-runtime.mjs. */
function install() {}
function shutdown() {}
function uninstall() {}

async function startup() {
  const root = __ZMC_QA_ROOT__;
  const input = __ZMC_QA_INPUT__;
  const result = { passed: false, stage: "starting" };
  const write = () => Zotero.File.putContentsAsync(
    PathUtils.join(root, "results.json"), JSON.stringify(result, null, 2),
  );
  try {
    await Promise.all([Zotero.initializationPromise, Zotero.unlockPromise, Zotero.uiReadyPromise]);
    result.version = Zotero.version;
    result.dataDirectory = Zotero.DataDirectory.dir;
    if (Zotero.DataDirectory.dir !== PathUtils.join(root, "data")) {
      throw new Error("Refusing to operate outside the isolated QA library");
    }
    result.stage = "opening-reader";
    await write();
    const attachment = await Zotero.Attachments.importFromFile({ file: input });
    const comment = [
      "| 术语 | 含义 |", "| --- | --- |",
      "| Pre-trained（预训练） | 模型已经过预训练，具有一定的知识和特征提取能力 |",
      "| Frozen（冻结） | 当前任务训练时冻结模型参数，不更新权重 |",
      "| Fine-tuned（微调） | 在预训练模型上使用当前任务数据继续训练 |",
      "", "$$P=\\frac{N_{matched}}{N_{pred}}\\cdot\\overline{\\operatorname{sim}}$$",
    ].join("\n");
    const annotation = await Zotero.Annotations.saveFromJSON(attachment, {
      key: Zotero.DataObjectUtilities.generateKey(), type: "highlight", color: "#ffd400",
      text: "PDF whitespace runtime test", comment, pageLabel: "2",
      sortIndex: "00001|000100|00000",
      position: { pageIndex: 1, rects: [[205, 585, 470, 599]] },
    });
    const reader = await Zotero.Reader.open(attachment.id);
    await reader._initPromise;
    reader.navigate({ pageIndex: 1 });
    const scope = { Zotero, setTimeout, clearTimeout, setInterval, clearInterval };
    scope.globalThis = scope;
    const bundle = Zotero.File.pathToFile(PathUtils.join(root, "probe.js"));
    Services.scriptloader.loadSubScript(Services.io.newFileURI(bundle).spec, scope);
    const adapter = new scope.MarginAdapter(reader);
    await adapter.ready();
    const application = reader._internalReader._primaryView._iframeWindow.PDFViewerApplication;
    for (let i = 0; i < 100 && !application.pdfViewer.getPageView(1)?.pdfPage; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const pdfPage = application.pdfViewer.getPageView(1).pdfPage;
    try {
      const old = pdfPage.getViewport({ scale: 1, rotation: 0 });
      result.directViewport = { width: String(old.width), finite: Number.isFinite(old.width) };
    } catch (error) { result.directViewport = { error: String(error) }; }
    const profile = await adapter.pageWhitespace(adapter.page(1));
    result.profileRows = profile?.rows.length ?? 0;
    if (!result.profileRows) throw new Error("Native PDF iframe returned no whitespace profile");
    const session = new scope.MarginSession(reader, new scope.MarginStore(), () => {});
    session.setCollapseNotes(false);
    await session.start(true);
    Zotero.getMainWindow().resizeTo(2200, 1400);
    application.pdfViewer.currentScale = 1;
    const doc = adapter.document();
    let card, column;
    for (let i = 0; i < 200; i++) {
      card = doc.querySelector(`.zmc-card[data-annotation-key="${annotation.key}"]`);
      column = card?.closest(".zmc-margin-column");
      if (column?.dataset.placement === "overhang" && Math.abs(card.getBoundingClientRect().width - 360) < 1) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!card || column.dataset.placement !== "overhang") throw new Error("Native Reader did not preserve width across the paper edge");
    const page = adapter.page(1).element.getBoundingClientRect();
    const bounds = card.getBoundingClientRect();
    result.layout = {
      mode: column.dataset.placement,
      paperLeft: page.left, paperRight: page.right,
      cardLeft: bounds.left, cardRight: bounds.right, cardWidth: bounds.width,
      inPaper: bounds.left >= page.left && bounds.right <= page.right,
      startsInPaper: bounds.left >= page.left && bounds.left < page.right,
      extendsBeyondPaper: bounds.right > page.right,
      renderedTable: Boolean(card.querySelector("table")),
      renderedMath: Boolean(card.querySelector("math")),
    };
    if (!result.layout.startsInPaper || !result.layout.extendsBeyondPaper || Math.abs(bounds.width - 360) > 1) {
      throw new Error("Native Reader did not use the paper margin while retaining the reading width");
    }
    if (__ZMC_QA_DRAG__) {
      const pdfWindow = reader._internalReader._primaryView._iframeWindow;
      const utils = Cu.unwaiveXrays(pdfWindow).windowUtils;
      const view = reader._internalReader._primaryView;
      card.querySelector(".zmc-card-preview").click();
      const editor = card.querySelector(".zmc-card-editor");
      const source = Array.from({ length: 9 }, (_, i) => `第${i + 1}行：笔记中的文字应该可以跨行拖动选取。`).join("\n");
      editor.textContent = source;
      const inputEvent = doc.createEvent("Event");
      inputEvent.initEvent("input", true, false);
      editor.dispatchEvent(inputEvent);
      editor.scrollIntoView({ block: "center", inline: "nearest" });
      await new Promise((resolve) => setTimeout(resolve, 150));
      function point(offset) {
        const range = doc.createRange();
        range.setStart(editor.firstChild, offset);
        range.setEnd(editor.firstChild, offset + 1);
        const rect = range.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
      async function drag(start, end) {
        utils.sendMouseEvent("mousemove", start.x, start.y, 0, 0, 0);
        utils.sendMouseEvent("mousedown", start.x, start.y, 0, 1, 0);
        const actionAfterDown = view.action?.type ?? null;
        for (let i = 1; i <= 20; i++) {
          utils.sendMouseEvent("mousemove", start.x + (end.x - start.x) * i / 20, start.y + (end.y - start.y) * i / 20, 0, 0, 0);
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        utils.sendMouseEvent("mouseup", end.x, end.y, 0, 1, 0);
        await new Promise((resolve) => setTimeout(resolve, 120));
        return actionAfterDown;
      }
      const action = await drag(point(2), point(source.indexOf("第7行") + 8));
      const selection = pdfWindow.getSelection();
      result.dragSelection = {
        actionAfterDown: action,
        selectedLength: selection.toString().length,
        anchorInEditor: editor.contains(selection.anchorNode),
        focusInEditor: editor.contains(selection.focusNode),
        pdfRanges: view._selectionRanges.length,
        editorUnchanged: editor.textContent === source,
      };
      if (!result.dragSelection.anchorInEditor || !result.dragSelection.focusInEditor || result.dragSelection.selectedLength < 80) {
        throw new Error("Multi-line drag escaped the note editor");
      }
      // Start beyond the previous range: pressing inside already-selected text
      // asks Gecko to drag that text rather than begin a new selection.
      await drag(point(source.indexOf("第9行") + 8), point(2));
      result.reverseSelection = {
        selectedLength: selection.toString().length,
        anchorInEditor: editor.contains(selection.anchorNode),
        focusInEditor: editor.contains(selection.focusNode),
      };
      if (!result.reverseSelection.anchorInEditor || !result.reverseSelection.focusInEditor || result.reverseSelection.selectedLength < 80) {
        throw new Error("Reverse multi-line drag escaped the note editor");
      }
      editor.blur();
      await new Promise((resolve) => setTimeout(resolve, 150));
      const spans = Array.from(doc.querySelectorAll('.page[data-page-number="2"] .textLayer span')).filter((span) => {
        const rect = span.getBoundingClientRect();
        return span.textContent.trim().length > 10 && rect.width > 80 && rect.top > 10 && rect.bottom < pdfWindow.innerHeight - 10;
      });
      const start = spans[1].getBoundingClientRect(), end = spans[4].getBoundingClientRect();
      await drag({ x: start.left + 10, y: start.top + start.height / 2 }, { x: end.left + Math.min(100, end.width / 2), y: end.top + end.height / 2 });
      result.pdfSelectionRestored = view._selectionRanges.some((range) => !range.collapsed);
      if (!result.pdfSelectionRestored) throw new Error("PDF selection stayed blocked after the note drag");
      // End the screenshot on a real note drag, rather than the PDF gesture
      // used above to verify that normal document selection still works.
      view.clearSelection();
      view._render();
      card.querySelector(".zmc-card-preview").click();
      await drag(point(2), point(source.indexOf("第7行") + 8));
      if (!editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode) || selection.toString().length < 80) {
        throw new Error("Note selection did not work after returning from PDF text");
      }
    }
    if (__ZMC_QA_SIDES__) {
      await verifyMarginSides({ attachment, annotation, session, adapter, application, pdfPage, result });
    }
    try {
      adapter.centerCurrentPageHorizontally();
      await new Promise((resolve) => setTimeout(resolve, 200));
      const image = await Zotero.getMainWindow().docShell.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "rgb(255,255,255)");
      const canvas = Zotero.getMainWindow().document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      canvas.getContext("2d").drawImage(image, 0, 0);
      const base64 = canvas.toDataURL("image/png").split(",")[1];
      await IOUtils.write(PathUtils.join(root, "screenshot.png"), Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
      image.close();
      result.screenshot = "screenshot.png";
    } catch (error) { result.screenshotError = String(error); }
    session.destroy();
    adapter.destroy();
    result.passed = true;
    result.stage = "finished";
  } catch (error) {
    result.error = String(error);
    result.stack = error.stack;
  } finally {
    await write();
    Services.startup.quit(Ci.nsIAppStartup.eForceQuit);
  }
}
