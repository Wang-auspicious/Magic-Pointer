from pathlib import Path

from PIL import Image

from app.visual_annotation import make_pointer_annotated_image


def test_locator_annotation_marks_target_and_component_boxes_without_covering_the_source(tmp_path: Path) -> None:
    raw = tmp_path / "raw.png"
    annotated = tmp_path / "annotated.png"
    Image.new("RGB", (800, 500), "white").save(raw)

    make_pointer_annotated_image(
        raw,
        annotated,
        (100, 200, 900, 700),
        [(300, 360), (450, 390), (520, 420)],
        style="locator",
        element_rectangles=[[280, 330, 260, 54]],
    )

    with Image.open(raw).convert("RGB") as source:
        assert source.getpixel((350, 190)) == (255, 255, 255)
    with Image.open(annotated).convert("RGB") as result:
        assert result.getpixel((180, 130)) != (255, 255, 255)
