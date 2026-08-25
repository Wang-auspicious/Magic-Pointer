<script lang="ts">
	import * as InputGroup from "$lib/components/ui/input-group/index.js";
	import Kbd from "$lib/components/ui/kbd/kbd.svelte";
</script>

<InputGroup.Root class="max-w-3xs">
	<InputGroup.Input placeholder="Search..." type='search'/>
	<InputGroup.Addon align="inline-end">
		<Kbd>⌘K</Kbd>
	</InputGroup.Addon>
</InputGroup.Root>
