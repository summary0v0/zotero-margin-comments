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
