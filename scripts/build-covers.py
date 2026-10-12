#!/usr/bin/env python3
"""Self-host book covers from the book-galaxy-data package.

Reads <data>/dist/books.json, converts each cover to a ~400px-wide WebP in
public/covers/, and writes data/covers.json (id -> file + credit) plus
public/covers/ATTRIBUTION.md. Remote-only covers are read from
.cache/covers-remote/<id>.jpg (fetched once from cover.imageUrl).
Also writes data/search-aliases.json (short alternate titles for search).
"""
import argparse, json, pathlib, re
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[1]
WIDTH = 400

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data', default='/workspace/book-galaxy-data')
    args = parser.parse_args()
    data = pathlib.Path(args.data)
    raw = json.loads((data / 'dist/books.json').read_text(encoding='utf-8'))
    books = raw['books'] if isinstance(raw, dict) else raw
    out = ROOT / 'public/covers'
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob('*.webp'):
        old.unlink()
    manifest, aliases, total, missing = {}, {}, 0, []
    for book in books:
        names = []
        for alias in [*(book.get('aliases') or []), book.get('originalTitle') or '']:
            alias = re.sub(r'\s*[（(][^）)]*[）)]\s*', '', alias or '').strip()
            if alias and alias != book['title'] and len(alias) <= 40 and alias not in names:
                names.append(alias)
        if names:
            aliases[book['id']] = names[:8]
        cover = book.get('cover')
        if not cover:
            continue
        source = data / cover['file'] if cover.get('file') else ROOT / '.cache/covers-remote' / f"{book['id']}.jpg"
        if not source.exists():
            missing.append(book['id'])
            continue
        image = Image.open(source).convert('RGB')
        if image.width > WIDTH:
            image = image.resize((WIDTH, round(image.height * WIDTH / image.width)), Image.LANCZOS)
        target = out / f"{book['id']}.webp"
        image.save(target, 'WEBP', quality=78, method=6)
        total += target.stat().st_size
        manifest[book['id']] = {
            'file': f"covers/{book['id']}.webp",
            'width': image.width,
            'height': image.height,
            'provider': cover.get('provider'),
            'sourceUrl': cover.get('sourceUrl'),
            'licenseClass': cover.get('licenseClass'),
        }
    (ROOT / 'data/covers.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    (ROOT / 'data/search-aliases.json').write_text(json.dumps(aliases, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    titles = {b['id']: b['title'] for b in books}
    providers = {
        'open-library': 'Open Library Covers API (https://openlibrary.org/dev/docs/api/covers). Cover art © its publisher/artist; shown for bibliographic identification.',
        'wikimedia-commons': 'Wikimedia Commons; licence per file page (free licence).',
        'wikipedia-infobox': 'Wikipedia infobox image; free or non-free (fair use) per file page.',
    }
    lines = ['# Cover credits', '', 'Covers are self-hosted copies (resized to 400px WebP) of images from the sources below.',
             'Each entry links to its source page, where the licence is stated. Rights holders may request removal via a repository issue.', '']
    for key, text in providers.items():
        lines.append(f'- **{key}**: {text}')
    lines += ['', '| id | title | provider | licence class | source |', '|---|---|---|---|---|']
    for book_id, entry in sorted(manifest.items()):
        lines.append(f"| {book_id} | {titles.get(book_id, '')} | {entry['provider']} | {entry['licenseClass']} | {entry['sourceUrl']} |")
    (out / 'ATTRIBUTION.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(json.dumps({'covers': len(manifest), 'missing': missing, 'totalMB': round(total / 1048576, 2), 'aliases': len(aliases)}))

if __name__ == '__main__':
    main()
