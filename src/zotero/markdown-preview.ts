import MarkdownIt from "markdown-it";
import { renderStoredComment } from "./rich-text-editor";
import { mathPlugin, renderMath } from "./math-preview";

// Parse to tokens and construct a small DOM allowlist. Never insert the parser's
// HTML into Zotero's privileged reader document or fetch remote note images.
const markdown = new MarkdownIt({ html: true, breaks: true, linkify: false }).use(mathPlugin);
type Token = ReturnType<MarkdownIt["parse"]>[number];
const BLOCK_TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li",
  "blockquote", "table", "thead", "tbody", "tr", "th", "td",
  "strong", "em", "s", "a",
]);
const ZOTERO_TAG = /^<(\/)?(b|i|sub|sup|strong|em|br)\s*(\/?)>$/i;

function renderTokens(root: HTMLElement, tokens: Token[]): void {
  const doc = root.ownerDocument;
  const stack: HTMLElement[] = [root];
  for (const token of tokens) {
    const parent = stack.at(-1)!;
    if (token.type === "inline") {
      renderTokens(parent, token.children ?? []);
    } else if (token.type === "math_inline" || token.type === "math_display") {
      parent.append(renderMath(doc, token.content, token.type === "math_display", token.meta.source));
    } else if (token.type === "text") {
      parent.append(doc.createTextNode(token.content));
    } else if (token.type === "softbreak" || token.type === "hardbreak") {
      parent.append(doc.createElement("br"));
    } else if (["code_inline", "code_block", "fence"].includes(token.type)) {
      const code = doc.createElement("code");
      code.textContent = token.content;
      if (token.type === "code_inline") parent.append(code);
      else {
        const pre = doc.createElement("pre");
        pre.append(code);
        parent.append(pre);
      }
    } else if (token.type === "hr") {
      parent.append(doc.createElement("hr"));
    } else if (token.type === "image") {
      const alt = doc.createElement("span");
      alt.textContent = `[图片：${token.content || "图片"}]`;
      parent.append(alt);
    } else if (token.type === "html_inline") {
      const match = token.content.match(ZOTERO_TAG);
      if (!match) {
        parent.append(doc.createTextNode(token.content));
      } else if (match[1]) {
        if (stack.length > 1 && parent.localName === match[2].toLowerCase()) stack.pop();
      } else {
        const element = doc.createElement(match[2].toLowerCase());
        parent.append(element);
        if (element.localName !== "br" && !match[3]) stack.push(element);
      }
    } else if (token.type === "html_block") {
      // Retain Zotero's existing formatting tags; all other HTML stays text.
      const block = doc.createElement("div");
      renderStoredComment(block, token.content);
      parent.append(block);
    } else if (token.nesting === 1 && BLOCK_TAGS.has(token.tag)) {
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
      stack.pop();
    }
  }
}

export function renderMarkdownComment(root: HTMLElement, value: string): void {
  root.replaceChildren();
  root.classList.add("zmc-markdown");
  renderTokens(root, markdown.parse(value, {}));
}
