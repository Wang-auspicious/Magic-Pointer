<script lang="ts">
	import * as InputGroup from "$lib/components/ui/input-group/index.js";
	import SearchIcon from "@lucide/svelte/icons/search";
</script>

<InputGroup.Root class="max-w-3xs">
	<InputGroup.Input
		placeholder="search..."
		type="search"
		class="placeholder:text-sm [input]:ps-0!"
	/>
	<InputGroup.Addon>
		<InputGroup.Text>i.cal.com/</InputGroup.Text>
	</InputGroup.Addon>
</InputGroup.Root>
