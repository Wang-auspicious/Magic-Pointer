<script lang="ts">
	import * as InputGroup from "$lib/components/ui/input-group/index.js";

	let value = $state("");
	let maxlength = 14;
</script>

<InputGroup.Root class="max-w-3xs">
	<InputGroup.Input placeholder="Search..." bind:value {maxlength} />
	<InputGroup.Addon align="inline-end">
		<InputGroup.Text class='text-xs tabular-nums'>{value.length}/{maxlength}</InputGroup.Text>
	</InputGroup.Addon>
</InputGroup.Root>
