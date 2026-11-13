/* Appended only to the isolated Zotero addon when --sides is requested. */
async function verifyMarginSides({ attachment, annotation, session, adapter, application, pdfPage, result }) {
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const doc = adapter.document();
  const [x0, y0, x1, y1] = pdfPage.view;
  const width = x1 - x0, height = y1 - y0;
  const created = [];
  for (let i = 0; i < 8; i++) {
    const y = y0 + height * (0.86 - i * 0.085);
    const rect = i < 6
      ? [x0 + width * 0.1, y, x0 + width * 0.9, y + 10]
      : i === 6 ? [x0 + width * 0.1, y, x0 + width * 0.4, y + 10]
        : [x0 + width * 0.6, y, x0 + width * 0.9, y + 10];
    const item = await Zotero.Annotations.saveFromJSON(attachment, {
      key: Zotero.DataObjectUtilities.generateKey(),
      type: i === 1 ? "underline" : "highlight", color: "#ffd400",
      text: "Isolated margin side regression", comment: `自动选侧验证 ${i + 1}`,
      pageLabel: "2", sortIndex: `00001|${String(200 + i).padStart(6, "0")}|00000`,
      position: { pageIndex: 1, rects: [rect] },
    });
    created.push(item);
  }
  await pause(200);
  await session.refresh(true);
  const readSides = () => {
    const sides = {};
    for (const item of created) {
      const card = doc.querySelector(`.zmc-card[data-annotation-key="${item.key}"]`);
      if (!card || card.classList.contains("zmc-filtered")) throw new Error("Expected visible test card");
      const side = card.classList.contains("zmc-card-left") ? "left" : "right";
      if (!card.closest(`.zmc-margin-column-${side}`)) throw new Error("Card and column sides disagree");
      sides[item.key] = side;
    }
    return sides;
  };
  const initial = readSides();
  const counts = { left: 0, right: 0 };
  for (const item of created.slice(0, 6)) counts[initial[item.key]]++;
  if (!counts.left || !counts.right) throw new Error("Centred text still uses only one margin");
  if (initial[created[6].key] !== "left" || initial[created[7].key] !== "right") {
    throw new Error("A definite column was reassigned");
  }
  const unchanged = () => {
    const current = readSides();
    if (JSON.stringify(current) !== JSON.stringify(initial)) throw new Error("Existing cards changed sides");
  };
  for (const scale of [0.5, 2, 1]) {
    application.pdfViewer.currentScale = scale;
    await pause(200);
    await session.refresh(true);
    unchanged();
  }
  const card = doc.querySelector(`.zmc-card[data-annotation-key="${created[0].key}"]`);
  card.querySelector(".zmc-card-preview").click();
  const editor = card.querySelector(".zmc-card-editor");
  editor.textContent = "编辑后仍保持左右分配";
  const inputEvent = doc.createEvent("Event");
  inputEvent.initEvent("input", true, false);
  editor.dispatchEvent(inputEvent);
  editor.blur();
  await pause(200);
  await session.refresh(true);
  unchanged();
  session.setEnabled(false);
  session.setEnabled(true);
  await pause(200);
  unchanged();
  application.pdfViewer.pagesRotation = 90;
  await pause(250);
  await session.refresh(true);
  application.pdfViewer.pagesRotation = 0;
  await pause(250);
  await session.refresh(true);
  unchanged();
  const extra = await Zotero.Annotations.saveFromJSON(attachment, {
    key: Zotero.DataObjectUtilities.generateKey(), type: "highlight", color: "#ffd400",
    text: "Inserted centred highlight", comment: "新增批注不搬动已有卡片",
    pageLabel: "2", sortIndex: "00001|000050|00000",
    position: { pageIndex: 1, rects: [[x0 + width * 0.1, y0 + height * 0.95, x0 + width * 0.9, y0 + height * 0.95 + 10]] },
  });
  await pause(200);
  await session.refresh(true);
  unchanged();
  const all = [annotation, ...created, extra];
  const total = { left: 0, right: 0 };
  for (const item of all) {
    const current = doc.querySelector(`.zmc-card[data-annotation-key="${item.key}"]`);
    if (!current || current.classList.contains("zmc-filtered")) throw new Error("Inserted card is missing");
    total[current.classList.contains("zmc-card-left") ? "left" : "right"]++;
  }
  if (Math.abs(total.left - total.right) > 1) throw new Error("New centred cards did not use the less occupied side");
  // A separate page has no previous cards: its first long selection should
  // prefer the right margin even when the comment itself is just two characters.
  const firstView = application.pdfViewer.getPageView(0);
  const [fx0, fy0, fx1, fy1] = firstView.viewport.viewBox;
  const firstLong = await Zotero.Annotations.saveFromJSON(attachment, {
    key: Zotero.DataObjectUtilities.generateKey(), type: "underline", color: "#ffd400",
    text: "First long selection prefers the right", comment: "短评",
    pageLabel: "1", sortIndex: "00000|000100|00000",
    position: { pageIndex: 0, rects: [[fx0 + (fx1 - fx0) * 0.349, fy0 + (fy1 - fy0) * 0.5, fx0 + (fx1 - fx0) * 0.649, fy0 + (fy1 - fy0) * 0.5 + 10]] },
  });
  await pause(200);
  await session.refresh(true);
  const firstCard = doc.querySelector(`.zmc-card[data-annotation-key="${firstLong.key}"]`);
  if (!firstCard?.classList.contains("zmc-card-right") || firstCard.classList.contains("zmc-filtered")) {
    throw new Error("The first long centred selection did not prefer the right margin");
  }
  result.marginSides = {
    centredSelections: counts, allCards: total,
    firstLongSelectionPrefersRight: true, firstSelectionWidthFraction: 0.3,
    definiteColumnsPreserved: true, zoomStable: true, editStable: true,
    hideShowStable: true, rotationRestoreStable: true, insertionStable: true,
  };
}
