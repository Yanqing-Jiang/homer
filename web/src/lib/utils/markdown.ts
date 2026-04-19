import { marked, type Tokens } from 'marked';
import DOMPurify from 'dompurify';

// Custom renderer for code blocks (language label + copy button) and tables (scroll wrapper)
const renderer = new marked.Renderer();

renderer.code = function ({ text, lang }: Tokens.Code) {
	const language = lang || 'text';
	const escaped = text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');

	return `<div class="code-block" data-language="${language}">
		<div class="code-block-header">
			<span class="code-block-lang">${language}</span>
			<button class="code-copy-btn" type="button">
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
					<path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
				</svg>
				Copy
			</button>
		</div>
		<pre class="code-block-body"><code class="language-${language}">${escaped}</code></pre>
	</div>`;
};

renderer.table = function ({ header, rows }: Tokens.Table) {
	const headerHtml = '<tr>' + header.map(cell => `<th${cell.align ? ` style="text-align:${cell.align}"` : ''}>${cell.text}</th>`).join('') + '</tr>';
	const bodyHtml = rows.map(row =>
		'<tr>' + row.map(cell => `<td${cell.align ? ` style="text-align:${cell.align}"` : ''}>${cell.text}</td>`).join('') + '</tr>'
	).join('');
	return `<div class="table-scroll-wrapper"><table><thead>${headerHtml}</thead><tbody>${bodyHtml}</tbody></table></div>`;
};

marked.use({ renderer });
marked.setOptions({ breaks: true, gfm: true });

// DOMPurify config — allow Shiki's inline styles (color only) and data attributes
const DOMPURIFY_CONFIG = {
	ALLOWED_TAGS: [
		'p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
		'strong', 'em', 'b', 'i', 'a', 'code', 'pre',
		'ul', 'ol', 'li', 'blockquote', 'img',
		'table', 'thead', 'tbody', 'tr', 'td', 'th',
		'hr', 'span', 'div', 'del', 'input', 'button', 'svg',
		'rect', 'path', 'figure', 'figcaption'
	],
	ALLOWED_ATTR: [
		'href', 'src', 'alt', 'class', 'target', 'rel', 'title',
		'type', 'checked', 'disabled', 'data-language', 'data-blob-link', 'download',
		'style', // For Shiki — sanitized via hook
		'viewBox', 'fill', 'stroke', 'stroke-width', 'width', 'height',
		'x', 'y', 'rx', 'ry', 'd'
	],
	ALLOW_DATA_ATTR: true
};

// Sanitize inline styles to only allow color-related properties (for Shiki)
DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
	if (data.attrName === 'style') {
		const allowed = data.attrValue
			.split(';')
			.map((s: string) => s.trim())
			.filter((s: string) => /^(color|font-style|font-weight|text-decoration|text-align)\s*:/.test(s))
			.join('; ');
		data.attrValue = allowed || '';
		if (!data.attrValue) data.keepAttr = false;
	}
});

// Rewrite private Azure Blob Storage URLs to the daemon's SAS-redirect endpoint
// so clicking a blob link in the chat actually downloads the file instead of 401-ing.
// Matches e.g. https://<account>.blob.core.windows.net/<container>/<path> — rewrites
// the <path> part through /api/blobs/download/:path.
const BLOB_URL_RE = /^https?:\/\/[a-z0-9]+\.blob\.core\.windows\.net\/[^/?#]+\/([^?#]+)(\?.*)?$/i;

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
	if (node.tagName === 'A') {
		const href = node.getAttribute('href');
		if (href) {
			const m = BLOB_URL_RE.exec(href);
			if (m && m[1]) {
				const blobPath = m[1];
				node.setAttribute('href', `/api/blobs/download/${blobPath}`);
				// Same-origin download — no need for target=_blank dance; let browser save dialog open
				node.setAttribute('download', '');
				node.setAttribute('data-blob-link', '1');
				return;
			}
		}
		node.setAttribute('target', '_blank');
		node.setAttribute('rel', 'noopener noreferrer');
	}
});

// LRU-style cache with max size
const MAX_CACHE_SIZE = 200;
const cache = new Map<string, string>();

export function renderMarkdown(content: string): string {
	const cached = cache.get(content);
	if (cached) return cached;

	const html = marked.parse(content) as string;
	const clean = DOMPurify.sanitize(html, DOMPURIFY_CONFIG) as string;

	if (cache.size >= MAX_CACHE_SIZE) {
		const firstKey = cache.keys().next().value;
		if (firstKey) cache.delete(firstKey);
	}
	cache.set(content, clean);
	return clean;
}

export function clearMarkdownCache(): void {
	cache.clear();
}

export function formatTime(date: Date): string {
	return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
