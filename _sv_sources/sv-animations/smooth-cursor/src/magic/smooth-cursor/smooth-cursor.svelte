<script lang="ts">
	import { onMount } from "svelte";
	import { motion, useSpring } from "motion-sv";
	import type { Snippet } from "svelte";

	interface Position {
		x: number;
		y: number;
	}

	interface SmoothCursorProps {
		cursor?: Snippet;
		springConfig?: {
			damping: number;
			stiffness: number;
			mass: number;
			restDelta: number;
		};
	}

	let {
		cursor,
		springConfig = {
			damping: 45,
			stiffness: 400,
			mass: 1,
			restDelta: 0.001,
		},
	}: SmoothCursorProps = $props();

	let isMoving = $state(false);
	let lastMousePos = $state<Position>({ x: 0, y: 0 });
	let velocity = $state<Position>({ x: 0, y: 0 });
	let lastUpdateTime = $state(Date.now());
	let previousAngle = $state(0);
	let accumulatedRotation = $state(0);

	let cursorX = $derived(useSpring(0, springConfig));
	let cursorY = $derived(useSpring(0, springConfig));
	let rotation = $derived(
		useSpring(0, {
			...springConfig,
			damping: 60,
			stiffness: 300,
		})
	);
	let scale = $derived(
		useSpring(1, {
			...springConfig,
			damping: 35,
			stiffness: 500,
		})
	);

	onMount(() => {
		const updateVelocity = (currentPos: Position) => {
			const currentTime = Date.now();
			const deltaTime = currentTime - lastUpdateTime;

			if (deltaTime > 0) {
				velocity = {
					x: (currentPos.x - lastMousePos.x) / deltaTime,
					y: (currentPos.y - lastMousePos.y) / deltaTime,
				};
			}

			lastUpdateTime = currentTime;
			lastMousePos = currentPos;
		};

		const smoothMouseMove = (e: MouseEvent) => {
			let currentPos: Position = { x: e.clientX, y: e.clientY };
			updateVelocity(currentPos);

			const speed = Math.sqrt(Math.pow(velocity.x, 2) + Math.pow(velocity.y, 2));

			cursorX.set(currentPos.x);
			cursorY.set(currentPos.y);

			if (speed > 0.1) {
				const currentAngle = Math.atan2(velocity.y, velocity.x) * (180 / Math.PI) + 90;

				let angleDiff = currentAngle - previousAngle;
				if (angleDiff > 180) angleDiff -= 360;
				if (angleDiff < -180) angleDiff += 360;
				accumulatedRotation += angleDiff;
				rotation.set(accumulatedRotation);
				previousAngle = currentAngle;

				scale.set(0.95);
				isMoving = true;

				const timeout = setTimeout(() => {
					scale.set(1);
					isMoving = false;
				}, 150);

				return () => clearTimeout(timeout);
			}
		};

		let rafId: number;
		const throttledMouseMove = (e: MouseEvent) => {
			if (rafId) return;

			rafId = requestAnimationFrame(() => {
				smoothMouseMove(e);
				rafId = 0;
			});
		};

		document.body.style.cursor = "none";
		window.addEventListener("mousemove", throttledMouseMove);

		return () => {
			window.removeEventListener("mousemove", throttledMouseMove);
			document.body.style.cursor = "auto";
			if (rafId) cancelAnimationFrame(rafId);
		};
	});
</script>

<motion.div
	style={{
		position: "fixed",
		left: cursorX,
		top: cursorY,
		translateX: "-50%",
		translateY: "-50%",
		rotate: rotation,
		scale: scale,
		zIndex: 100,
		pointerEvents: "none",
		willChange: "transform",
	}}
	initial={{ scale: 0 }}
	animate={{ scale: 1 }}
	transition={{
		type: "spring",
		stiffness: 400,
		damping: 30,
	}}
>
	{#if cursor}
		{@render cursor()}
	{:else}
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width={50}
			height={54}
			viewBox="0 0 50 54"
			fill="none"
			style="scale: 0.5"
		>
			<g filter="url(#filter0_d_91_7928)">
				<path
					d="M42.6817 41.1495L27.5103 6.79925C26.7269 5.02557 24.2082 5.02558 23.3927 6.79925L7.59814 41.1495C6.75833 42.9759 8.52712 44.8902 10.4125 44.1954L24.3757 39.0496C24.8829 38.8627 25.4385 38.8627 25.9422 39.0496L39.8121 44.1954C41.6849 44.8902 43.4884 42.9759 42.6817 41.1495Z"
					fill="black"
				/>
				<path
					d="M43.7146 40.6933L28.5431 6.34306C27.3556 3.65428 23.5772 3.69516 22.3668 6.32755L6.57226 40.6778C5.3134 43.4156 7.97238 46.298 10.803 45.2549L24.7662 40.109C25.0221 40.0147 25.2999 40.0156 25.5494 40.1082L39.4193 45.254C42.2261 46.2953 44.9254 43.4347 43.7146 40.6933Z"
					stroke="white"
					stroke-width={2.25825}
				/>
			</g>
			<defs>
				<filter
					id="filter0_d_91_7928"
					x={0.602397}
					y={0.952444}
					width={49.0584}
					height={52.428}
					filterUnits="userSpaceOnUse"
					color-interpolation-filters="sRGB"
				>
					<feFlood flood-opacity={0} result="BackgroundImageFix" />
					<feColorMatrix
						in="SourceAlpha"
						type="matrix"
						values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
						result="hardAlpha"
					/>
					<feOffset dy={2.25825} />
					<feGaussianBlur stdDeviation={2.25825} />
					<feComposite in2="hardAlpha" operator="out" />
					<feColorMatrix
						type="matrix"
						values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.08 0"
					/>
					<feBlend
						mode="normal"
						in2="BackgroundImageFix"
						result="effect1_dropShadow_91_7928"
					/>
					<feBlend
						mode="normal"
						in="SourceGraphic"
						in2="effect1_dropShadow_91_7928"
						result="shape"
					/>
				</filter>
			</defs>
		</svg>
	{/if}
</motion.div>
