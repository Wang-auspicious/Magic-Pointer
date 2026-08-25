<script lang="ts">
	import CopyIcon from '@lucide/svelte/icons/copy';
	import CheckIcon from '@lucide/svelte/icons/check';

	import { Button } from '$lib/components/ui/button';
	let copied: boolean = $state(false);

	let handleCopy = () => {
		navigator.clipboard.writeText('Text copied!');
		copied = true;
		setTimeout(() => (copied = false), 2000);
	};
</script>

<Button
	aria-label={copied ? 'Copied' : 'Copy to clipboard'}
	onclick={handleCopy}
	size="icon"
	variant="outline"
>
	{#if copied}
		<CheckIcon />
	{:else}
		<CopyIcon />
	{/if}
</Button>
