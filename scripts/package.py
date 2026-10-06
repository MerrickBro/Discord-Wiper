from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json

projectRoot = Path(__file__).resolve().parent.parent
extensionRoot = projectRoot / "extension"
manifest = json.loads((extensionRoot / "manifest.json").read_text(encoding="utf-8"))
outputDirectory = projectRoot / "dist"
outputDirectory.mkdir(exist_ok=True)
archivePath = outputDirectory / f"merrick-discord-wiper-{manifest['version']}.zip"
prefix = "merrick-discord-wiper"

with ZipFile(archivePath, "w", ZIP_DEFLATED) as archive:
    for sourcePath in sorted(extensionRoot.rglob("*")):
        if sourcePath.is_file():
            archive.write(sourcePath, f"{prefix}/{sourcePath.relative_to(extensionRoot).as_posix()}")
    archive.write(projectRoot / "README.md", f"{prefix}/README.md")
    archive.write(projectRoot / "LICENSE", f"{prefix}/LICENSE")
    for sourcePath in sorted((projectRoot / "docs").glob("*.md")):
        archive.write(sourcePath, f"{prefix}/docs/{sourcePath.name}")

with ZipFile(archivePath) as archive:
    assert archive.testzip() is None
    assert f"{prefix}/manifest.json" in archive.namelist()
    assert all(name.startswith(f"{prefix}/") and ".." not in name.split("/") for name in archive.namelist())

print(f"Packaged {archivePath.name} ({archivePath.stat().st_size:,} bytes)")
