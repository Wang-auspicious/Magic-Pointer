<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
</script>

<Button>
	Get Started
	<ArrowRightIcon class="transition-transform in-[[data-slot=button]:hover]:translate-x-0.5" />
</Button>
