<script lang="ts">
	const models = ['Claude', 'ChatGPT', 'Gemini', 'Homer'];
	let selectedModel = $state('Claude');
</script>

<div class="min-h-screen bg-gradient-to-b from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800">
	<div class="container mx-auto px-4 py-16">
		<div class="text-center mb-12">
			<h1 class="text-4xl font-bold text-gray-900 dark:text-white mb-4">
				Homer AI Dashboard
			</h1>
			<p class="text-lg text-gray-600 dark:text-gray-300">
				Unified AI interface with Claude, ChatGPT, Gemini & Homer
			</p>
		</div>

		<div class="max-w-2xl mx-auto">
			<!-- Model Selector -->
			<div class="flex justify-center gap-2 mb-8">
				{#each models as model}
					<button
						class="px-4 py-2 rounded-lg font-medium transition-colors {selectedModel === model
							? 'bg-blue-600 text-white'
							: 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-600'}"
						onclick={() => (selectedModel = model)}
					>
						{model}
					</button>
				{/each}
			</div>

			<!-- Chat Container -->
			<div class="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6">
				<div class="h-64 flex items-center justify-center text-gray-400 dark:text-gray-500 border-2 border-dashed border-gray-200 dark:border-gray-700 rounded-lg mb-4">
					<div class="text-center">
						<p class="text-lg mb-2">Chat with {selectedModel}</p>
						<p class="text-sm">Authentication required</p>
					</div>
				</div>

				<!-- Input Area -->
				<div class="flex gap-2">
					<input
						type="text"
						placeholder="Type a message..."
						class="flex-1 px-4 py-3 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
						disabled
					/>
					<button
						class="px-6 py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50"
						disabled
					>
						Send
					</button>
				</div>
			</div>

			<!-- Status -->
			<div class="mt-8 text-center text-sm text-gray-500 dark:text-gray-400">
				<p>Backend: <a href="https://homer.jiangyanqing.com/health" target="_blank" class="text-blue-600 hover:underline">homer.jiangyanqing.com</a></p>
				<p class="mt-1">Status: Awaiting Supabase Auth configuration</p>
			</div>
		</div>
	</div>
</div>
