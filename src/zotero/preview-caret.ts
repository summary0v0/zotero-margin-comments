import { editorText } from "./editor-indentation";

// Rendering and editing have different layouts. Keep source positions on the
// preview nodes instead of reusing screen coordinates after switching modes.
const positions = new WeakMap<Node, number[]>();
const atoms = new WeakMap<Node, number>();

export class PreviewSourceMap {
  private cursor = 0;
  private normalized = "";
  private offsets: number[] = [];
  private lines = [0];

  constructor(private source: string, unescape: (value: string) => string) {
    for (let i = 0; i < source.length;) {
      const rest = source.slice(i);
      const entity = rest.match(/^(?:\\[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]|&(?:#x[\da-f]+|#\d+|[a-z][\da-z]+);)/i)?.[0];
      const raw = entity ?? source[i];
      const value = entity ? unescape(raw) : raw;
      for (let j = 0; j < value.length; j++) this.offsets.push(i);
      this.normalized += value;
      i += raw.length;
    }
    this.offsets.push(source.length);
    for (let i = 0; i < source.length; i++) if (source[i] === "\n") this.lines.push(i + 1);
  }

  block(map: [number, number] | null, inline = false): void {
    if (!map) return;
    this.cursor = this.lines[map[0]] ?? this.source.length;
    if (inline) {
      // Skip heading, quote and list prefixes, which do not appear in the preview.
      const prefix = this.source.slice(this.cursor).match(/^(?:[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-+*][ \t]+|\d+[.)][ \t]+))*/)?.[0] ?? "";
      this.cursor += prefix.length;
    }
  }

  consume(value: string): void {
    if (!value) return;
    const index = this.source.indexOf(value, this.cursor);
    if (index >= 0) this.cursor = index + value.length;
  }

  text(node: Text, literal = false): void {
    const value = node.data;
    if (!value) return;
    if (literal) {
      const start = this.source.indexOf(value.replace(/\n$/, ""), this.cursor);
      if (start >= 0) {
        positions.set(node, Array.from({ length: value.length + 1 }, (_, i) => Math.min(start + i, this.source.length)));
        this.cursor = start + value.length;
        return;
      }
    }
    let from = this.offsets.findIndex((offset) => offset >= this.cursor);
    if (from < 0) from = this.normalized.length;
    const start = this.normalized.indexOf(value, from);
    if (start < 0) {
      atoms.set(node, this.cursor);
      return;
    }
    positions.set(node, this.offsets.slice(start, start + value.length + 1));
    this.cursor = this.offsets[start + value.length];
  }

  atom(node: Node, source: string, opener = 0): void {
    const start = this.source.indexOf(source, this.cursor);
    atoms.set(node, start < 0 ? this.cursor : start + opener);
    if (start >= 0) this.cursor = start + source.length;
  }

  endLink(): void {
    // Skip destinations/reference labels so later repeated text cannot match a URL.
    const rest = this.source.slice(this.cursor);
    const close = rest.match(/^\]\s*(\(|\[)/);
    if (!close) { this.consume("]"); return; }
    let depth = 1;
    const open = close[1], end = open === "(" ? ")" : "]";
    let i = this.cursor + close[0].length;
    for (; i < this.source.length; i++) {
      if (this.source[i] === "\\") { i++; continue; }
      if (this.source[i] === open) depth++;
      if (this.source[i] === end && --depth === 0) { i++; break; }
    }
    this.cursor = i;
  }
}

/** Exposed separately so mapping can be tested without browser hit testing. */
export function previewSourceOffset(root: HTMLElement, node: Node, offset: number): number | undefined {
  if (!root.contains(node)) return undefined;
  for (let current: Node | null = node; current && current !== root; current = current.parentNode) {
    const atom = atoms.get(current);
    if (atom !== undefined) return atom;
  }
  const mapped = positions.get(node);
  if (mapped) return mapped[Math.max(0, Math.min(offset, mapped.length - 1))];
  // Element boundaries (line ends, blank space) use the nearest mapped text.
  const first = (parent: Node, last = false): number | undefined => {
    const atom = atoms.get(parent);
    if (atom !== undefined) return atom;
    const map = positions.get(parent);
    if (map) return last ? map.at(-1) : map[0];
    const children = Array.from(parent.childNodes) as ChildNode[];
    for (const child of last ? children.reverse() : children) {
      const value = first(child, last);
      if (value !== undefined) return value;
    }
    return undefined;
  };
  return first(node.childNodes[offset] ?? node, offset >= node.childNodes.length);
}

export function clickedSourceOffset(root: HTMLElement, event: MouseEvent): number | undefined {
  for (let target = event.target as Node | null; target && target !== root; target = target.parentNode) {
    const atom = atoms.get(target);
    if (atom !== undefined) return atom;
  }
  const doc = root.ownerDocument as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = doc.caretPositionFromPoint?.(event.clientX, event.clientY);
  const range = position ? undefined : doc.caretRangeFromPoint?.(event.clientX, event.clientY);
  const node = position?.offsetNode ?? range?.startContainer;
  const offset = position?.offset ?? range?.startOffset ?? 0;
  const mapped = node && previewSourceOffset(root, node, offset);
  if (mapped !== undefined) return mapped;
  // MathML hit testing may report a node outside the formula. Its event target
  // still identifies the complete source expression.
  const target = event.target as Node | null;
  if (target === root) {
    const bounds = root.getBoundingClientRect();
    return previewSourceOffset(root, root, event.clientY > bounds.top + bounds.height / 2 ? root.childNodes.length : 0);
  }
  return target ? previewSourceOffset(root, target, 0) : undefined;
}

export function placeSourceCaret(editor: HTMLElement, source: string, offset: number): void {
  const visible = source.slice(0, offset).replace(/<\/?(?:b|i|sub|sup)>/gi, "").length;
  const { points } = editorText(editor);
  const point = points[Math.min(visible, points.length - 1)];
  const selection = editor.ownerDocument.defaultView?.getSelection();
  if (!selection) return;
  const range = editor.ownerDocument.createRange();
  range.setStart(point.node, point.offset);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  const scrollport = editor.closest<HTMLElement>(".zmc-margin-scrollport");
  if (scrollport) {
    const caret = range.getBoundingClientRect();
    const viewport = scrollport.getBoundingClientRect();
    if (caret.height && viewport.height) {
      if (caret.bottom > viewport.bottom) scrollport.scrollTop += caret.bottom - viewport.bottom + 4;
      else if (caret.top < viewport.top) scrollport.scrollTop -= viewport.top - caret.top + 4;
    }
  }
}
