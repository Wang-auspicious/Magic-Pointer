<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import ThumbsUpIcon from '@lucide/svelte/icons/thumbs-up';
</script>

<Button variant="outline" class='pe-0'>
	<ThumbsUpIcon />
	Like
	<span
		class="relative ms-1 px-3 text-xs font-medium text-muted-foreground before:absolute before:inset-0 before:left-0 before:w-px before:bg-input"
	>
		86
	</span>
</Button>
