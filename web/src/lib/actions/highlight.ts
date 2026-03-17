import { highlightCode } from '$lib/utils/highlighter';

/**
 * Svelte action: post-render syntax highlighting for code blocks.
 * Finds all <pre class="code-block-body"> elements and replaces their
 * content with Shiki-highlighted HTML.
 */
export function highlightAction(node: HTMLElement) {
	const codeBlocks = node.querySelectorAll('pre.code-block-body code');

	codeBlocks.forEach(async (block) => {
		const lang = (block.className.replace('language-', '') || 'text').trim();
		const code = block.textContent || '';
		if (!code.trim()) return;

		const highlighted = await highlightCode(code, lang);
		if (!highlighted) return;

		const wrapper = block.closest('pre.code-block-body') as HTMLElement | null;
		if (wrapper) {
			const temp = document.createElement('div');
			temp.innerHTML = highlighted;
			const shikiPre = temp.querySelector('pre') as HTMLElement | null;
			if (shikiPre) {
				wrapper.innerHTML = shikiPre.innerHTML;
				if (shikiPre.style.backgroundColor) {
					wrapper.style.backgroundColor = shikiPre.style.backgroundColor;
				}
			}
		}
	});
}
