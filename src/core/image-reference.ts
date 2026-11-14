export const IMAGE_DIRECTORY = "margin-comments-assets";

/** Keep references mentioned anywhere in the source, including code/partial Markdown. */
export function referencedImages(comments: readonly string[]): Set<string> {
  if (!Array.isArray(comments) || comments.some((comment) => typeof comment !== "string")) {
    throw new Error("无法完整读取批注，已跳过图片清理");
  }
  const references = new Set<string>();
  for (const comment of comments) {
    for (const match of comment.matchAll(/margin-comments-assets\/[A-Z0-9]{8}\/[a-f0-9]{64}\.(?:png|jpg|webp)(?![A-Za-z0-9_.])/g)) {
      references.add(match[0]);
    }
  }
  return references;
}

export function parseImageReference(reference: string): { key: string; file: string } | undefined {
  const match = reference.match(/^margin-comments-assets\/([A-Z0-9]{8})\/([a-f0-9]{64}\.(?:png|jpg|webp))$/);
  return match ? { key: match[1], file: match[2] } : undefined;
}

export function imageFormat(bytes: Uint8Array): { extension: string; mime: string } | undefined {
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)) {
    return { extension: "png", mime: "image/png" };
  }
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    return { extension: "jpg", mime: "image/jpeg" };
  }
  if (String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") {
    return { extension: "webp", mime: "image/webp" };
  }
  return undefined;
}

export function imageMarkdown(reference: string, alt: string): string {
  if (!parseImageReference(reference)) throw new Error("无效的图片引用");
  const label = alt.replace(/[\[\]\\\r\n]/g, " ").trim() || "图片";
  return `![${label}](${reference})`;
}
