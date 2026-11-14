import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMarkdownComment } from "../src/zotero/markdown-preview";
import { readStoredComment, renderStoredComment } from "../src/zotero/rich-text-editor";
import { renderAssetImage } from "../src/zotero/image-preview";
import { ImageAssets } from "../src/zotero/image-assets";

describe("Markdown comment preview", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders the Chinese research note's headings, lists and bold text", () => {
    const root = document.createElement("div");
    renderMarkdownComment(root, "## Video VLM 相关研究方向\n\n### 1. 视觉编码与 Token 优化\n- **VideoLLaMA3**：动态分辨率\n- **InternVL 2.5**：Pixel Unshuffle");
    expect(root.querySelector("h2")?.textContent).toBe("Video VLM 相关研究方向");
    expect(root.querySelector("h3")?.textContent).toBe("1. 视觉编码与 Token 优化");
    expect(root.querySelectorAll("li")).toHaveLength(2);
    expect(root.querySelector("strong")?.textContent).toBe("VideoLLaMA3");
    expect(root.textContent).not.toContain("**");
  });

  it("supports nested lists, quotes, code, tables, links and Zotero tags", () => {
    const root = document.createElement("div");
    renderMarkdownComment(root, "3. 主项\n   - *子项*\n\n> 引用\n\n`<b>代码</b>`\n\n```ts\nconst x = 1;\n```\n\n| 名称 | 数值 |\n| --- | ---: |\n| 测试 | 2 |\n\n[论文](https://example.org/paper)\n\n<b>粗体</b>、<i>斜体</i>、x<sub>1</sub><sup>2</sup>");
    expect(root.querySelector("ol")?.getAttribute("start")).toBe("3");
    expect(root.querySelector("ol ul em")?.textContent).toBe("子项");
    expect(root.querySelector("blockquote")?.textContent).toContain("引用");
    expect(root.querySelector("code")?.textContent).toBe("<b>代码</b>");
    expect(root.querySelector("code b")).toBeNull();
    expect(root.querySelector("pre code")?.textContent).toBe("const x = 1;\n");
    expect(root.querySelectorAll("th")).toHaveLength(2);
    expect(root.querySelector<HTMLElement>("td:last-child")?.style.textAlign).toBe("right");
    expect(root.querySelector("a")?.getAttribute("href")).toBe("https://example.org/paper");
    expect(root.querySelector("b")?.textContent).toBe("粗体");
    expect(root.querySelector("i")?.textContent).toBe("斜体");
    expect(root.querySelector("sub")?.textContent).toBe("1");
    expect(root.querySelector("sup")?.textContent).toBe("2");
  });

  it("does not create arbitrary HTML, executable links or remote images", () => {
    const root = document.createElement("div");
    renderMarkdownComment(root, '<script>alert(1)</script>\n\n<img src="https://example.org/track" onerror="alert(1)">\n\n[危险](javascript:alert(1))\n\n[本地](file:///secret)\n\n![说明](https://example.org/track)\n\n<a href="javascript:alert(1)">危险</a>');
    expect(root.querySelector("script,img,iframe,a,style")).toBeNull();
    expect(root.textContent).toContain("说明");
    expect(root.textContent).toContain("<script>");
    expect(root.querySelector("[onerror]")).toBeNull();
  });

  it("keeps Markdown source intact across editing and rendering without global Node", () => {
    vi.stubGlobal("Node", undefined);
    const source = "## 研究方向\n- **重点**\n\n`const a = 1`\n第二行";
    const editor = document.createElement("div");
    const preview = document.createElement("div");
    renderStoredComment(editor, source);
    renderMarkdownComment(preview, source);
    expect(readStoredComment(editor)).toBe(source);
    expect(editor.querySelector("h2")).toBeNull();
    expect(preview.querySelector("h2")?.textContent).toBe("研究方向");
  });

  it("only resolves controlled PDF-local references when image support is enabled", async () => {
    const root = document.createElement("div");
    const assets = new ImageAssets(1);
    const load = vi.spyOn(assets, "load").mockResolvedValue("data:image/png;base64,test");
    const ref = `margin-comments-assets/ABCD1234/${"a".repeat(64)}.png`;
    renderMarkdownComment(root,
      `![截图](${ref})\n\n![远程](https://example.org/a.png)\n\n![越界](../a.png)\n\n\`![代码](${ref})\``,
      { image: (reference, alt) => renderAssetImage(document, assets, reference, alt, () => {}) });
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith(ref);
    expect(root.querySelectorAll("img")).toHaveLength(1);
    expect(root.textContent).toContain("远程");
    expect(root.querySelector("code")?.textContent).toContain(ref);
  });
});
