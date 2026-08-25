<script lang="ts">
	import * as InputGroup from "$lib/components/ui/input-group/index.js";
	import SearchIcon from "@lucide/svelte/icons/search";
</script>

<InputGroup.Root>
	<InputGroup.Input placeholder="Search..." />
	<InputGroup.Addon>
    	<SearchIcon />
    </InputGroup.Addon>
    <InputGroup.Addon align="inline-end">
        <InputGroup.Button>Search</InputGroup.Button>
    </InputGroup.Addon>
</InputGroup.Root>