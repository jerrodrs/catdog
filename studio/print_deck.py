"""Lossless, exact-size print PDFs with bounded parallel preparation and pages."""
import hashlib
import json
import os
import re
from pathlib import Path
import struct
import sys
import tempfile
import time
import zipfile
import zlib
from concurrent.futures import ProcessPoolExecutor

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from cardforge.color import to_srgb, is_srgb
from PIL import Image, ImageOps
from reportlab import rl_config
from reportlab.pdfbase.pdfdoc import PDFImageXObject
from reportlab.pdfgen import canvas
from reportlab.lib.units import mm

rl_config.useA85 = 0
# Prepared files contain a small header followed by a PDF-ready lossless stream.
HEADER = struct.Struct('!8sIIB')
MAGIC = b'CFPRINT1'
CACHE_VERSION = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def archive_pages(filename):
    """Locate stored PDF members for direct, bounded HTTP file streaming."""
    pages = []
    with zipfile.ZipFile(filename) as archive, open(filename, 'rb') as stream:
        for info in archive.infolist():
            match = re.fullmatch(r'page-(\d+)(?:-(?:front|back|calibration))?\.pdf', info.filename)
            if not match or info.compress_type != zipfile.ZIP_STORED or info.flag_bits & 1:
                raise ValueError('Unsupported print archive member')
            stream.seek(info.header_offset)
            header = stream.read(30)
            if header[:4] != b'PK\x03\x04':
                raise ValueError('Invalid ZIP local header')
            name_length, extra_length = struct.unpack_from('<HH', header, 26)
            offset = info.header_offset + 30 + name_length + extra_length
            if info.file_size < 4 or offset + info.file_size > archive.start_dir:
                raise ValueError('Invalid PDF member bounds')
            stream.seek(offset)
            if stream.read(4) != b'%PDF':
                raise ValueError('Print archive member is not a PDF')
            pages.append(dict(number=int(match[1]), name=info.filename, offset=offset, size=info.file_size))
    return pages


def memory_available():
    available = 512 * 1024**2
    try:
        for line in Path('/proc/meminfo').read_text().splitlines():
            if line.startswith('MemAvailable:'):
                available = int(line.split()[1]) * 1024
        limit = Path('/sys/fs/cgroup/memory.max').read_text().strip()
        if limit != 'max':
            available = min(available, int(limit) - int(Path('/sys/fs/cgroup/memory.current').read_text()))
    except (OSError, ValueError):
        pass
    return max(64 * 1024**2, available)


def worker_count(tasks, bytes_per_task):
    limit = min(4, os.cpu_count() or 1)
    try:
        limit = max(1, min(limit, int(os.environ.get('CARDFORGE_PRINT_WORKERS', limit))))
    except ValueError:
        pass
    budget = min(3 * 1024**3, memory_available() * .4)
    return max(1, min(limit, tasks, int(budget / max(1, bytes_per_task))))


def parallel_map(function, tasks, workers):
    if workers == 1:
        yield from map(function, tasks)
    else:
        with ProcessPoolExecutor(max_workers=workers) as pool:
            yield from pool.map(function, tasks)


def resource_info(filename):
    with open(filename, 'rb') as stream:
        magic, width, height, native = HEADER.unpack(stream.read(HEADER.size))
    if magic != MAGIC:
        raise ValueError('Invalid prepared print image')
    return dict(path=str(filename), width=width, height=height, native=bool(native))


def prepare_image(task):
    source, p, cache = task
    stat = Path(source).stat()
    settings = {key: p[key] for key in ('quality', 'card_width', 'card_height', 'bleed')}
    key = hashlib.sha256(json.dumps([CACHE_VERSION, str(Path(source).resolve()), stat.st_size,
                                    stat.st_mtime_ns, settings], sort_keys=True).encode()).hexdigest()
    filename = Path(cache) / (key + '.flate')
    if filename.exists():
        return source, resource_info(filename), True
    with Image.open(source) as raw:
        native = p['quality'] == 'full' and not p['bleed'] and raw.mode == 'RGB' and is_srgb(raw)
        if native:
            image = raw.copy()
        else:
            original = raw.copy() if is_srgb(raw) else to_srgb(raw)
            if original.mode == 'RGB':
                image = original
            else:
                original = original.convert('RGBA')
                image = Image.new('RGB', original.size, 'white')
                image.paste(original, mask=original.getchannel('A'))
            native_ppi = min(image.width / (p['card_width'] / 25.4), image.height / (p['card_height'] / 25.4))
            target = min(2400, native_ppi) if p['quality'] == 'full' else {'compact': 300, '600': 600, '1200': 1200}[p['quality']]
            width = round(p['card_width'] / 25.4 * target)
            height = round(p['card_height'] / 25.4 * target)
            image = ImageOps.pad(image, (width, height), method=Image.Resampling.LANCZOS, color='white')
            bx = by = round(p['bleed'] / 25.4 * target)
            if bx or by:
                extended = Image.new('RGB', (width + 2 * bx, height + 2 * by))
                extended.paste(image, (bx, by))
                if bx:
                    extended.paste(image.crop((0, 0, 1, height)).resize((bx, height)), (0, by))
                    extended.paste(image.crop((width - 1, 0, width, height)).resize((bx, height)), (bx + width, by))
                if by:
                    extended.paste(extended.crop((0, by, extended.width, by + 1)).resize((extended.width, by)), (0, 0))
                    extended.paste(extended.crop((0, by + height - 1, extended.width, by + height)).resize((extended.width, by)), (0, by + height))
                image = extended
        # Compress once, then reuse the stream in every PDF and later exports.
        compressed = zlib.compress(image.tobytes(), 3)
        with tempfile.NamedTemporaryFile(dir=cache, suffix='.tmp', delete=False) as out:
            temporary = Path(out.name)
            out.write(HEADER.pack(MAGIC, image.width, image.height, native))
            out.write(compressed)
        try:
            os.replace(temporary, filename)
        finally:
            temporary.unlink(missing_ok=True)
    return source, resource_info(filename), False


def new_pdf(filename, p, title):
    result = canvas.Canvas(str(filename), pagesize=(p['width'] * mm, p['height'] * mm), pageCompression=1)
    result.setTitle(title + ' — print sheets')
    result.setAuthor('Card Studio')
    return result


def draw_resource(pdf, resource, x, y, width, height):
    # Register the already compressed RGB stream, avoiding PNG encode/decode and
    # ReportLab recompression. Use one XObject per source within each document.
    name = Path(resource['path']).stem
    registered = pdf._doc.getXObjectName(name)
    if registered not in pdf._doc.idToObject:
        obj = PDFImageXObject(name)
        obj.width, obj.height = resource['width'], resource['height']
        obj.bitsPerComponent, obj.colorSpace = 8, 'DeviceRGB'
        obj._filters = ('FlateDecode',)
        with open(resource['path'], 'rb') as stream:
            stream.seek(HEADER.size)
            obj.streamContent = stream.read()
        pdf._doc.Reference(obj, registered)
        pdf._doc.addForm(name, obj)
    if resource['native']:
        scale = min(width / resource['width'], height / resource['height'])
        fitted_w, fitted_h = resource['width'] * scale, resource['height'] * scale
        x, y = x + (width - fitted_w) / 2, y + (height - fitted_h) / 2
        width, height = fitted_w, fitted_h
    pdf._currentPageHasImages = 1
    pdf.saveState()
    pdf.translate(x, y)
    pdf.scale(width, height)
    pdf.doForm(name)
    pdf.restoreState()


def draw_sheet(pdf, page, reverse, p, prepared):
    for index, entry in enumerate(page):
        source=entry.get('back_path') if reverse else entry['image_path']
        if not source:
            continue
        row, column = divmod(index, p['columns'])
        if reverse:
            horizontal=(p['height']>=p['width']) == (p.get('duplex_edge','long')=='long')
            if horizontal: column=p['columns']-1-column
            else: row=p['rows']-1-row
        x = p['offset_x'] + column * (p['card_width'] + 2 * p['bleed'] + p['gap'])
        y = p['height'] - p['offset_y'] - (row + 1) * (p['card_height'] + 2 * p['bleed']) - row * p['gap']
        draw_resource(pdf, prepared[source], x * mm, y * mm,
                      (p['card_width'] + 2 * p['bleed']) * mm,
                      (p['card_height'] + 2 * p['bleed']) * mm)
        if p['crop_marks']:
            left, bottom = x + p['bleed'], y + p['bleed']
            right, top = left + p['card_width'], bottom + p['card_height']
            # Keep ticks in the space between cells, outside any bleed.
            length = min(1.5, p['gap'] / 2)
            if length > 0:
                pdf.setLineWidth(.18)
                pdf.setStrokeColorRGB(.2, .2, .2)
                for xx in (left, right):
                    pdf.line(xx * mm, (y - length) * mm, xx * mm, (y - .1) * mm)
                    pdf.line(xx * mm, (y + p['card_height'] + 2 * p['bleed'] + .1) * mm,
                             xx * mm, (y + p['card_height'] + 2 * p['bleed'] + length) * mm)
                for yy in (bottom, top):
                    pdf.line((x - length) * mm, yy * mm, (x - .1) * mm, yy * mm)
                    pdf.line((x + p['card_width'] + 2 * p['bleed'] + .1) * mm, yy * mm,
                             (x + p['card_width'] + 2 * p['bleed'] + length) * mm, yy * mm)

    pdf.showPage()
def draw_calibration(pdf, p):
    pdf.setFont('Helvetica', 12)
    pdf.drawString(20 * mm, (p['height'] - 25) * mm, 'Print at Actual size / 100%. Disable Fit to page.')
    pdf.setLineWidth(.5)
    pdf.rect(20 * mm, 30 * mm, 100 * mm, 100 * mm)
    pdf.drawString(20 * mm, 24 * mm, 'This square should measure exactly 100 x 100 mm.')
    pdf.drawString(20 * mm, 15 * mm, f"Card trim: {p['card_width']} x {p['card_height']} mm")
    pdf.showPage()


def render_page(task):
    number, page, reverse, p, prepared, title, filename = task
    pdf = new_pdf(filename, p, title)
    if page is None:
        draw_calibration(pdf, p)
    else:
        draw_sheet(pdf, page, reverse, p, prepared)
    pdf.save()
    return filename


def export_pdf(request, destination):
    started = time.monotonic()
    p = request['plan']
    split = p.get('packaging') == 'per_page'
    copies = [entry for entry in request['entries'] for _ in range(entry['quantity'])]
    if p.get('face_mode') == 'separate':
        # Each copy's two faces occupy consecutive, ordinary card-sized cells.
        copies = [face for entry in copies for face in
                  ([entry, {**entry, 'image_path': entry['back_path'], 'back_path': None}]
                   if entry.get('back_path') else [entry])]
    sheets = []
    for start in range(0, len(copies), p['per_page']):
        page = copies[start:start + p['per_page']]
        sheets.append((page, False))
        if p.get('face_mode') == 'duplex':
            sheets.append((page, True))
    selected = p.get('selected_pages')
    pages = [(number, page, reverse) for number, (page, reverse) in enumerate(sheets, 1)
             if selected is None or number in selected]
    if p['calibration'] and (selected is None or len(sheets) + 1 in selected):
        pages.append((len(sheets) + 1, None, False))
    sources = list(dict.fromkeys((entry.get('back_path') if reverse else entry['image_path'])
                   for _, page, reverse in pages if page is not None for entry in page
                   if (entry.get('back_path') if reverse else entry['image_path'])))
    pixels = []
    for source in sources:
        with Image.open(source) as image:
            pixels.append(image.width * image.height)
    output_pixels = 0 if p['quality'] == 'full' else (p['card_width'] + 2*p['bleed']) * (p['card_height'] + 2*p['bleed']) / 25.4**2 * {'compact':300,'600':600,'1200':1200}[p['quality']]**2
    workers = worker_count(len(sources), max(max(pixels, default=1), output_pixels) * 24)
    cache = Path(destination).parent / 'print-cache'
    cache.mkdir(parents=True, exist_ok=True)
    prepared, hits = {}, 0
    for source, resource, hit in parallel_map(prepare_image, [(source, p, str(cache)) for source in sources], workers):
        prepared[source] = resource
        hits += hit
    prepared_at = time.monotonic()
    page_workers = 1
    with tempfile.TemporaryDirectory(prefix='card-studio-print-') as temp:
        if split:
            # Budget PDF buffers using actual compressed resource sizes, rather
            # than assuming that high-resolution art is cheap to hold in memory.
            largest = max((sum(Path(prepared[source]['path']).stat().st_size for source in
                               set((entry.get('back_path') if reverse else entry['image_path'])
                                   for entry in page) if source)
                           for _, page, reverse in pages if page is not None), default=1)
            page_workers = worker_count(len(pages), largest * 5)
            digits = max(3, len(str(len(sheets) + int(p['calibration']))))
            tasks = []
            for number, page, reverse in pages:
                suffix = '-calibration' if page is None else ''
                if page is not None and p.get('face_mode') == 'duplex':
                    suffix = '-back' if reverse else '-front'
                filename = str(Path(temp) / f'page-{number:0{digits}d}{suffix}.pdf')
                tasks.append((number, page, reverse, p, prepared, request['deck_name'], filename))
            with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
                for filename in parallel_map(render_page, tasks, page_workers):
                    archive.write(filename, Path(filename).name)
                    Path(filename).unlink()
        else:
            pdf = new_pdf(destination, p, request['deck_name'])
            for _, page, reverse in pages:
                if page is None:
                    draw_calibration(pdf, p)
                else:
                    draw_sheet(pdf, page, reverse, p, prepared)
            pdf.save()
    return dict(images=len(sources), cache_hits=hits, image_workers=workers, page_workers=page_workers,
                pages=archive_pages(destination) if split else [],
                prepare_seconds=round(prepared_at-started, 3), total_seconds=round(time.monotonic()-started, 3))


if __name__ == '__main__':
    if sys.argv[1] == '--list-pages':
        print(json.dumps(archive_pages(Path(sys.argv[2]))))
    else:
        print(json.dumps(export_pdf(json.loads(Path(sys.argv[1]).read_text()), Path(sys.argv[2]))))
