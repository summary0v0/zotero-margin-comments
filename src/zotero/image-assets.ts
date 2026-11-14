import { IMAGE_DIRECTORY, imageFormat, parseImageReference, referencedImages } from "../core/image-reference";

export interface ImportedImage {
  reference: string;
  name: string;
}

export interface ImageCleanupResult {
  deleted: string[];
  skipped?: "busy" | "closed" | "readonly" | "linked-directory";
}

/** Copy binary data without iterating a Gecko Xray-wrapped TypedArray. */
export function copyImageBytes(value: ArrayBuffer | Uint8Array): Uint8Array {
  const utils = (Zotero as any).getMainWindow?.()?.Components?.utils;
  return new Uint8Array(utils?.waiveXrays ? utils.waiveXrays(value) : value);
}

/** Files are scoped to the current PDF. No absolute/remote Markdown paths are loaded. */
export class ImageAssets {
  private static readonly holds = new Map<number, number>();
  private static readonly cleanups = new Map<number, Promise<ImageCleanupResult>>();
  private readonly pendingWrites = new Map<string, Promise<void>>();
  private readonly images = new Map<string, Promise<string>>();

  constructor(private readonly attachmentID: number) {}

  /** Shared across reader windows for the same PDF, including failed-save drafts. */
  holdCleanup(): () => void {
    const id = this.attachmentID;
    ImageAssets.holds.set(id, (ImageAssets.holds.get(id) ?? 0) + 1);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      const remaining = (ImageAssets.holds.get(id) ?? 1) - 1;
      if (remaining > 0) ImageAssets.holds.set(id, remaining);
      else ImageAssets.holds.delete(id);
    };
  }

  private host(): any {
    return (Zotero as any).getMainWindow();
  }

  private async context(write = false): Promise<{ key: string; directory: string; host: any }> {
    const attachment = (Zotero.Items as any).get(this.attachmentID);
    if (write && attachment?.isEditable?.() === false) throw new Error("此 PDF 为只读，无法插入图片");
    const key = String(attachment?.key ?? "");
    const path = await attachment?.getFilePathAsync?.();
    const host = this.host();
    if (!/^[A-Z0-9]{8}$/.test(key) || !path || !await host.IOUtils.exists(path)) {
      throw new Error("PDF 本地文件不存在，无法定位图片目录");
    }
    return { key, directory: host.PathUtils.parent(path), host };
  }

  async importBytes(bytes: Uint8Array, name = "粘贴图片"): Promise<ImportedImage> {
    const release = this.holdCleanup();
    try {
      // A delete already in flight must finish before an import reuses that file.
      await ImageAssets.cleanups.get(this.attachmentID)?.catch(() => undefined);
      return await this.writeImage(bytes, name);
    } finally { release(); }
  }

  private async writeImage(bytes: Uint8Array, name: string): Promise<ImportedImage> {
    bytes = copyImageBytes(bytes);
    const format = imageFormat(bytes);
    if (!format) throw new Error("请选择 PNG、JPEG 或 WebP 图片");
    const { key, directory, host } = await this.context(true);
    // Construct the input in the chrome window's realm for Gecko WebIDL calls.
    const buffer = host.Components?.utils?.cloneInto
      ? host.Components.utils.cloneInto(bytes, host) : bytes;
    const digest = await host.crypto.subtle.digest("SHA-256", buffer);
    const hash = Array.from(copyImageBytes(digest)).map((n) => n.toString(16).padStart(2, "0")).join("");
    const file = `${hash}.${format.extension}`;
    const folder = host.PathUtils.join(directory, IMAGE_DIRECTORY, key);
    const path = host.PathUtils.join(folder, file);
    let write = this.pendingWrites.get(path);
    if (!write) {
      write = (async () => {
        await host.IOUtils.makeDirectory(folder, { createAncestors: true, ignoreExisting: true });
        if (!await host.IOUtils.exists(path)) {
          await host.IOUtils.write(path, buffer, { tmpPath: `${path}.${host.crypto.randomUUID()}.tmp` });
        }
      })();
      this.pendingWrites.set(path, write);
    }
    try { await write; }
    finally { if (this.pendingWrites.get(path) === write) this.pendingWrites.delete(path); }
    this.images.delete(path);
    return { reference: `${IMAGE_DIRECTORY}/${key}/${file}`, name };
  }

  async importFile(path: string): Promise<ImportedImage> {
    const host = this.host();
    const bytes = await host.IOUtils.read(path);
    return this.importBytes(copyImageBytes(bytes), host.PathUtils.filename(path));
  }

  async pickFile(): Promise<string | undefined> {
    const host = this.host();
    const { FilePicker } = host.ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
    const picker = new FilePicker();
    picker.init(host, "插入批注图片", picker.modeOpen);
    picker.appendFilter("图片（PNG、JPEG、WebP）", "*.png; *.jpg; *.jpeg; *.webp");
    return await picker.show() === picker.returnOK ? picker.file : undefined;
  }

  /** Gecko can omit image items on a trusted paste in the PDF iframe. */
  readClipboardPNG(): Uint8Array | undefined {
    try {
      const host = this.host();
      const cc = host.Components.classes;
      const ci = host.Components.interfaces;
      const clipboard = cc["@mozilla.org/widget/clipboard;1"].getService(ci.nsIClipboard);
      const data = cc["@mozilla.org/widget/transferable;1"].createInstance(ci.nsITransferable);
      data.init(null);
      data.addDataFlavor("image/png");
      clipboard.getData(data, clipboard.kGlobalClipboard);
      const value: any = {};
      data.getTransferData("image/png", value);
      const stream = value.value.QueryInterface(ci.nsIInputStream);
      const reader = cc["@mozilla.org/binaryinputstream;1"].createInstance(ci.nsIBinaryInputStream);
      reader.setInputStream(stream);
      try { return new Uint8Array(reader.readByteArray(reader.available())); }
      finally { reader.close(); }
    } catch { return undefined; }
  }

  async load(reference: string): Promise<string> {
    const parsed = parseImageReference(reference);
    if (!parsed) throw new Error("不支持的图片引用");
    const { key, directory, host } = await this.context();
    if (parsed.key !== key) throw new Error("图片引用不属于当前 PDF");
    const path = host.PathUtils.join(directory, IMAGE_DIRECTORY, key, parsed.file);
    if (!await host.IOUtils.exists(path)) {
      this.images.delete(path);
      throw new Error("图片文件缺失");
    }
    let image = this.images.get(path);
    if (!image) {
      image = (async () => {
        const bytes = copyImageBytes(await host.IOUtils.read(path));
        const format = imageFormat(bytes);
        if (!format || !parsed.file.endsWith(`.${format.extension}`)) throw new Error("图片文件格式无效");
        let binary = "";
        for (let i = 0; i < bytes.length; i += 32768) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
        }
        return `data:${format.mime};base64,${host.btoa(binary)}`;
      })();
      this.images.set(path, image);
      void image.catch(() => { if (this.images.get(path) === image) this.images.delete(path); });
    }
    return image;
  }

  /** Requested once per PDF open, never on text edits, filtering or zoom. */
  async cleanupUnused(
    readComments: () => string[], isOpen: () => boolean = () => true,
  ): Promise<ImageCleanupResult> {
    const id = this.attachmentID;
    while (ImageAssets.cleanups.has(id)) {
      await ImageAssets.cleanups.get(id)!.catch(() => undefined);
    }
    const task = this.collectUnused(readComments, isOpen).finally(() => {
      if (ImageAssets.cleanups.get(id) === task) ImageAssets.cleanups.delete(id);
    });
    ImageAssets.cleanups.set(id, task);
    return task;
  }

  private async collectUnused(readComments: () => string[], isOpen: () => boolean): Promise<ImageCleanupResult> {
    const result: ImageCleanupResult = { deleted: [] };
    const blocked = () => {
      if (!isOpen()) result.skipped = "closed";
      else if (ImageAssets.holds.get(this.attachmentID)) result.skipped = "busy";
      return !!result.skipped;
    };
    if (blocked()) return result;
    const attachment = (Zotero.Items as any).get(this.attachmentID);
    if (attachment?.isEditable?.() === false) return { ...result, skipped: "readonly" };
    const { key, directory, host } = await this.context();
    // Fail closed: unavailable annotation data must never mean "zero references".
    referencedImages(readComments());
    const assets = host.PathUtils.join(directory, IMAGE_DIRECTORY);
    const folder = host.PathUtils.join(assets, key);
    if (!await host.IOUtils.exists(folder) || blocked()) return result;
    for (const dir of [assets, folder]) {
      if ((Zotero as any).File.pathToFile(dir).isSymlink()
        || (await host.IOUtils.stat(dir)).type !== "directory") {
        return { ...result, skipped: "linked-directory" };
      }
    }
    const children: string[] = await host.IOUtils.getChildren(folder);
    for (const path of children) {
      if (blocked()) break;
      // Do not recurse, touch another PDF's directory, or delete user/temp files.
      if (host.PathUtils.parent(path) !== folder) continue;
      const file = host.PathUtils.filename(path);
      const reference = `${IMAGE_DIRECTORY}/${key}/${file}`;
      if (!parseImageReference(reference) || (Zotero as any).File.pathToFile(path).isSymlink()) continue;
      if ((await host.IOUtils.stat(path)).type !== "regular") continue;
      // Read again immediately before each deletion: another annotation may
      // have started referencing this shared image since directory enumeration.
      if (blocked() || referencedImages(readComments()).has(reference)) continue;
      if (attachment.isEditable?.() === false) {
        result.skipped = "readonly";
        break;
      }
      await host.IOUtils.remove(path, { recursive: false, ignoreAbsent: true });
      this.images.delete(path);
      result.deleted.push(reference);
    }
    return result;
  }

  clear(): void { this.images.clear(); }
}
