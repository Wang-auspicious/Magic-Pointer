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
	<DropdownMenu.Content>
		<DropdownMenu.Item class='cursor-pointer'>
			{#snippet child({ props })}
				<a href="/" {...props}>Docs</a>
			{/snippet}
		</DropdownMenu.Item>
		<DropdownMenu.Item class='cursor-pointer'>
			{#snippet child({ props })}
				<a href="/particles" {...props}>Particles</a>
			{/snippet}
		</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.Root>
