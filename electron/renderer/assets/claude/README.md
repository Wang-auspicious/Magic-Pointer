# Spark source

The thinking and writing frame strips are copied without redrawing from the locally installed Claude Desktop 2.110.0.0 asset `ion-dist/assets/v1/cf2613ee5-Btwr9m9F.js` (`animations.thinking.svg` and `animations.writing.svg`).

The matching `Spark` component in `shared-frame-C5qE0AlO.js` uses 9 and 8 frames respectively, 90 ms per frame, and `steps(frameCount, jump-none)` to move a clipped vertical strip. Magic Pointer uses the same frames and timing, with the SVG as a mask for the clay color. There is no rotational animation. The static mark comes from the existing locally scraped `spark.svg` in `claude_marks.ts`.

These user-requested reference assets are for the current local design comparison. The user intends to change the branding before publishing.
