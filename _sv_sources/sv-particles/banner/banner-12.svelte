<script lang="ts">
	import DownloadIcon from '@lucide/svelte/icons/download';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import { Button } from '$lib/components/ui/button';

	let isDownloading = $state(false);

	function handleDownload() {
		isDownloading = true;

		window.setTimeout(() => {
			isDownloading = false;
		}, 2000);
	}
</script>

<div class="w-full bg-muted px-4 py-3 md:py-2">
	<div class="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
		<p class="text-sm">
			<span class="font-medium">v2.1.0</span>
			<span class="mx-2 text-muted-foreground">&bull;</span>
			New features and improvements available
		</p>
		<Button
			class="min-w-24"
			disabled={isDownloading}
			onclick={handleDownload}
			size="sm"
			variant="outline"
		>
			{#if isDownloading}
				<LoaderCircleIcon aria-hidden="true" class="-ms-0.5 me-2 animate-spin" size={16} />
				Updating...
			{:else}
				<DownloadIcon aria-hidden="true" class="-ms-0.5" size={16} />
				Update now
			{/if}
		</Button>
	</div>
</div>
