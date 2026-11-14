import { createHash, webcrypto } from "node:crypto";
import { win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { referencedImages } from "../src/core/image-reference";
import { ImageAssets } from "../src/zotero/image-assets";

const folder = "C:\\论文\\margin-comments-assets\\ABCD1234";
const ref = (hash: string) => `margin-comments-assets/ABCD1234/${hash.repeat(64)}.png`;
const path = (hash: string) => win32.join(folder, `${hash.repeat(64)}.png`);
const png = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9YQAAAAASUVORK5CYII=", "base64"));

describe("opening-time image cleanup", () => {
  let entries: Map<string, { type: string; linked?: boolean; bytes?: Uint8Array }>;
  let io: any;
  let assets: ImageAssets;
  let attachment: any;

  beforeEach(() => {
    entries = new Map([
      ["C:\\论文\\paper.pdf", { type: "regular" }],
      [win32.dirname(folder), { type: "directory" }],
      [folder, { type: "directory" }],
      [path("a"), { type: "regular", bytes: png }],
      [path("b"), { type: "regular", bytes: png }],
    ]);
    attachment = { key: "ABCD1234", getFilePathAsync: async () => "C:\\论文\\paper.pdf", isEditable: () => true };
    io = {
      exists: vi.fn(async (file: string) => entries.has(file)),
      getChildren: vi.fn(async (dir: string) => [...entries.keys()].filter((file) => win32.dirname(file) === dir)),
      stat: vi.fn(async (file: string) => entries.get(file)),
      remove: vi.fn(async (file: string) => { entries.delete(file); }),
      makeDirectory: vi.fn(async () => undefined),
      write: vi.fn(async (file: string, bytes: Uint8Array) => { entries.set(file, { type: "regular", bytes }); }),
    };
    vi.stubGlobal("Zotero", {
      Items: { get: () => attachment },
      File: { pathToFile: (file: string) => ({ isSymlink: () => !!entries.get(file)?.linked }) },
      getMainWindow: () => ({
        IOUtils: io, PathUtils: { parent: win32.dirname, join: win32.join, filename: win32.basename },
        crypto: webcrypto,
      }),
    });
    assets = new ImageAssets(71);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("only deletes unreferenced generated images in this PDF's own directory", async () => {
    const extra = [
      [win32.join(folder, "README.txt"), { type: "regular" }],
      [path("c"), { type: "directory" }],
      [path("d"), { type: "regular", linked: true }],
      [path("e") + ".tmp", { type: "regular" }],
      [win32.join(win32.dirname(folder), "OTHER001", "f".repeat(64) + ".png"), { type: "regular" }],
    ] as const;
    for (const [file, info] of extra) entries.set(file, info);
    const result = await assets.cleanupUnused(() => [`![共享图片](${ref("a")})`, ref("a")]);
    expect(result.deleted).toEqual([ref("b")]);
    expect(io.remove).toHaveBeenCalledExactlyOnceWith(path("b"), { recursive: false, ignoreAbsent: true });
    expect(entries.has(path("a"))).toBe(true);
    for (const [file] of extra) expect(entries.has(file)).toBe(true);
  });

  it("keeps the file until the last shared reference is removed", async () => {
    let comments = [ref("a"), `第二条批注也引用 ${ref("a")}`];
    await assets.cleanupUnused(() => comments);
    comments = [comments[1]];
    expect((await assets.cleanupUnused(() => comments)).deleted).toEqual([]);
    expect(entries.has(path("a"))).toBe(true);
    comments = [];
    expect((await assets.cleanupUnused(() => comments)).deleted).toEqual([ref("a")]);
    expect(entries.has(path("a"))).toBe(false);
  });

  it("reads references again before deletion and aborts on incomplete annotation data", async () => {
    const updated = vi.fn().mockReturnValueOnce([]).mockReturnValue([ref("a"), ref("b")]);
    expect((await assets.cleanupUnused(updated)).deleted).toEqual([]);
    expect(io.remove).not.toHaveBeenCalled();
    await expect(assets.cleanupUnused(() => { throw new Error("批注尚未就绪"); })).rejects.toThrow("尚未就绪");
    expect(io.remove).not.toHaveBeenCalled();
    expect(referencedImages([`\`![代码中的引用](${ref("a")})\``]).has(ref("a"))).toBe(true);
    expect(() => referencedImages([undefined] as any)).toThrow("完整读取");
  });

  it("skips read-only, closed, symlinked and currently edited PDFs", async () => {
    const otherWindow = new ImageAssets(71);
    const release = otherWindow.holdCleanup();
    expect((await assets.cleanupUnused(() => [])).skipped).toBe("busy");
    release();
    expect((await assets.cleanupUnused(() => [], () => false)).skipped).toBe("closed");
    attachment.isEditable = () => false;
    expect((await assets.cleanupUnused(() => [])).skipped).toBe("readonly");
    attachment.isEditable = () => true;
    entries.get(win32.dirname(folder))!.linked = true;
    expect((await assets.cleanupUnused(() => [])).skipped).toBe("linked-directory");
    expect(io.remove).not.toHaveBeenCalled();
  });

  it("stops if editing begins while the directory is being scanned", async () => {
    let release!: () => void;
    const stat = io.stat.getMockImplementation();
    io.stat.mockImplementation(async (file: string) => {
      if (file === path("b")) release = assets.holdCleanup();
      return stat(file);
    });
    const result = await assets.cleanupUnused(() => [ref("a")]);
    release();
    expect(result.skipped).toBe("busy");
    expect(io.remove).not.toHaveBeenCalled();
  });

  it("waits for an already-started delete before reimporting the same image", async () => {
    const hash = createHash("sha256").update(png).digest("hex");
    const file = win32.join(folder, hash + ".png");
    entries.set(file, { type: "regular", bytes: png });
    let removing!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => { removing = resolve; });
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    io.remove.mockImplementation(async (target: string) => {
      if (target === file) { removing(); await gate; }
      entries.delete(target);
    });
    const cleanup = assets.cleanupUnused(() => []);
    await started;
    const reimport = new ImageAssets(71).importBytes(png);
    finish();
    await cleanup;
    const imported = await reimport;
    expect(imported.reference).toContain(hash);
    expect(entries.has(file)).toBe(true);
    expect(io.write).toHaveBeenCalledTimes(1);
  });
});
