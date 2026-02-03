<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { onAuthExpired } from '$lib/api/client';
	import { signOut } from '$lib/supabase';
	import ToastContainer from '$lib/components/ToastContainer.svelte';
	import { toast } from '$lib/stores/toasts.svelte';

	let { children } = $props();

	// Handle auth expiry globally
	onMount(() => {
		const unsubscribe = onAuthExpired(async () => {
			console.warn('Session expired, redirecting to login');
			toast.warning('Session expired. Please sign in again.');
			try {
				await signOut();
			} catch {
				// Ignore signout errors
			}
			goto('/login');
		});

		return unsubscribe;
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<ToastContainer />
{@render children()}
