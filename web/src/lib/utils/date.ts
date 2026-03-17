export function formatRelativeTime(dateString: string): string {
	const date = new Date(dateString);
	const now = new Date();
	const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

	if (diffInSeconds < 60) return 'Just now';

	const diffInMinutes = Math.floor(diffInSeconds / 60);
	if (diffInMinutes < 60) return `${diffInMinutes}m ago`;

	const diffInHours = Math.floor(diffInMinutes / 60);
	if (diffInHours < 24) return `${diffInHours}h ago`;

	const yesterday = new Date(now);
	yesterday.setDate(now.getDate() - 1);
	if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';

	return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
