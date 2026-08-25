<script lang="ts">
	import * as InputGroup from "$lib/components/ui/input-group/index.js";
	import { Toggle } from "$lib/components/ui/toggle";
	import BoldIcon from "@lucide/svelte/icons/bold";
	import ItalicIcon from "@lucide/svelte/icons/italic";
	import LinkIcon from "@lucide/svelte/icons/link";
</script>

<InputGroup.Root class="max-w-xs">
	<InputGroup.Textarea placeholder="Tell us about yourself...." class='text-sm' />
	<InputGroup.Addon
		align="block-start"
		class="gap-1 rounded-t-lg border-b px-2 bg-muted/20 py-1!"
	>
		<Toggle size="sm">
			<BoldIcon />
		</Toggle>
		<Toggle size="sm">
			<ItalicIcon />
		</Toggle>
		<Toggle size="sm">
			<LinkIcon />
		</Toggle>
	</InputGroup.Addon>
</InputGroup.Root>
