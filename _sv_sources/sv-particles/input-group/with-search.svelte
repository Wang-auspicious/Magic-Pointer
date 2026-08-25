<script lang="ts">
	import * as InputGroup from "$lib/components/ui/input-group/index.js";
	import SearchIcon from "@lucide/svelte/icons/search";
</script>

<InputGroup.Root class="max-w-3xs">
	<InputGroup.Input placeholder="Search..." />
	<InputGroup.Addon>
    	<SearchIcon />
    </InputGroup.Addon>
</InputGroup.Root>