/* Runs only inside the isolated Zotero library created by --images. */
async function verifyCommentImages({ attachment, annotation, session, adapter, reader, scope, result, root }) {
  const doc = adapter.document();
  const win = reader._internalReader._primaryView._iframeWindow;
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const checkpoint = async (stage) => {
    result.stage = stage;
    await Zotero.File.putContentsAsync(PathUtils.join(root, "results.json"), JSON.stringify(result, null, 2));
  };
  async function waitFor(check, message) {
    for (let i = 0; i < 150; i++) {
      if (await check()) return;
      await pause(40);
    }
    throw new Error(message);
  }
  const canvas = Zotero.getMainWindow().document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = 640; canvas.height = 240;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#edf3fc"; ctx.fillRect(0, 0, 640, 240);
  ctx.fillStyle = "#26456b"; ctx.font = "bold 30px sans-serif"; ctx.fillText("批注图片验证", 32, 52);
  ctx.font = "20px sans-serif"; ctx.fillText("本地文件 · 相对引用 · 保存后可重新加载", 32, 92);
  for (const [x, text] of [[32, "原始图片"], [244, "本地资源"], [456, "批注预览"]]) {
    ctx.fillStyle = "#4a78c2"; ctx.fillRect(x, 130, 152, 64);
    ctx.fillStyle = "white"; ctx.font = "20px sans-serif"; ctx.fillText(text, x + 16, 170);
  }
  const base64 = canvas.toDataURL("image/png").split(",")[1];
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const fixture = PathUtils.join(root, "fixture.png");
  await IOUtils.write(fixture, bytes);
  const clip = Cc["@mozilla.org/widget/clipboard;1"].getService(Ci.nsIClipboard);
  const transfer = () => Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
  const previous = [];
  for (const flavor of ["text/unicode", "text/plain", "text/html", "text/x-moz-url", "application/x-moz-file", "application/x-moz-nativeimage", "image/png", "image/jpeg"]) {
    try {
      const item = transfer(); item.init(null); item.addDataFlavor(flavor);
      clip.getData(item, clip.kGlobalClipboard);
      const value = {}; item.getTransferData(flavor, value);
      if (value.value) previous.push([flavor, value.value]);
    } catch {}
  }
  try {
    await checkpoint("image-clipboard-setup");
    const imgTools = Cc["@mozilla.org/image/tools;1"].getService(Ci.imgITools);
    const nativeImage = imgTools.decodeImageFromArrayBuffer(bytes.buffer, "image/png");
    const data = transfer(); data.init(null); data.addDataFlavor("application/x-moz-nativeimage");
    data.setTransferData("application/x-moz-nativeimage", nativeImage);
    clip.setData(data, null, clip.kGlobalClipboard);
    result.clipboardDiagnostics = {
      hostComponents: !!Zotero.getMainWindow().Components,
      hostIOUtils: !!Zotero.getMainWindow().IOUtils,
    };
    try {
      const check = transfer(); check.init(null); check.addDataFlavor("image/png");
      clip.getData(check, clip.kGlobalClipboard);
      const value = {}; check.getTransferData("image/png", value);
      result.clipboardDiagnostics.pngAvailable = !!value.value;
    } catch (error) { result.clipboardDiagnostics.pngError = String(error); }
    annotation.annotationComment = "图片粘贴测试：AB";
    await annotation.saveTx();
    await session.refresh(true);
    const card = () => doc.querySelector(`.zmc-card[data-annotation-key="${annotation.key}"]`);
    const edit = () => {
      card().querySelector(".zmc-card-preview").click();
      return card().querySelector(".zmc-card-editor");
    };
    const endCaret = (editor) => {
      const range = doc.createRange(); range.selectNodeContents(editor); range.collapse(false);
      const selection = win.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    };
    let editor = edit();
    await checkpoint("image-editor-ready");
    const paste = () => {
      editor.focus({ preventScroll: true });
      Services.focus.setFocus(editor, 0);
      const host = Zotero.getMainWindow();
      const controller = host.document.commandDispatcher.getControllerForCommand("cmd_paste");
      result.imagesDebug = {
        activeEditor: doc.activeElement === editor,
        pasteController: !!controller, pasteEnabled: controller?.isCommandEnabled("cmd_paste"),
        nativeClipboardBytes: session.images.readClipboardPNG()?.length || 0,
      };
      if (!controller) throw new Error("Native paste controller is unavailable");
      // Gecko can report NS_ERROR_FAILURE when our paste handler takes over
      // with preventDefault. Verify the inserted result below instead.
      try { controller.doCommand("cmd_paste"); }
      catch (error) { result.imagesDebug.commandResult = String(error); }
    };
    const range = doc.createRange();
    range.setStart(editor.firstChild, "图片粘贴测试：A".length); range.collapse(true);
    win.getSelection().removeAllRanges(); win.getSelection().addRange(range);
    let clipboardEvent;
    editor.addEventListener("paste", (event) => {
      clipboardEvent = {
        trusted: event.isTrusted, types: Array.from(event.clipboardData?.types ?? []),
        items: Array.from(event.clipboardData?.items ?? []).map((item) => ({ kind: item.kind, type: item.type })),
      };
    }, { once: true });
    paste();
    await checkpoint("image-paste-dispatched");
    const refPattern = /margin-comments-assets\/[A-Z0-9]{8}\/[a-f0-9]{64}\.png/g;
    await waitFor(() => {
      const error = card().querySelector('.zmc-save-state[data-error="true"]');
      if (error) throw new Error(error.textContent);
      refPattern.lastIndex = 0;
      return refPattern.test(editor.textContent);
    }, "Native clipboard image was not inserted: " + JSON.stringify(clipboardEvent));
    refPattern.lastIndex = 0;
    const refs = (value) => value.match(/margin-comments-assets\/[A-Z0-9]{8}\/[a-f0-9]{64}\.png/g) || [];
    const firstRef = refs(editor.textContent)[0];
    await checkpoint("image-reference-inserted");
    const sourceAfterPaste = session.readComment(editor);
    if (!sourceAfterPaste.includes("A\n![") || !sourceAfterPaste.endsWith("B")) {
      throw new Error("Image paste lost the insertion caret or text: " + JSON.stringify(sourceAfterPaste));
    }
    await waitFor(() => refs(annotation.annotationComment).length === 1, "Image reference was not saved to Zotero");
    const path = PathUtils.join(PathUtils.parent(await attachment.getFilePathAsync()), ...firstRef.split("/"));
    if (!path.startsWith(root) || !await IOUtils.exists(path)) throw new Error("Image was not saved beside the isolated PDF");
    await waitFor(() => card().querySelector(".zmc-card-preview img")?.naturalWidth === 640, "Saved image did not decode inside the native Reader");
    endCaret(editor); paste();
    await waitFor(() => refs(annotation.annotationComment).length === 2, "Second native image paste did not save");
    await waitFor(() => card().querySelector(".zmc-save-state")?.textContent === "已保存", "Second paste save transaction is not finished");
    if (new Set(refs(annotation.annotationComment)).size !== 1) throw new Error("Duplicate image was not deduplicated");
    if ((await IOUtils.getChildren(PathUtils.parent(path))).length !== 1) throw new Error("Duplicate or temporary asset files remain");
    await checkpoint("image-duplicate-checked");
    // Cancel a paste while disk work is pending. The late result must not reinsert.
    const beforeCancel = annotation.annotationComment;
    const realImport = session.images.importBytes.bind(session.images);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    session.images.importBytes = async (...args) => { await gate; return realImport(...args); };
    endCaret(editor); paste();
    await pause(40);
    const editorSelector = `.zmc-card[data-annotation-key="${annotation.key}"] .zmc-card-editor`;
    // Event dictionaries must be constructed in the PDF realm (otherwise
    // Xrays hide the chrome object's key property and Gecko sees an empty key).
    const cancelKey = win.eval(`(() => {
      const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
      document.querySelector(${JSON.stringify(editorSelector)}).dispatchEvent(event);
      return event.key;
    })()`);
    result.imagesDebug.cancelKey = cancelKey;
    release(); await pause(180);
    session.images.importBytes = realImport;
    if (annotation.annotationComment !== beforeCancel || session.readComment(editor) !== beforeCancel) {
      throw new Error("Late paste changed a cancelled comment: " + JSON.stringify({
        key: cancelKey, before: refs(beforeCancel).length,
        saved: refs(annotation.annotationComment).length, editor: refs(session.readComment(editor)).length,
      }));
    }
    await checkpoint("image-cancel-checked");
    // The focused insertText operation must participate in Gecko's native undo.
    editor = edit(); endCaret(editor); paste();
    await waitFor(() => refs(editor.textContent).length === 3, "Undo test paste failed");
    doc.execCommand("undo");
    await waitFor(() => refs(annotation.annotationComment).length === 2, "Native undo did not remove the image reference");
    await checkpoint("image-undo-checked");
    // Drive the file-picker entry point with an isolated fixture path.
    const realPicker = session.images.pickFile.bind(session.images);
    session.images.pickFile = async () => fixture;
    endCaret(editor); card().querySelector(".zmc-insert-image").click();
    await waitFor(() => refs(annotation.annotationComment).length === 3, "File image entry point did not save");
    session.images.pickFile = realPicker;
    editor.blur(); await pause(100);
    const persisted = annotation.annotationComment;
    await attachment.renameAttachmentFile("renamed-image-test.pdf");
    // Create an owned orphan plus unrelated files. Only the orphan may be
    // deleted when a new PDF reader session performs its opening-time scan.
    ctx.fillStyle = "#c82f43"; ctx.fillRect(0, 0, 6, 6);
    const orphanBase64 = canvas.toDataURL("image/png").split(",")[1];
    const orphanBytes = Uint8Array.from(atob(orphanBase64), (c) => c.charCodeAt(0));
    const orphan = await session.images.importBytes(orphanBytes, "未引用图片.png");
    const pdfDirectory = PathUtils.parent(await attachment.getFilePathAsync());
    const orphanPath = PathUtils.join(pdfDirectory, ...orphan.reference.split("/"));
    const customFile = PathUtils.join(PathUtils.parent(path), "user-file.txt");
    await IOUtils.writeUTF8(customFile, "自动清理不得删除这个文件");
    const otherFolder = PathUtils.join(pdfDirectory, "margin-comments-assets", "OTHER001");
    await IOUtils.makeDirectory(otherFolder, { createAncestors: true });
    const otherFile = PathUtils.join(otherFolder, "f".repeat(64) + ".png");
    await IOUtils.write(otherFile, orphanBytes);
    session.destroy();
    session = new scope.MarginSession(reader, new scope.MarginStore(), () => {});
    session.setCollapseNotes(false);
    await session.start(true);
    const firstCleanup = await session.imageCleanup;
    if (!firstCleanup?.deleted.includes(orphan.reference) || await IOUtils.exists(orphanPath)) {
      throw new Error("Opening the PDF did not delete its unreferenced image");
    }
    if (!await IOUtils.exists(path) || !await IOUtils.exists(customFile) || !await IOUtils.exists(otherFile)) {
      throw new Error("Cleanup removed a referenced or unrelated file");
    }
    await waitFor(() => card().querySelector(".zmc-card-preview img")?.naturalWidth === 640, "Reopening/renaming lost the image");
    await session.images.importBytes(orphanBytes, "第二次未引用图片.png");
    session.setEnabled(false); session.setEnabled(true);
    await pause(100);
    if (!await IOUtils.exists(orphanPath)) throw new Error("Toggling visibility unexpectedly ran image cleanup");
    session.destroy();
    session = new scope.MarginSession(reader, new scope.MarginStore(), () => {});
    session.setCollapseNotes(false);
    await session.start(true);
    const secondCleanup = await session.imageCleanup;
    if (!secondCleanup?.deleted.includes(orphan.reference) || await IOUtils.exists(orphanPath)) {
      throw new Error("The next PDF opening did not run cleanup again");
    }
    result.imageCleanup = {
      openingDeletesUnreferenced: true, nextOpeningRunsAgain: true,
      referencedImageKept: true, customFileKept: true, otherPDFDirectoryKept: true,
      visibilityToggleDoesNotClean: true, deletedReference: orphan.reference,
    };
    // Missing files leave the relative reference intact and recover on restore.
    await IOUtils.move(path, path + ".missing-test");
    session.setEnabled(false); session.setEnabled(true);
    await waitFor(() => card()?.querySelector(".zmc-image-missing"), "Missing image was not identified");
    if (annotation.annotationComment !== persisted) throw new Error("Missing image changed the comment");
    await IOUtils.move(path + ".missing-test", path);
    session.setEnabled(false); session.setEnabled(true);
    await waitFor(() => card()?.querySelector(".zmc-card-preview img")?.naturalWidth === 640, "Restored image did not load");
    card().querySelector(".zmc-card-preview img").click();
    if (!doc.querySelector(".zmc-image-lightbox img")) throw new Error("Image enlargement is missing");
    doc.querySelector(".zmc-image-lightbox button").click();
    editor = edit();
    await pause(100);
    const snapshot = await Zotero.getMainWindow().docShell.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "rgb(255,255,255)");
    const editorCanvas = Zotero.getMainWindow().document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    editorCanvas.width = snapshot.width; editorCanvas.height = snapshot.height;
    editorCanvas.getContext("2d").drawImage(snapshot, 0, 0);
    const editorPNG = editorCanvas.toDataURL("image/png").split(",")[1];
    await IOUtils.write(PathUtils.join(root, "editor.png"), Uint8Array.from(atob(editorPNG), (c) => c.charCodeAt(0)));
    snapshot.close();
    editor.blur(); await pause(100);
    result.images = {
      clipboardEvent, relativeReference: firstRef, imagePath: path,
      naturalWidth: 640, duplicateAssetFiles: 1,
      pasteAtCaret: true, savedToAnnotation: true, cancelledPasteStable: true,
      nativeUndo: true, fileSelectionEntry: true, renameAndReload: true,
      missingFilePreservesReference: true, restoredFileLoads: true, enlargement: true,
      editorScreenshot: "editor.png",
    };
    return session;
  } finally {
    if (previous.length) {
      const original = transfer(); original.init(null);
      for (const [flavor, value] of previous) { original.addDataFlavor(flavor); original.setTransferData(flavor, value); }
      clip.setData(original, null, clip.kGlobalClipboard);
    } else clip.emptyClipboard(clip.kGlobalClipboard);
  }
}
