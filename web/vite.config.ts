import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	server: {
		proxy: {
			// Proxy /guac to local Guacamole for development
			// In production, Azure Static Web Apps config routes to Azure Container Apps
			'/guac': {
				target: 'http://localhost:8080',
				changeOrigin: true,
				ws: true,
				rewrite: (path) => path.replace(/^\/guac/, '')
			}
		}
	}
});
