// Minimal Markdown renderer. It escapes all HTML first, so model output can
// never inject markup, then applies a fixed set of block and inline rules.

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inline(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noreferrer">$1</a>');
  return out;
}

/** Splits fenced code out before block parsing so its content stays literal. */
function extractFences(text) {
  const blocks = [];
  // The NUL sentinel keeps fenced code out of block parsing; it is intentional.
  const without = text.replace(/```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    blocks.push({ lang, code });
    return `\u0000FENCE${blocks.length - 1}\u0000`;
  });
  return { without, blocks };
}

function renderBlocks(text) {
  const lines = text.split("\n");
  const html = [];
  let list = null;

  const closeList = () => {
    if (list !== null) {
      html.push(`</${list}>`);
      list = null;
    }
  };

  for (const line of lines) {
    // eslint-disable-next-line no-control-regex
    const fence = line.match(/^\u0000FENCE(\d+)\u0000$/);
    if (fence) {
      closeList();
      html.push(fence);
      continue;
    }
    if (line.trim() === "") {
      closeList();
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^&gt;\s?/.test(line) || /^>\s?/.test(line)) {
      closeList();
      html.push(`<blockquote>${inline(line.replace(/^>\s?/, ""))}</blockquote>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      if (list !== "ul") {
        closeList();
        html.push("<ul>");
        list = "ul";
      }
      html.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (numbered) {
      if (list !== "ol") {
        closeList();
        html.push("<ol>");
        list = "ol";
      }
      html.push(`<li>${inline(numbered[1])}</li>`);
      continue;
    }
    closeList();
    html.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return html.join("");
}

export function renderMarkdown(text) {
  if (typeof text !== "string" || text === "") {
    return "";
  }
  const { without, blocks } = extractFences(text);
  // eslint-disable-next-line no-control-regex
  const html = renderBlocks(without).replace(/\u0000FENCE(\d+)\u0000/g, (_match, index) => {
    const block = blocks[Number(index)];
    if (block === undefined) return "";
    const lang = block.lang === "" ? "" : ` data-lang="${escapeHtml(block.lang)}"`;
    return `<pre${lang}><code>${escapeHtml(block.code.replace(/\n$/, ""))}</code></pre>`;
  });
  return html;
}
