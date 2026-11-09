import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMarkdownComment } from "../src/zotero/markdown-preview";
import { readStoredComment, renderStoredComment } from "../src/zotero/rich-text-editor";

function preview(source: string): HTMLElement {
  const root = document.createElement("div");
  renderMarkdownComment(root, source);
  return root;
}

describe("math in Markdown comments", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    [String.raw`相似度 $M_{ij}=\operatorname{sim}(s_i,g_j)$。`, false],
    [String.raw`相似度 \(M_{ij}=\operatorname{sim}(s_i,g_j)\)。`, false],
    [String.raw`$$M_{ij}=\operatorname{sim}(s_i,g_j)$$`, true],
    ["$$\nM_{ij}=\\operatorname{sim}(s_i,g_j)\n$$", true],
    [String.raw`\[M_{ij}=\operatorname{sim}(s_i,g_j)\]`, true],
    ["\\[\nM_{ij}=\\operatorname{sim}(s_i,g_j)\n\\]", true],
  ])("renders supported delimiters: %s", (source, display) => {
    const root = preview(source);
    const math = root.querySelector("math")!;
    expect(math).not.toBeNull();
    expect(math.namespaceURI).toBe("http://www.w3.org/1998/Math/MathML");
    expect(math.querySelector("msub")).not.toBeNull();
    expect(math.querySelector("annotation")?.textContent).toContain(String.raw`\operatorname{sim}`);
    expect(root.querySelector(".zmc-math-display") !== null).toBe(display);
    expect(math.getAttribute("display")).toBe(display ? "block" : null);
    expect(root.querySelector(".zmc-math-error")).toBeNull();
  });

  it("renders the screenshot's fractions, text subscripts and overline without Markdown consuming them", () => {
    const root = preview(String.raw`### 评估指标
① **Precision（精确率）**
$$
P=\frac{N_{\text{matched-pred}}}{N_{\text{pred}}}
\cdot\overline{\operatorname{sim}}\cdot L_f
$$
其中：
- $N_{\text{pred}}$：模型预测的动作总数。
`);
    expect(root.querySelector("h3")?.textContent).toBe("评估指标");
    expect(root.querySelectorAll("math")).toHaveLength(2);
    expect(root.querySelector("mfrac")).not.toBeNull();
    expect(root.querySelector("mover")).not.toBeNull();
    expect(root.querySelector("mtext")?.textContent).toBe("matched-pred");
    expect(root.querySelector("li math msub")).not.toBeNull();
    expect(root.querySelector(".zmc-math-error")).toBeNull();
  });

  it.each([
    [String.raw`\overline{\operatorname{sim}}`, "mover", "‾"],
    [String.raw`\hat{\operatorname{sim}}`, "mover", "^"],
    [String.raw`\widehat{\operatorname{sim}}`, "mover", "^"],
    [String.raw`\bar{\operatorname{sim}}`, "mover", "ˉ"],
    [String.raw`\overline{\sin}`, "mover", "‾"],
    [String.raw`\underline{\operatorname{sim}}`, "munder", "‾"],
    [String.raw`\overbrace{\operatorname{sim}}`, "mover", "⏞"],
  ])("keeps operator names as one accent base: %s", (tex, tag, accent) => {
    const source = `$$${tex}$$`;
    const root = preview(source);
    const node = root.querySelector(tag)!;
    expect(node.children).toHaveLength(2);
    expect(node.children[0].localName).toBe("mrow");
    expect(node.children[0].children[0].localName).toBe("mi");
    expect(node.children[0].children[1].textContent).toBe("\u2061");
    expect(node.children[1].localName).toBe("mo");
    expect(node.children[1].textContent).toBe(accent);
    expect(root.querySelector("annotation")?.textContent).toBe(tex);
    const editor = document.createElement("div");
    renderStoredComment(editor, source);
    expect(readStoredComment(editor)).toBe(source);
  });

  it("groups operator fragments in both fraction arguments and nested accents", () => {
    const root = preview(String.raw`$$\frac{\operatorname{sim}}{\operatorname{cos}}$$

$$\overline{\underline{\operatorname{sim}}}$$`);
    const fraction = root.querySelector("mfrac")!;
    expect(fraction.children).toHaveLength(2);
    expect(Array.from(fraction.children).map((child) => child.textContent)).toEqual(["sim\u2061", "cos\u2061"]);
    const over = root.querySelector("mover")!;
    expect(over.children).toHaveLength(2);
    expect(over.children[0].localName).toBe("munder");
    expect(over.children[0].children).toHaveLength(2);
    expect(over.children[0].children[0].localName).toBe("mrow");
  });

  it("preserves valid accent bases and ordinary function application", () => {
    const root = preview(String.raw`$$\hat{x}+\overline{xy}+\overline{\operatorname{sim}+\operatorname{cos}}$$

$\operatorname{sim}(x,y)$`);
    const accents = root.querySelectorAll<Element>("mover");
    expect(accents).toHaveLength(3);
    for (let index = 0; index < accents.length; index++) expect(accents[index].children).toHaveLength(2);
    expect(accents[0].children[0].localName).toBe("mi");
    expect(accents[1].children[0].localName).toBe("mrow");
    expect(accents[2].children[0].children).toHaveLength(5);
    const inline = root.querySelector(".zmc-math-inline mrow")!;
    expect(inline.children[0].localName).toBe("mi");
    expect(inline.children[1].textContent).toBe("\u2061");
  });

  it("supports aligned equations, matrices, comparisons, nested lists and quotes", () => {
    const root = preview(String.raw`- 主项
  - $a_i*b_j < c_k$

  $$
  \begin{aligned}
  x &= \frac{a}{b} \\
  y &= \sqrt{x^2+1}
  \end{aligned}
  $$

> \[
> \begin{pmatrix}a & b \\ c & d\end{pmatrix}
> \]

| 指标 | 定义 |
| --- | --- |
| 均值 | $\frac{a+b}{2}$ |
`);
    expect(root.querySelectorAll("math")).toHaveLength(4);
    expect(root.querySelectorAll("mtable")).toHaveLength(2);
    expect(root.querySelector("li li math")).not.toBeNull();
    expect(root.querySelector("blockquote math")).not.toBeNull();
    expect(root.querySelector("td math")).not.toBeNull();
    expect(root.querySelector("em")).toBeNull();
    expect(root.querySelector(".zmc-math-error")).toBeNull();
  });

  it("does not interpret code, escaped dollars, prices or unmatched delimiters as math", () => {
    const source = String.raw`\$5，价格 $10 和 $20。

未闭合 $x 和 $$y

单独的美元符号 $ 也保留。

~~~latex
$$x_i$$
\(y\)
~~~`;
    const root = preview("`$x_i$`\n\n" + source + "\n\n    $$indented$$");
    expect(root.querySelector("math")).toBeNull();
    expect(root.querySelector("code")?.textContent).toBe("$x_i$");
    expect(root.querySelector("pre code")?.textContent).toContain("$$x_i$$");
    expect(root.textContent).toContain("$5");
    expect(root.textContent).toContain("$10 和 $20");
    expect(root.textContent).toContain("未闭合 $x 和 $$y");
  });

  it("preserves adjacent formulas, escaped dollars in math and surrounding prose", () => {
    const root = preview(String.raw`前 $x$、\(y\) 后。行内价格 $\text{price: }\$5$。

$$\text{price: }\$5$$

结尾 **重点**`);
    expect(root.querySelectorAll("math")).toHaveLength(4);
    expect(root.textContent).toContain("前");
    expect(root.textContent).toContain("后。");
    expect(root.querySelector("strong")?.textContent).toBe("重点");
    expect(root.querySelector(".zmc-math-error")).toBeNull();
  });

  it.each([
    String.raw`$$\frac{1}{$$`,
    String.raw`$\unknowncommand{x}$`,
    String.raw`$$\def\a{\a}\a$$`,
    `$$${"x".repeat(16_385)}$$`,
  ])("falls back to the exact source and continues rendering on a bad formula", (formula) => {
    const root = preview(`前文\n\n${formula}\n\n**后文** $x^2$`);
    expect(root.querySelector(".zmc-math-error")?.textContent).toBe(formula);
    expect(root.querySelector("strong")?.textContent).toBe("后文");
    expect(root.querySelector("msup")).not.toBeNull();
  });

  it("cannot inject HTML, events, style, links or external resources through formulas", () => {
    const root = preview(String.raw`$\text{<img src=x onerror=alert(1)>}$

$$\href{javascript:alert(1)}{x}$$

$$\includegraphics{https://example.org/tracker.png}$$

$$\htmlStyle{background:url(https://example.org/tracker)}{x}$$

$\text{</annotation><script>alert(1)</script>}$`);
    expect(root.querySelectorAll("math").length).toBeGreaterThanOrEqual(2);
    expect(root.querySelector("img,script,iframe,style,a,annotation-xml")).toBeNull();
    expect(root.querySelector("[href],[src],[style],[onerror]")).toBeNull();
    expect(root.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(root.textContent).toContain("<script>alert(1)</script>");
  });

  it("works in another document without global DOM constructors and preserves editable source", () => {
    const source = String.raw`**公式** $x_i$，\(y^2\)
$$
\frac{N_{\text{pred}}}{2}
$$`;
    const editor = document.createElement("div");
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    try {
      const root = iframe.contentDocument!.createElement("div");
      vi.stubGlobal("Node", undefined);
      vi.stubGlobal("DOMParser", undefined);
      renderStoredComment(editor, source);
      renderMarkdownComment(root, source);
      expect(root.querySelectorAll("math")).toHaveLength(3);
      expect(root.querySelector(".zmc-math-error")).toBeNull();
      expect(root.querySelector("math")?.ownerDocument).toBe(iframe.contentDocument);
      expect(editor.querySelector("math")).toBeNull();
      expect(readStoredComment(editor)).toBe(source);
    } finally {
      iframe.remove();
    }
  });

  it("keeps macros local to a formula", () => {
    const root = preview(String.raw`$\gdef\foo{x}\foo$，$\foo$`);
    expect(root.querySelectorAll("math")).toHaveLength(1);
    expect(root.querySelector(".zmc-math-error")?.textContent).toBe(String.raw`$\foo$`);
  });
});
