# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "httpx",
# ]
# ///
"""
Download Ghost images and update markdown files.
Usage: uv run scripts/download-ghost-images.py
"""

import re
import os
import httpx
from pathlib import Path

GHOST_URL = "https://blog.wahdany.eu"
CONTENT_DIR = Path(__file__).parent.parent / "src" / "content" / "entries"
IMAGES_DIR = Path(__file__).parent.parent / "public" / "images" / "ghost"

def download_images():
    """Find all Ghost image URLs, download them, and update markdown files."""
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)

    # Pattern to match Ghost image URLs
    pattern = r'!\[([^\]]*)\]\(__GHOST_URL__(/content/images/[^)]+)\)'

    downloaded = 0
    updated_files = 0

    client = httpx.Client(follow_redirects=True, timeout=30.0)

    for md_file in CONTENT_DIR.rglob("*.md"):
        content = md_file.read_text(encoding='utf-8')

        if "__GHOST_URL__" not in content:
            continue

        matches = re.findall(pattern, content)
        if not matches:
            # Also check for plain URLs without alt text
            pattern2 = r'__GHOST_URL__(/content/images/[^\s\)]+)'
            matches2 = re.findall(pattern2, content)
            matches = [("", m) for m in matches2]

        new_content = content
        file_updated = False

        for alt_text, image_path in matches:
            # Download the image
            image_url = f"{GHOST_URL}{image_path}"
            local_path = IMAGES_DIR / image_path.replace("/content/images/", "").replace("/", "-")

            if not local_path.exists():
                print(f"Downloading: {image_url}")
                try:
                    response = client.get(image_url)
                    if response.status_code == 200:
                        local_path.write_bytes(response.content)
                        downloaded += 1
                        print(f"  -> {local_path}")
                    else:
                        print(f"  Failed: {response.status_code}")
                        continue
                except Exception as e:
                    print(f"  Error: {e}")
                    continue

            # Update the markdown
            old_url = f"__GHOST_URL__{image_path}"
            new_url = f"/images/ghost/{local_path.name}"
            new_content = new_content.replace(old_url, new_url)
            file_updated = True

        if file_updated:
            md_file.write_text(new_content, encoding='utf-8')
            updated_files += 1
            print(f"Updated: {md_file.name}")

    client.close()
    print(f"\nDone! Downloaded {downloaded} images, updated {updated_files} files")

if __name__ == "__main__":
    download_images()
