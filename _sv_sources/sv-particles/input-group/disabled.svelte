<script lang="ts">
	import * as InputGroup from "$lib/components/ui/input-group/index.js";
	import ArrowRightIcon from "@lucide/svelte/icons/arrow-right";
</script>

<InputGroup.Root class="max-w-3xs">
	<InputGroup.Input placeholder="Your best email" type="email" class='placeholder:text-sm' disabled/>
	<InputGroup.Addon align="inline-end">
		<InputGroup.Button variant="ghost" size="icon-xs">
			<ArrowRightIcon />
		</InputGroup.Button>
	</InputGroup.Addon>
</InputGroup.Root>
