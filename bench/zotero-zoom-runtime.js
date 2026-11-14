/* Injected into an isolated Zotero library; no personal preferences are used. */
async function verifyCommentZoom({ annotation, session, adapter, application, reader, scope, result, root }) {
  const doc = adapter.document();
  const win = reader._internalReader._primaryView._iframeWindow;
  const card = doc.querySelector(`.zmc-card[data-annotation-key="${annotation.key}"]`);
  const preview = card.querySelector(".zmc-card-preview");
  const overlay = card.closest(".zmc-page-overlay");
  const column = card.closest(".zmc-margin-column");
  const originalHTML = preview.innerHTML;
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  function snapshot() {
    const page = adapter.page(1).element;
    const p = page.getBoundingClientRect(), c = card.getBoundingClientRect();
    const lines = doc.querySelector(`.zmc-line[data-annotation-key="${annotation.key}"]`);
    return {
      scale: application.pdfViewer.currentScale,
      cardWidth: c.width, cardHeight: c.height,
      widthRatio: c.width / page.clientWidth,
      heightRatio: c.height / page.clientHeight,
      x: (c.left - p.left) / page.clientWidth,
      y: (c.top - p.top) / page.clientHeight,
      top: card.style.top, left: column.style.left,
      transform: overlay.style.transform, points: lines?.getAttribute("points"),
      placement: column.dataset.placement,
      previewHeight: preview.offsetHeight,
      overflow: column.classList.contains("zmc-margin-overflow"),
      lowZoom: overlay.classList.contains("zmc-low-zoom"),
    };
  }
  async function zoom(scale) {
    application.pdfViewer.currentScale = scale;
    await pause(650);
    for (let i = 0; i < 50; i++) {
      if (Math.abs(adapter.page(1).scale - scale) < 0.001) break;
      await pause(30);
    }
    return snapshot();
  }
  async function screenshot(name) {
    adapter.centerCurrentPageHorizontally();
    await pause(120);
    const main = Zotero.getMainWindow();
    const image = await main.docShell.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "rgb(255,255,255)");
    const canvas = main.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = image.width; canvas.height = image.height;
    canvas.getContext("2d").drawImage(image, 0, 0);
    const bytes = Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]), (c) => c.charCodeAt(0));
    await IOUtils.write(PathUtils.join(root, name), bytes);
    image.close();
  }
  function stable(before, after) {
    for (const key of ["widthRatio", "heightRatio", "x", "y"]) {
      if (Math.abs(after[key] - before[key]) > 0.002) throw new Error(`Zoom changed ${key}: ${JSON.stringify({ before, after })}`);
    }
    for (const key of ["top", "left", "points", "placement", "previewHeight", "overflow"]) {
      if (after[key] !== before[key]) throw new Error(`Zoom changed normalized ${key}: ${JSON.stringify({ before, after })}`);
    }
    if (after.lowZoom || preview.innerHTML !== originalHTML) throw new Error("Zoom changed preview contents");
  }
  result.zoom = [];
  for (const collapse of [false, true]) {
    session.setCollapseNotes(collapse);
    const baseline = await zoom(1);
    for (const scale of [0.5, 2, 1]) {
      const current = await zoom(scale);
      stable(baseline, current);
      result.zoom.push({ collapse, ...current });
      if (!collapse) await screenshot(`zoom-${scale * 100}.png`);
    }
  }

  // Import the actual settings markup and exercise its HTML controls in Gecko.
  const xml = await Zotero.File.getContentsAsync(PathUtils.join(root, "preferences.xhtml"));
  const mainWindow = Zotero.getMainWindow();
  const parsed = await mainWindow.MozXULElement.parseXULToFragment(xml);
  const pane = parsed.querySelector("#zotero-prefpane-margincomments");
  if (!pane) throw new Error(`Settings root missing: ${parsed.nodeName}, ${parsed.textContent}`);
  pane.removeAttribute("onload");
  pane.setAttribute("style", "display:none");
  mainWindow.document.documentElement.append(pane);
  const controller = new scope.MarginController();
  controller.sessions.set(reader, session);
  controller.registerPreferencePaneWindow(mainWindow);
  const slider = pane.querySelector('[data-zmc-setting="card-width-slider"]');
  const number = pane.querySelector('[data-zmc-setting="card-width"]');
  slider.value = "480";
  const input = mainWindow.document.createEvent("Event"); input.initEvent("input", true, false);
  slider.dispatchEvent(input);
  await pause(150);
  if (number.value !== "480" || controller.readCardWidthPreference() !== 480) throw new Error("Width slider did not persist or synchronize");
  const customBaseline = await zoom(1);
  const customHalf = await zoom(0.5);
  stable(customBaseline, customHalf);
  if (Math.abs(customBaseline.cardWidth - 480) > 1 || Math.abs(customHalf.cardWidth - 240) > 1) throw new Error("Custom width did not scale with PDF");
  const restoredController = new scope.MarginController();
  if (restoredController.readCardWidthPreference() !== 480) throw new Error("Width preference did not survive controller recreation");
  pane.querySelector('[data-zmc-setting="card-width-reset"]').click();
  if (number.value !== "360" || slider.value !== "360" || controller.readCardWidthPreference() !== 360) throw new Error("Width reset failed");
  result.widthSettings = { saved: 480, widthAt100: customBaseline.cardWidth, widthAt50: customHalf.cardWidth, reset: 360 };

  // Exercise fractional font preferences against Gecko and the live PDF DOM.
  const fontSlider = pane.querySelector('[data-zmc-setting="font-size-slider"]');
  const fontInput = pane.querySelector('[data-zmc-setting="font-size"]');
  const dispatchInput = (element) => {
    const event = mainWindow.document.createEvent("Event"); event.initEvent("input", true, false);
    element.dispatchEvent(event);
  };
  session.setCollapseNotes(false);
  await zoom(1);
  const originalHeight = card.getBoundingClientRect().height;
  fontSlider.value = "18.5";
  dispatchInput(fontSlider);
  await pause(100);
  const fontBaseline = snapshot();
  const computedFont = Number.parseFloat(win.getComputedStyle(card).fontSize);
  if (fontInput.value !== "18.5" || computedFont !== 18.5
    || controller.readFontSizePreference() !== 18.5
    || (new scope.MarginController()).readFontSizePreference() !== 18.5) {
    throw new Error("Font slider did not update, persist or restore fractional pixels");
  }
  if (fontBaseline.cardHeight <= originalHeight) throw new Error("Font change did not remeasure card height");
  const fontHalf = await zoom(0.5);
  stable(fontBaseline, fontHalf);
  const fontDouble = await zoom(2);
  stable(fontBaseline, fontDouble);
  await zoom(1);
  await screenshot("font-18.5.png");
  fontInput.value = "16";
  dispatchInput(fontInput);
  if (fontSlider.value !== "16" || Number.parseFloat(win.getComputedStyle(preview).fontSize) !== 16) {
    throw new Error("Font number input did not update preview");
  }
  pane.querySelector('[data-zmc-setting="font-size-reset"]').click();
  if (fontInput.value !== "12.5" || fontSlider.value !== "12.5"
    || controller.readFontSizePreference() !== 12.5
    || Number.parseFloat(win.getComputedStyle(card).fontSize) !== 12.5) {
    throw new Error("Font reset failed");
  }
  result.fontSettings = {
    saved: 18.5, computed: computedFont, originalHeight, customHeight: fontBaseline.cardHeight,
    sizeAt50: computedFont * 0.5, sizeAt200: computedFont * 2, reset: 12.5,
  };

  // Keep an actual DOM selection inside an unsaved draft during zoom.
  await zoom(1);
  preview.click();
  const editor = card.querySelector(".zmc-card-editor");
  editor.textContent = "缩放期间的未保存草稿";
  const draftInput = doc.createEvent("Event"); draftInput.initEvent("input", true, false);
  editor.dispatchEvent(draftInput);
  editor.focus();
  const range = doc.createRange(); range.setStart(editor.firstChild, 3); range.setEnd(editor.firstChild, 6);
  const selection = win.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  controller.setFontSize(20);
  if (Number.parseFloat(win.getComputedStyle(editor).fontSize) !== 20 || doc.activeElement !== editor
    || selection.anchorOffset !== 3 || selection.focusOffset !== 6) {
    throw new Error("Font change interrupted the editor or selection");
  }
  application.pdfViewer.currentScale = 0.5;
  await pause(160);
  const actual = snapshot();
  result.draftZoom = {
    focused: doc.activeElement === editor,
    text: editor.textContent, offset: selection.anchorOffset,
    endOffset: selection.focusOffset, fontSize: Number.parseFloat(win.getComputedStyle(editor).fontSize),
    scaled: Math.abs(actual.cardWidth - 180) < 1,
  };
  if (!result.draftZoom.focused || result.draftZoom.offset !== 3 || result.draftZoom.endOffset !== 6
    || result.draftZoom.fontSize !== 20 || !result.draftZoom.scaled || result.draftZoom.text !== "缩放期间的未保存草稿") {
    throw new Error(`Zoom interrupted draft: ${JSON.stringify(result.draftZoom)}`);
  }
  win.eval(`document.querySelector('.zmc-card-editor:not(.zmc-editor-hidden)').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true,cancelable:true}))`);
  pane.querySelector('[data-zmc-setting="font-size-reset"]').click();
  pane.remove();
  session.setCollapseNotes(false);
  await zoom(1);
}
