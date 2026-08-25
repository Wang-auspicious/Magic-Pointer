<script lang="ts">
	import MicIcon from "@lucide/svelte/icons/mic";
	import ArrowRightIcon from "@lucide/svelte/icons/arrow-right";
	import { Button } from "$lib/components/ui/button";
	import * as InputGroup from "$lib/components/ui/input-group/index.js";
	import * as Menubar from "$lib/components/ui/menubar/index.js";
	import * as Tooltip from "$lib/components/ui/tooltip/index.js";
</script>

<InputGroup.Root class="max-w-sm">
	<InputGroup.Textarea placeholder="Ask, Search or Chat..." class="placeholder:text-sm" />
	<InputGroup.Addon align="block-end" class="">
		<Tooltip.Provider>
			<Tooltip.Root delayDuration={0}>
				<Tooltip.Trigger class="border-none! bg-transparent! p-0!">
					<Button variant="ghost" size="icon-sm" class="z-50 rounded-full!">
						<MicIcon />
					</Button>
				</Tooltip.Trigger>
				<Tooltip.Content>Record voice message</Tooltip.Content>
			</Tooltip.Root>
		</Tooltip.Provider>

		<InputGroup.Text class="ml-auto text-xs font-normal">Press Enter to send</InputGroup.Text>
		<Tooltip.Provider>
			<Tooltip.Root delayDuration={0}>
				<Tooltip.Trigger class="border-none! bg-transparent! p-0!">
					<Button size="icon-sm" class="z-50 rounded-full!">
						<ArrowRightIcon />
					</Button>
				</Tooltip.Trigger>
				<Tooltip.Content>Send</Tooltip.Content>
			</Tooltip.Root>
		</Tooltip.Provider>
	</InputGroup.Addon>
</InputGroup.Root>
