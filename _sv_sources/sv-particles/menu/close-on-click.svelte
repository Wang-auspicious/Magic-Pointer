<script lang="ts">
	import { Button } from "$lib/components/ui/button";
	import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.js";
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="outline">Open Menu</Button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content class='min-w-40'>
		<DropdownMenu.Item>Close on Click</DropdownMenu.Item>
		<DropdownMenu.Item closeOnSelect={false}>I don't close on click</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.Root>
