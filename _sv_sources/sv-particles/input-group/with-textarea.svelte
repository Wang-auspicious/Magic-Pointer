<script lang="ts">
	import PlusIcon from "@lucide/svelte/icons/plus";
	import ArrowUpIcon from "@lucide/svelte/icons/arrow-up";
	import { Button } from "$lib/components/ui/button";
	import * as InputGroup from "$lib/components/ui/input-group/index.js";
	import * as Menubar from "$lib/components/ui/menubar/index.js";
	import * as Tooltip from "$lib/components/ui/tooltip/index.js";
</script>

<InputGroup.Root class="max-w-sm">
	<InputGroup.Textarea placeholder="Ask, Search or Chat..." class="placeholder:text-sm" />
	<InputGroup.Addon align="block-end" class="">
		<Menubar.Root class="border-none p-0! shadow-none">
			<Menubar.Menu>
				<Menubar.Trigger class="border-none bg-transparent! p-0! shadow-none">
					<Tooltip.Provider>
						<Tooltip.Root delayDuration={0}>
							<Tooltip.Trigger class="border-none! bg-transparent! p-0!">
								<Button variant="ghost" size="icon-sm" class="z-50 rounded-full!">
									<PlusIcon />
								</Button>
							</Tooltip.Trigger>
							<Tooltip.Content>Add files and more</Tooltip.Content>
						</Tooltip.Root>
					</Tooltip.Provider>
				</Menubar.Trigger>
				<Menubar.Content>
					<Menubar.Item>Add photos & file</Menubar.Item>
					<Menubar.Item>Create image</Menubar.Item>
					<Menubar.Item>Thinking</Menubar.Item>
					<Menubar.Item>Deep research</Menubar.Item>
				</Menubar.Content>
			</Menubar.Menu>
		</Menubar.Root>
		<InputGroup.Text class="ml-auto text-xs">78% used</InputGroup.Text>
		<Tooltip.Provider>
			<Tooltip.Root delayDuration={0}>
				<Tooltip.Trigger class="border-none! bg-transparent! p-0!">
					<Button  size="icon-sm" class="z-50 rounded-full!">
						<ArrowUpIcon />
					</Button>
				</Tooltip.Trigger>
				<Tooltip.Content>Send</Tooltip.Content>
			</Tooltip.Root>
		</Tooltip.Provider>
	</InputGroup.Addon>
</InputGroup.Root>
