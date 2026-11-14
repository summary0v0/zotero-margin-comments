import { parseImageReference } from "../core/image-reference";
import type { ImageAssets } from "./image-assets";

export function renderAssetImage(
  doc: Document, assets: ImageAssets, reference: string, alt: string, changed: () => void,
): HTMLElement | undefined {
  if (!parseImageReference(reference)) return undefined;
  const root = doc.createElement("span");
  root.className = "zmc-inline-image";
  root.dataset.reference = reference;
  const image = doc.createElement("img");
  image.alt = alt;
  image.hidden = true;
  image.title = "点击放大图片";
  const message = doc.createElement("span");
  message.className = "zmc-image-message";
  message.textContent = "正在读取图片…";
  root.append(image, message);
  image.addEventListener("load", () => {
    image.hidden = false;
    message.hidden = true;
    changed();
  });
  image.addEventListener("error", () => {
    image.hidden = true;
    message.hidden = false;
    message.textContent = "图片无法显示";
    changed();
  });
  void assets.load(reference).then((url) => {
    if (root.contains(image)) image.src = url;
  }).catch((error) => {
    message.textContent = error?.message || "图片文件缺失";
    root.classList.add("zmc-image-missing");
    changed();
  });
  return root;
}

export function openImageLightbox(doc: Document, image: HTMLImageElement): () => void {
  const previous = doc.activeElement as HTMLElement | null;
  const overlay = doc.createElement("div");
  overlay.className = "zmc-image-lightbox";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "批注图片预览");
  const full = doc.createElement("img");
  full.src = image.src;
  full.alt = image.alt;
  const close = doc.createElement("button");
  close.type = "button";
  close.textContent = "关闭图片（Esc）";
  const cleanup = () => {
    overlay.remove();
    doc.removeEventListener("keydown", onKey, true);
    if (previous?.isConnected) previous.focus({ preventScroll: true });
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cleanup();
    }
  };
  close.addEventListener("click", cleanup);
  overlay.addEventListener("click", (event) => { if (event.target === overlay) cleanup(); });
  overlay.append(full, close);
  doc.body.append(overlay);
  doc.addEventListener("keydown", onKey, true);
  close.focus({ preventScroll: true });
  return cleanup;
}
