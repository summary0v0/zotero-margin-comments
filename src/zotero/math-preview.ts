import type MarkdownIt from "markdown-it";
import katex from "katex";

const MATHML_NS = "http://www.w3.org/1998/Math/MathML";
const MATH_ARITY = new Map([
  ["mover", 2], ["munder", 2], ["munderover", 3],
  ["mfrac", 2], ["mroot", 2], ["msub", 2], ["msup", 2], ["msubsup", 3],
]);
const MATH_TAGS = new Set([
  "math", "semantics", "annotation", "mrow", "mi", "mn", "mo", "mtext",
  "mspace", "ms", "mfrac", "msqrt", "mroot", "msub", "msup", "msubsup",
  "munder", "mover", "munderover", "mtable", "mtr", "mtd", "mlabeledtr",
  "mstyle", "mpadded", "mphantom", "menclose", "mmultiscripts", "mprescripts", "none",
]);
const MATH_ATTRIBUTES = new Set([
  "display", "displaystyle", "scriptlevel", "mathvariant", "mathsize",
  "stretchy", "symmetric", "fence", "separator", "accent", "accentunder",
  "largeop", "movablelimits", "lspace", "rspace", "width", "height", "depth",
  "voffset", "linethickness", "minsize", "maxsize", "columnalign", "rowalign",
  "columnspacing", "rowspacing", "columnlines", "rowlines", "columnspan", "rowspan",
  "equalrows", "equalcolumns", "notation", "encoding",
]);

function escapedAt(source: string, index: number): boolean {
  let slashes = 0;
  while (index > 0 && source[--index] === "\\") slashes++;
  return slashes % 2 === 1;
}

function findClosing(source: string, closer: string, start: number): number {
  let index = source.indexOf(closer, start);
  while (index >= 0) {
    if (!escapedAt(source, index)) return index;
    index = source.indexOf(closer, index + closer.length);
  }
  return -1;
}

// Recognize math before Markdown consumes backslashes, underscores, asterisks
// or HTML-looking comparisons. Code tokens never pass through these rules.
export function mathPlugin(markdown: MarkdownIt): void {
  markdown.inline.ruler.before("escape", "zmc_math", (state, silent) => {
    const start = state.pos;
    const opener = ["$$", "\\(", "\\[", "$"].find((value) => state.src.startsWith(value, start));
    if (!opener) return false;
    const closer = opener === "\\(" ? "\\)" : opener === "\\[" ? "\\]" : opener;
    const contentStart = start + opener.length;
    if (opener === "$" && /\s|^$/.test(state.src[contentStart] ?? "")) return false;
    const end = findClosing(state.src, closer, contentStart);
    if (end < 0 || end >= state.posMax || end === contentStart) return false;
    const content = state.src.slice(contentStart, end);
    if (opener === "$" && (
      /\s$/.test(content) || content.includes("\n")
      || /\d/.test(state.src[end + 1] ?? "") || state.src[end + 1] === "$"
    )) return false;
    if (!silent) {
      const token = state.push(opener === "$$" || opener === "\\[" ? "math_display" : "math_inline", "math", 0);
      token.content = content;
      token.markup = opener;
      token.meta = { source: state.src.slice(start, end + closer.length) };
    }
    state.pos = end + closer.length;
    return true;
  });

  markdown.block.ruler.before("fence", "zmc_math_block", (state, startLine, endLine, silent) => {
    if (state.sCount[startLine] - state.blkIndent >= 4) return false;
    const first = state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[startLine]);
    const opener = first.startsWith("$$") ? "$$" : first.startsWith("\\[") ? "\\[" : undefined;
    if (!opener) return false;
    const closer = opener === "$$" ? "$$" : "\\]";
    const lines = [first.slice(opener.length)];
    let line = startLine;
    let end = findClosing(lines[0], closer, 0);
    while (end < 0 && line + 1 < endLine) {
      line++;
      if (!state.isEmpty(line) && state.sCount[line] < state.blkIndent) return false;
      const text = state.getLines(line, line + 1, state.blkIndent, false);
      lines.push(text);
      end = findClosing(text, closer, 0);
    }
    if (end < 0 || lines.at(-1)!.slice(end + closer.length).trim()) return false;
    if (silent) return true;
    const source = lines.join("\n");
    const token = state.push("math_display", "math", 0);
    token.block = true;
    token.content = source.slice(0, source.lastIndexOf(closer)).trim();
    token.markup = opener;
    token.meta = { source: opener + source };
    token.map = [startLine, line + 1];
    state.line = line + 1;
    return true;
  }, { alt: ["paragraph", "reference", "blockquote", "list"] });
}

// Copy only MathML nodes/attributes into the reader's document. No parser HTML,
// links, styles or event handlers are inserted into Zotero's privileged DOM.
function copyMathNode(node: Node, doc: Document): Node {
  if (node.nodeType === 3) return doc.createTextNode(node.nodeValue ?? "");
  const source = node as Element;
  if (node.nodeType !== 1 || !MATH_TAGS.has(source.localName)) throw new Error("Unexpected MathML node");
  const target = doc.createElementNS(MATHML_NS, source.localName);
  for (const attribute of Array.from(source.attributes)) {
    if (MATH_ATTRIBUTES.has(attribute.name)) target.setAttribute(attribute.name, attribute.value);
    if ((attribute.name === "mathcolor" || attribute.name === "mathbackground")
      && /^(#[\da-f]{3,8}|[a-z]+)$/i.test(attribute.value)) {
      target.setAttribute(attribute.name, attribute.value);
    }
  }
  for (const child of Array.from(node.childNodes) as ChildNode[]) target.appendChild(copyMathNode(child, doc));
  // KaTeX 0.19 emits operator names as a fragment: <mi>sim</mi><mo>U+2061</mo>.
  // Inside a fixed-arity node (e.g. mover) this becomes an extra argument, so
  // native MathML lays the accent beside the base. Restore the operator group
  // only where that fragment overflows the required number of arguments.
  const arity = MATH_ARITY.get(target.localName);
  if (arity && target.children.length > arity) {
    for (const child of Array.from(target.children)) {
      if (target.children.length === arity) break;
      const operator = child.nextElementSibling;
      if (child.localName !== "mi" || operator?.localName !== "mo"
        || operator.textContent !== "\u2061") continue;
      const row = doc.createElementNS(MATHML_NS, "mrow");
      target.insertBefore(row, child);
      row.append(child, operator);
    }
  }
  return target;
}

export function renderMath(doc: Document, content: string, display: boolean, source: string): HTMLElement {
  const wrapper = doc.createElement("span");
  wrapper.className = display ? "zmc-math zmc-math-display" : "zmc-math zmc-math-inline";
  try {
    if (content.length > 16_384) throw new Error("Formula too long");
    const markup = katex.renderToString(content, {
      output: "mathml", displayMode: display, throwOnError: true,
      trust: false, strict: "ignore", maxSize: 20, maxExpand: 1000,
    });
    // Use the reader's DOMParser, not a global DOM constructor: bootstrap
    // scripts run in a Zotero sandbox without the usual browser globals.
    const Parser = doc.defaultView?.DOMParser;
    if (!Parser) throw new Error("DOMParser unavailable");
    const parsed = new Parser().parseFromString(markup, "text/html");
    const math = parsed.querySelector("math");
    if (!math) throw new Error("MathML unavailable");
    wrapper.append(copyMathNode(math, doc));
  } catch {
    wrapper.classList.add("zmc-math-error");
    wrapper.textContent = source;
    wrapper.title = "公式暂时无法渲染，点击卡片可编辑 LaTeX 原文";
  }
  return wrapper;
}
