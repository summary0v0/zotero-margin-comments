import { webcrypto } from "node:crypto";
import { win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { imageFormat, imageMarkdown, parseImageReference } from "../src/core/image-reference";
import { ImageAssets } from "../src/zotero/image-assets";

const png = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9YQAAAAASUVORK5CYII=", "base64"));

describe("PDF-side image assets", () => {
  let path: string;
  let files: Map<string, Uint8Array>;
  let attachment: any;
  let io: any;
  let assets: ImageAssets;

  beforeEach(() => {
    path = "C:\\论文\\paper.pdf";
    files = new Map([[path, new Uint8Array([1])]]);
    attachment = { key: "ABCD1234", getFilePathAsync: async () => path, isEditable: () => true };
    io = {
      exists: vi.fn(async (file: string) => files.has(file)),
      makeDirectory: vi.fn(async () => undefined),
      read: vi.fn(async (file: string) => {
        if (!files.has(file)) throw new Error("missing");
        return files.get(file);
      }),
      write: vi.fn(async (file: string, bytes: Uint8Array) => { files.set(file, new Uint8Array(bytes)); }),
    };
    vi.stubGlobal("Zotero", {
      Items: { get: () => attachment },
      getMainWindow: () => ({
        IOUtils: io, PathUtils: { parent: win32.dirname, join: win32.join, filename: win32.basename },
        crypto: webcrypto, Uint8Array, btoa: (text: string) => Buffer.from(text, "binary").toString("base64"),
      }),
    });
    assets = new ImageAssets(1);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("writes beside the PDF, uses relative references and deduplicates concurrent imports", async () => {
    const [a, b] = await Promise.all([assets.importBytes(png, "截图.png"), assets.importBytes(png, "重复.png")]);
    expect(a.reference).toMatch(/^margin-comments-assets\/ABCD1234\/[a-f0-9]{64}\.png$/);
    expect(b.reference).toBe(a.reference);
    expect(io.write).toHaveBeenCalledTimes(1);
    const target = io.write.mock.calls[0][0];
    expect(target).toBe(win32.join("C:\\论文", a.reference));
    expect(io.write.mock.calls[0][2].tmpPath).toMatch(new RegExp("^[\\s\\S]+\\.[a-f0-9-]{36}\\.tmp$"));
    expect(io.write.mock.calls[0][2].tmpPath.startsWith(target + ".")).toBe(true);
    expect(await assets.load(a.reference)).toBe("data:image/png;base64," + Buffer.from(png).toString("base64"));
    expect(imageMarkdown(a.reference, "实验[截图]\n")).toContain("![实验 截图]");
    path = "C:\\论文\\renamed.pdf";
    files.set(path, new Uint8Array([1]));
    expect(await assets.load(a.reference)).toContain("data:image/png;base64,");
  });

  it("rejects unsupported formats, absolute paths, traversal and another PDF's key", async () => {
    await expect(assets.importBytes(new TextEncoder().encode("<svg></svg>"))).rejects.toThrow("PNG");
    for (const ref of ["file:///secret.png", "https://example.org/a.png", "../a.png", "margin-comments-assets/ABCD1234/../x.png", "margin-comments-assets/ABCD1234/%2e%2e/x.png"]) {
      expect(parseImageReference(ref)).toBeUndefined();
      await expect(assets.load(ref)).rejects.toThrow();
    }
    await expect(assets.load(`margin-comments-assets/OTHER001/${"a".repeat(64)}.png`)).rejects.toThrow("当前 PDF");
    expect(io.write).not.toHaveBeenCalled();
    expect(io.read).not.toHaveBeenCalled();
    expect(imageFormat(new Uint8Array([255, 216, 255, 0]))?.extension).toBe("jpg");
    expect(imageFormat(new TextEncoder().encode("RIFF0000WEBP"))?.extension).toBe("webp");
  });

  it("reports missing images even after a successful preview and retries after restore", async () => {
    const image = await assets.importBytes(png);
    await assets.load(image.reference);
    const target = io.write.mock.calls[0][0];
    files.delete(target);
    await expect(assets.load(image.reference)).rejects.toThrow("图片文件缺失");
    files.set(target, png);
    expect(await assets.load(image.reference)).toContain("data:image/png;base64,");
  });

  it("rejects read-only/missing PDFs and propagates disk write failure without a reference", async () => {
    attachment.isEditable = () => false;
    await expect(assets.importBytes(png)).rejects.toThrow("只读");
    attachment.isEditable = () => true;
    files.delete(path);
    await expect(assets.importBytes(png)).rejects.toThrow("本地文件不存在");
    files.set(path, png);
    io.write.mockRejectedValueOnce(new Error("目录不可写"));
    await expect(assets.importBytes(png)).rejects.toThrow("目录不可写");
    expect((await assets.importBytes(png)).reference).toContain("margin-comments-assets/");
  });
});
