<script lang="ts">
	import * as Table from "$lib/components/ui/table/index.js";

	const items = [
		{
			balance: "$1,250.00",
			email: "alex.t@company.com",
			id: "1",
			location: "San Francisco, US",
			name: "Alex Thompson",
			status: "Active",
		},
		{
			balance: "$600.00",
			email: "sarah.c@company.com",
			id: "2",
			location: "Singapore",
			name: "Sarah Chen",
			status: "Active",
		},
		{
			balance: "$650.00",
			email: "j.wilson@company.com",
			id: "3",
			location: "London, UK",
			name: "James Wilson",
			status: "Inactive",
		},
		{
			balance: "$0.00",
			email: "m.garcia@company.com",
			id: "4",
			location: "Madrid, Spain",
			name: "Maria Garcia",
			status: "Active",
		},
		{
			balance: "-$1,000.00",
			email: "d.kim@company.com",
			id: "5",
			location: "Seoul, KR",
			name: "David Kim",
			status: "Active",
		},
		{
			balance: "$1,500.00",
			email: "john.brown@company.com",
			id: "6",
			location: "New York, US",
			name: "John Brown",
			status: "Active",
		},
		{
			balance: "$200.00",
			email: "jane.doe@company.com",
			id: "7",
			location: "Paris, FR",
			name: "Jane Doe",
			status: "Inactive",
		},
		{
			balance: "$1,000.00",
			email: "peter.smith@company.com",
			id: "8",
			location: "Berlin, DE",
			name: "Peter Smith",
			status: "Active",
		},
		{
			balance: "$500.00",
			email: "olivia.lee@company.com",
			id: "9",
			location: "Tokyo, JP",
			name: "Olivia Lee",
			status: "Active",
		},
		{
			balance: "$300.00",
			email: "liam.chen@company.com",
			id: "10",
			location: "Shanghai, CN",
			name: "Liam Chen",
			status: "Inactive",
		},
		{
			balance: "$800.00",
			email: "ethan.kim@company.com",
			id: "11",
			location: "Busan, KR",
			name: "Ethan Kim",
			status: "Active",
		},
		{
			balance: "$1,200.00",
			email: "ava.brown@company.com",
			id: "12",
			location: "London, UK",
			name: "Ava Brown",
			status: "Active",
		},
		{
			balance: "$400.00",
			email: "lily.lee@company.com",
			id: "13",
			location: "Seoul, KR",
			name: "Lily Lee",
			status: "Active",
		},
		{
			balance: "$600.00",
			email: "noah.smith@company.com",
			id: "14",
			location: "New York, US",
			name: "Noah Smith",
			status: "Inactive",
		},
		{
			balance: "$1,800.00",
			email: "eve.chen@company.com",
			id: "15",
			location: "Taipei, TW",
			name: "Eve Chen",
			status: "Active",
		},
	];
</script>

<div class="mx-auto w-4xl py-10">
	<div class="[&>div]:max-h-96">
		<Table.Root
			class="border-separate border-spacing-0 [&_td]:border-border [&_tfoot_td]:border-t [&_th]:border-b [&_th]:border-border [&_tr]:border-none [&_tr:not(:last-child)_td]:border-b"
		>
			<Table.Header class="sticky top-0 z-10 bg-background/90 backdrop-blur-xs">
				<Table.Row class="hover:bg-transparent">
					<Table.Head>Name</Table.Head>
					<Table.Head>Email</Table.Head>
					<Table.Head>Location</Table.Head>
					<Table.Head>Status</Table.Head>
					<Table.Head class="text-right">Balance</Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each items as item}
					<Table.Row>
						<Table.Cell class="font-medium">{item.name}</Table.Cell>
						<Table.Cell>{item.email}</Table.Cell>
						<Table.Cell>{item.location}</Table.Cell>
						<Table.Cell>{item.status}</Table.Cell>
						<Table.Cell class="text-right">{item.balance}</Table.Cell>
					</Table.Row>
				{/each}
			</Table.Body>
			<!-- Add to make footer sticky: sticky bottom-0 z-10 backdrop-blur-xs -->
			<Table.Footer class="bg-transparent">
				<Table.Row class="hover:bg-transparent">
					<Table.Cell colspan={4}>Total</Table.Cell>
					<Table.Cell class="text-right">$2,500.00</Table.Cell>
				</Table.Row>
			</Table.Footer>
		</Table.Root>
	</div>
	<p class="mt-4 text-center text-sm text-muted-foreground">Table with Sticky Header</p>
</div>
