<script lang="ts">
	import ImageIcon from "@lucide/svelte/icons/image";
	import PaperclipIcon from "@lucide/svelte/icons/paperclip";
	import { Button } from "$lib/components/ui/button";
	import * as InputGroup from "$lib/components/ui/input-group/index.js";
	import * as Tooltip from "$lib/components/ui/tooltip/index.js";
</script>

<InputGroup.Root class="max-w-sm">
	<InputGroup.Textarea placeholder="Ask, Search or Chat..." class="placeholder:text-sm" />
	<InputGroup.Addon align="block-end" class="justify-between">
		<Tooltip.Provider>
			<div class="flex items-center gap-1">
				<Tooltip.Root delayDuration={0}>
					<Tooltip.Trigger class="border-none! bg-transparent! p-0!">
						<Button variant="ghost" size="icon-sm" class="z-50 rounded-full!">
							<PaperclipIcon />
						</Button>
					</Tooltip.Trigger>
					<Tooltip.Content>Attach file</Tooltip.Content>
				</Tooltip.Root>
				<Tooltip.Root delayDuration={0}>
					<Tooltip.Trigger class="border-none! bg-transparent! p-0!">
						<Button variant="ghost" size="icon-sm" class="z-50 rounded-full!">
							<ImageIcon />
						</Button>
					</Tooltip.Trigger>
					<Tooltip.Content>Insert iamge</Tooltip.Content>
				</Tooltip.Root>
			</div>
		</Tooltip.Provider>

		<Button size="sm">Send</Button>
	</InputGroup.Addon>
</InputGroup.Root>
