import type { Highlighter, BundledLanguage } from 'shiki';

let highlighterPromise: Promise<Highlighter> | null = null;

async function getHighlighter(): Promise<Highlighter> {
	if (!highlighterPromise) {
		highlighterPromise = import('shiki').then(({ createHighlighter }) =>
			createHighlighter({
				themes: ['github-dark'],
				langs: [
					'javascript', 'typescript', 'python', 'bash', 'shell',
					'json', 'yaml', 'html', 'css', 'sql', 'markdown',
					'svelte', 'jsx', 'tsx', 'go', 'rust', 'toml', 'xml'
				]
			})
		);
	}
	return highlighterPromise;
}

export async function highlightCode(code: string, lang: string): Promise<string> {
	try {
		const highlighter = await getHighlighter();
		const loaded = highlighter.getLoadedLanguages();
		const language = loaded.includes(lang as BundledLanguage) ? lang : 'text';

		return highlighter.codeToHtml(code, {
			lang: language as BundledLanguage,
			theme: 'github-dark'
		});
	} catch {
		return '';
	}
}
