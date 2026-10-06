// Agent Markdown → Telegram HTML (the subset Telegram renders).

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(line) {
  // Code spans first, so their content is not touched by the other rules.
  const codes = [];
  let s = line.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = esc(s)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/__(.+?)__/g, '<b>$1</b>')
    .replace(/(^|[^\w*])\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/(^|[^\w])_(?!\s)(.+?)(?<!\s)_(?!\w)/g, '$1<i>$2</i>')
    .replace(/~~(.+?)~~/g, '<s>$1</s>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[i])}</code>`);
}

/** Converts Markdown to Telegram HTML. */
export function toHtml(md) {
  const out = [];
  let fence = null;
  for (const line of md.split('\n')) {
    if (/^```/.test(line)) {
      if (fence) {
        out.push(`<pre>${esc(fence.join('\n'))}</pre>`);
        fence = null;
      } else fence = [];
      continue;
    }
    if (fence) {
      fence.push(line);
      continue;
    }
    const h = line.match(/^#{1,6}\s+(.*)/);
    if (h) out.push(`<b>${inline(h[1])}</b>`);
    else if (/^\s*[-*]\s+/.test(line)) out.push(line.replace(/^(\s*)[-*]\s+(.*)/, (_, sp, t) => `${sp}• ${inline(t)}`));
    else if (/^>\s?/.test(line)) out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`);
    else if (/^\s*([-*_])\1{2,}\s*$/.test(line)) out.push('');
    else out.push(inline(line));
  }
  if (fence) out.push(`<pre>${esc(fence.join('\n'))}</pre>`);
  return out.join('\n').replace(/<\/blockquote>\n<blockquote>/g, '\n');
}

/** Splits Markdown into chunks under `max` chars at paragraph, then line boundaries. */
export function chunks(md, max = 3500) {
  const parts = [];
  let cur = '';
  for (const para of md.split(/\n{2,}/)) {
    const pieces = para.length > max ? para.match(new RegExp(`[\\s\\S]{1,${max}}(?=\\n|$)|[\\s\\S]{1,${max}}`, 'g')) : [para];
    for (const p of pieces) {
      if (cur && cur.length + p.length + 2 > max) {
        parts.push(cur);
        cur = '';
      }
      cur = cur ? `${cur}\n\n${p}` : p;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}
