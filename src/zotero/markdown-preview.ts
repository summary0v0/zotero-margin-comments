import MarkdownIt from "markdown-it";
import { renderStoredComment } from "./rich-text-editor";
import { mathPlugin, renderMath } from "./math-preview";
import { PreviewSourceMap } from "./preview-caret";

// Parse to tokens and construct a small DOM allowlist. Never insert the parser's
// HTML into Zotero's privileged reader document or fetch remote note images.
const markdown = new MarkdownIt({ html: true, breaks: true, linkify: false }).use(mathPlugin);
type Token = ReturnType<MarkdownIt["parse"]>[number];
export interface MarkdownPreviewOptions {
  image?: (reference: string, alt: string) => HTMLElement | undefined;
}
const BLOCK_TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li",
  "blockquote", "table", "thead", "tbody", "tr", "th", "td",
  "strong", "em", "s", "a",
]);
const ZOTERO_TAG = /^<(\/)?(b|i|sub|sup|strong|em|br)\s*(\/?)>$/i;

function renderTokens(root: HTMLElement, tokens: Token[], options: MarkdownPreviewOptions, source?: PreviewSourceMap): void {
  const doc = root.ownerDocument;
  const stack: HTMLElement[] = [root];
  for (const token of tokens) {
    const parent = stack.at(-1)!;
    source?.block(token.map, token.type === "inline");
    if (token.type === "inline") {
      renderTokens(parent, token.children ?? [], options, source);
    } else if (token.type === "math_inline" || token.type === "math_display") {
      const math = renderMath(doc, token.content, token.type === "math_display", token.meta.source);
      source?.atom(math, token.meta.source, token.markup.length);
      parent.append(math);
    } else if (token.type === "text") {
      const text = doc.createTextNode(token.content);
      source?.text(text);
      parent.append(text);
    } else if (token.type === "softbreak" || token.type === "hardbreak") {
      source?.consume("\n");
      parent.append(doc.createElement("br"));
    } else if (["code_inline", "code_block", "fence"].includes(token.type)) {
      if (token.type === "fence" && token.map) source?.block([token.map[0] + 1, token.map[1]]);
      if (token.type === "code_inline") source?.consume(token.markup);
      const code = doc.createElement("code");
      const text = doc.createTextNode(token.content);
      source?.text(text, true);
      code.append(text);
      if (token.type === "code_inline") source?.consume(token.markup);
      if (token.type === "code_inline") parent.append(code);
      else {
        const pre = doc.createElement("pre");
        pre.append(code);
        parent.append(pre);
      }
    } else if (token.type === "hr") {
      parent.append(doc.createElement("hr"));
    } else if (token.type === "image") {
      source?.consume("![");
      source?.consume(token.content);
      source?.endLink();
      const image = options.image?.(token.attrGet("src") ?? "", token.content || "图片");
      if (image) {
        parent.append(image);
        continue;
      }
      const alt = doc.createElement("span");
      alt.textContent = `[图片：${token.content || "图片"}]`;
      parent.append(alt);
    } else if (token.type === "html_inline") {
      const match = token.content.match(ZOTERO_TAG);
      if (!match) {
        const text = doc.createTextNode(token.content);
        source?.text(text, true);
        parent.append(text);
      } else if (match[1]) {
        source?.consume(token.content);
        if (stack.length > 1 && parent.localName === match[2].toLowerCase()) stack.pop();
      } else {
        source?.consume(token.content);
        const element = doc.createElement(match[2].toLowerCase());
        parent.append(element);
        if (element.localName !== "br" && !match[3]) stack.push(element);
      }
    } else if (token.type === "html_block") {
      // Retain Zotero's existing formatting tags; all other HTML stays text.
      const block = doc.createElement("div");
      renderStoredComment(block, token.content);
      const mapHtml = (node: Node) => {
        for (const child of Array.from(node.childNodes) as ChildNode[]) {
          if (child.nodeType === 3) source?.text(child as Text);
          else if (child.nodeType === 1) {
            const name = (child as Element).localName;
            source?.consume(`<${name}>`);
            mapHtml(child);
            source?.consume(`</${name}>`);
          }
        }
      };
      mapHtml(block);
      parent.append(block);
    } else if (token.nesting === 1 && BLOCK_TAGS.has(token.tag)) {
      if (token.tag === "a") source?.consume(token.markup === "autolink" ? "<" : "[");
      else if (["strong", "em", "s"].includes(token.tag)) source?.consume(token.markup);
      let tag = token.tag;
      const href = token.attrGet("href") ?? "";
      if (tag === "a" && !/^(https?:|mailto:|zotero:)/i.test(href)) tag = "span";
      const element = doc.createElement(tag);
      if (tag === "a") {
        element.setAttribute("href", href);
        element.setAttribute("rel", "noopener noreferrer");
        const title = token.attrGet("title");
        if (title) element.title = title;
      }
      if (tag === "ol") {
        const start = token.attrGet("start");
        if (start && /^\d+$/.test(start)) element.setAttribute("start", start);
      }
      if (tag === "th" || tag === "td") {
        const alignment = token.attrGet("style")?.match(/^text-align:(left|center|right)$/)?.[1];
        if (alignment) element.style.textAlign = alignment;
      }
      parent.append(element);
      stack.push(element);
    } else if (token.nesting === -1 && stack.length > 1) {
      if (token.tag === "a") {
        if (token.markup === "autolink") source?.consume(">");
        else source?.endLink();
      } else if (["strong", "em", "s"].includes(token.tag)) source?.consume(token.markup);
      stack.pop();
    }
  }
}

export function renderMarkdownComment(root: HTMLElement, value: string, options: MarkdownPreviewOptions = {}): void {
  root.replaceChildren();
  root.classList.add("zmc-markdown");
  renderTokens(root, markdown.parse(value, {}), options, new PreviewSourceMap(value, markdown.utils.unescapeAll));
}

/** Image-only preview below the source editor; code examples are not interpreted. */
export function renderCommentImages(root: HTMLElement, value: string, options: MarkdownPreviewOptions): void {
  root.replaceChildren();
  const visit = (tokens: Token[]) => {
    for (const token of tokens) {
      if (token.type === "image") {
        const image = options.image?.(token.attrGet("src") ?? "", token.content || "图片");
        if (image) root.append(image);
      } else if (token.children) visit(token.children);
    }
  };
  visit(markdown.parse(value, {}));
}
