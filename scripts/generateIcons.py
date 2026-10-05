from pathlib import Path
from PIL import Image, ImageDraw

projectRoot = Path(__file__).resolve().parent.parent
iconDirectory = projectRoot / "extension" / "icons"
iconDirectory.mkdir(parents=True, exist_ok=True)

for iconSize in (16, 32, 48, 128):
    scale = 4
    canvasSize = iconSize * scale
    iconImage = Image.new("RGBA", (canvasSize, canvasSize), (0, 0, 0, 0))
    drawing = ImageDraw.Draw(iconImage)
    inset = canvasSize * 0.035
    drawing.rounded_rectangle((inset, inset, canvasSize - inset, canvasSize - inset), radius=canvasSize * 0.12, fill="#0f1316", outline="#46535b", width=max(1, round(canvasSize * 0.025)))
    points = [(canvasSize * x, canvasSize * y) for x, y in [(0.25, 0.72), (0.25, 0.28), (0.5, 0.53), (0.75, 0.28), (0.75, 0.72)]]
    drawing.line(points, fill="#b0e0ff", width=round(canvasSize * 0.07), joint="curve")
    drawing.line((canvasSize * 0.23, canvasSize * 0.83, canvasSize * 0.77, canvasSize * 0.83), fill="#b0ffe0", width=max(1, round(canvasSize * 0.025)))
    iconImage.resize((iconSize, iconSize), Image.Resampling.LANCZOS).save(iconDirectory / f"icon{iconSize}.png")

print("Generated four extension icon sizes.")
