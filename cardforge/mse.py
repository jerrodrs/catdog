"""Magic Set Editor templates (the Full Magic Pack) as a second, deterministic card renderer.

A frame set whose config has `"renderer": "mse"` names an MSE stylesheet. The card's saved Oracle data is written to a
one-off MSE set file and Windows Magic Set Editor draws it with the pack's own frame images and official fonts; nothing
is AI-painted. The pack stays read-only in `vendor/Full-Magic-Pack`. Only the packages a stylesheet needs are copied to a
cache on the Windows disk (MSE is very slow reading over \\\\wsl.localhost). In that copy the game's footer
(collector number, set code, artist, copyright) is switched off, as AGENTS.md requires.

Each render also draws the card over black and over white artwork; the difference between the two gives an exact
transparent frame overlay, translucent panels included.
"""
from __future__ import annotations

import fcntl
import hashlib
import io
import json
import math
import os
import re
import shutil
import struct
import subprocess
import tempfile
import uuid
import zipfile
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageOps

ROOT = Path(__file__).resolve().parent.parent
PACK = Path(os.environ.get('CARDSTUDIO_MSE_PACK', ROOT/'vendor/Full-Magic-Pack'))
STATE = ROOT/'library/mse'
LAYOUTS = ('normal', 'planeswalker', 'saga', 'adventure', 'token', 'special')
# Structures MSE's command-line export cannot lay out reliably keep the included renderer: planeswalker loyalty boxes are
# positioned by the MSE editor, not on export, and inset-spell and saga fields are not mapped yet.
FALLBACK_KINDS = ('planeswalker', 'adventure', 'prepare', 'saga', 'class')
SPECIAL = re.compile(r'split|aftermath|fuse|flip|level|class\b|battle|emblem|dungeon|plane(?!swalker|shift)|scheme|vanguard|counter|booster|'
                     r'rule|deckbox|\bcase\b|room|prototype|attraction|contraption|dfc|transform|meld|duplex|tfc|modal|sticker|textless|'
                     r'checklist|mutate|station|leveler|archenemy|mini|oversize|bounty|sideboard|token-?sheet|art-?card|\bback\b', re.I)
EXCLUDED_GROUPS = ('Deprecated', 'Paraphernalia', 'Satellite Games')
DEFAULT_SYMBOL = {'name': 'Classic diamond', 'shapes': [{'shape': 'polygon', 'points': [[0, -0.92], [0.62, 0], [0, 0.92], [-0.62, 0]]}]}
TEXT_SUFFIXES = {'', '.txt', '.mse-symbol'}
MSE_RARITY = {'common': 'common', 'uncommon': 'uncommon', 'rare': 'rare', 'mythic': 'mythic rare', 'special': 'special', 'bonus': 'special'}


class MSEError(ValueError):
    pass


def validate_config(config):
    from .render import LayoutError
    spec = config.get('mse')
    if not isinstance(spec, dict) or not isinstance(spec.get('stylesheet'), str):
        raise LayoutError('An MSE frame set needs mse.stylesheet')
    names = [spec['stylesheet'], *(spec.get('layouts') or {}).values()]
    known = {row['id'] for row in catalog()['templates']}
    for name in names:
        if name not in known:
            raise LayoutError(f'Unknown Magic Set Editor template: {name}')
    if config.get('rarity_symbol') is not None:
        from .rarity import validate
        validate(config['rarity_symbol'], LayoutError)


# ---------------------------------------------------------------- pack catalogue

def header(text):
    """Top-level `key: value` lines of an MSE data file."""
    return {k.strip(): v.strip() for k, v in re.findall(r'^([a-z][a-z ]*?):[ \t]*(.*)$', text, re.M)}


def read_text(path):
    return Path(path).read_text(encoding='utf-8-sig', errors='replace')


def png_size(path):
    try:
        with open(path, 'rb') as f:
            head = f.read(24)
        if head[:8] == b'\x89PNG\r\n\x1a\n':
            return struct.unpack('>II', head[16:24])
        with Image.open(path) as image:
            return image.size
    except Exception:
        return (0, 0)


def pack_revision():
    head = PACK/'.git/HEAD'
    if head.exists():
        ref = head.read_text().strip()
        if ref.startswith('ref:'):
            target = PACK/'.git'/ref[5:]
            if target.exists():
                return target.read_text().strip()
            packed = PACK/'.git/packed-refs'
            if packed.exists():
                for line in packed.read_text().splitlines():
                    if line.endswith(ref[5:]):
                        return line.split()[0]
        return ref
    return 'unversioned'


def layout_of(style_id, name, group, width, height):
    words = ' '.join((style_id, name, group))
    if width > height:
        return 'special'
    if re.search(r'planeswalker|walker', words, re.I):
        return 'planeswalker'
    if re.search(r'saga', words, re.I):
        return 'saga'
    if re.search(r'adventure', words, re.I):
        return 'adventure'
    if re.search(r'token', words, re.I):
        return 'token'
    return 'special' if SPECIAL.search(f'{style_id} {name}') else 'normal'


def template_ppi(directory, width, height):
    """Pixel density of the template's own full-card frame images when printed at 2.5 × 3.5 in."""
    best = 0
    for path in directory.rglob('*'):
        if path.suffix.lower() in ('.png', '.jpg', '.jpeg'):
            w, h = png_size(path)
            if w and h and abs(w/h - width/height) < .03 and w >= .9*width:
                best = max(best, w)
    return round(best/(2.5 if width < height else 3.5)) if best else None


@lru_cache(maxsize=1)
def font_families():
    """Family names of the pack's bundled fonts (installed for the Windows user by `install_fonts`)."""
    from PIL import ImageFont
    names = set()
    for path in (PACK/'Magic - Fonts').rglob('*'):
        if path.suffix.lower() in ('.ttf', '.otf'):
            try:
                family, style = ImageFont.truetype(str(path), 12).getname()
            except OSError:
                continue
            names.update({family.lower(), f'{family} {style}'.lower()})
    return names


SYSTEM_FONTS = {'arial', 'times new roman', 'tahoma', 'verdana', 'georgia', 'segoe ui', 'courier new', 'symbol', 'wingdings',
                'calibri', 'trebuchet ms', 'impact', 'comic sans ms', 'palatino linotype', 'garamond', 'consolas', 'cambria',
                'franklin gothic medium', 'lucida console', 'microsoft sans serif', 'sylfaen', 'webdings', 'gabriola'}


def referenced_fonts(text):
    names = set()
    for block in re.finditer(r'^(\t+)font:\s*\n((?:\1\t.*\n)+)', text, re.M):
        for value in re.findall(r'^\t+name:\s*(.+)$', block.group(2), re.M):
            value = value.strip()
            if value and not value.startswith(('{', '"', 'script')):
                names.add(value)
    return names


def build_catalog():
    templates = []
    families = font_families()
    for directory in sorted((PACK/'data').glob('magic-*.mse-style')):
        style = directory/'style'
        if not style.exists():
            continue
        text = read_text(style)
        meta = header(text)
        if meta.get('game') != 'magic':
            continue
        style_id = directory.name[len('magic-'):-len('.mse-style')]
        width, height = float(meta.get('card width', 375) or 375), float(meta.get('card height', 523) or 523)
        group = meta.get('installer group', '')
        parts = group.split('/')
        category = parts[1] if len(parts) > 1 else 'Other'
        sample = next((p for p in (directory/'card-sample.png', directory/'card_sample.png', directory/(meta.get('icon') or '-')) if p.is_file()), None)
        name = parts[-1] if len(parts) > 2 else (meta.get('short name') or style_id)
        layout = layout_of(style_id, name, group, width, height)
        missing = sorted(f for f in referenced_fonts(text) if f.lower() not in families and f.lower() not in SYSTEM_FONTS)
        templates.append({
            'id': style_id, 'name': name, 'full_name': meta.get('full name', ''), 'short_name': meta.get('short name', ''),
            'group': group, 'category': category, 'family': parts[2] if len(parts) > 3 else '',
            'width': width, 'height': height, 'dpi': float(meta.get('card dpi', 150) or 150), 'ppi': template_ppi(directory, width, height),
            'layout': layout, 'alias': 'alias/card_fields' in text, 'missing_fonts': missing,
            'usable': layout == 'normal' and category not in EXCLUDED_GROUPS and not missing,
            'sample': str(sample.relative_to(PACK)) if sample else None,
        })
    by_id = {t['id']: t for t in templates}
    for t in templates:
        # A family's planeswalker, saga and adventure siblings, when the pack has them.
        stem = re.sub(r'-(?:main|normal|altered)$', '', t['id'])
        for layout in ('planeswalker',):
            sibling = next((c for c in (f'{stem}-walker', f'{stem}-planeswalker', f'{stem}-pw') if c in by_id and by_id[c]['layout'] == layout), None)
            if sibling:
                t.setdefault('siblings', {})[layout] = sibling
    return {'pack_revision': pack_revision(), 'templates': templates}


@lru_cache(maxsize=1)
def catalog():
    if not (PACK/'data').is_dir():
        return {'pack_revision': None, 'templates': []}
    cache = STATE/'catalog.json'
    revision = pack_revision()
    if cache.exists():
        data = json.loads(cache.read_text())
        if data.get('pack_revision') == revision and data.get('version') == 4:
            return data
    data = {**build_catalog(), 'version': 4}
    STATE.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(data, indent=1))
    return data


def template(style_id):
    found = next((t for t in catalog()['templates'] if t['id'] == style_id), None)
    if not found:
        raise MSEError(f'Unknown Magic Set Editor template: {style_id}')
    return found


# ---------------------------------------------------------------- Windows cache

@lru_cache(maxsize=1)
def home():
    if os.environ.get('CARDSTUDIO_MSE_HOME'):
        return Path(os.environ['CARDSTUDIO_MSE_HOME'])
    try:
        local = subprocess.run(['cmd.exe', '/c', 'echo %LOCALAPPDATA%'], capture_output=True, text=True, timeout=20, cwd='/mnt/c').stdout.strip()
        return Path(subprocess.run(['wslpath', '-u', local], capture_output=True, text=True, timeout=20).stdout.strip())/'CardStudio/mse'
    except (OSError, subprocess.SubprocessError) as e:
        raise MSEError('Magic Set Editor needs Windows (WSL interop) or CARDSTUDIO_MSE_HOME') from e


def windows_path(path):
    converter = 'winepath' if os.environ.get('CARDSTUDIO_MSE_WINE') else 'wslpath'
    return subprocess.run([converter, '-w', str(path)], capture_output=True, text=True, check=True).stdout.strip()


def windows_command(program, *args):
    """Opt into a headless Wine runtime on a Linux server; retain WSL interop."""
    wine = os.environ.get('CARDSTUDIO_MSE_WINE')
    prefix = ['xvfb-run', '-a', wine] if wine else []
    return [*prefix, str(program), *args]


PACKAGE = re.compile(r'(?<![\w-])((?:magic|en)[\w-]*\.mse-(?:include|symbol-font|game|style|export-template|locale))')


@lru_cache(maxsize=None)
def package_references(package):
    """Packages one package refers to: its `depends on` entries and any /package/file paths in its scripts."""
    directory = PACK/'data'/package
    found = set()
    files = [directory] if directory.is_file() else [p for p in directory.rglob('*') if p.is_file() and p.suffix.lower() in TEXT_SUFFIXES]
    for path in files:
        if path.stat().st_size > 4_000_000:
            continue
        found.update(PACKAGE.findall(read_text(path)))
    return frozenset(p for p in found if p != package and (PACK/'data'/p).exists())


def dependencies(style_id):
    todo, seen = [f'magic-{style_id}.mse-style', 'en.mse-locale'], set()
    while todo:
        package = todo.pop()
        if package in seen:
            continue
        seen.add(package)
        todo.extend(package_references(package))
    return sorted(seen)


def tree_stamp(directory):
    h = hashlib.sha256()
    for path in sorted(directory.rglob('*')):
        if path.is_file():
            stat = path.stat()
            h.update(f'{path.relative_to(directory)}\0{stat.st_size}\0'.encode())
    h.update(b'footer-patch-2')
    return h.hexdigest()


def patch_game(directory):
    """No footer: MSE's information fields (collector number, set code, artist, copyright) stay hidden."""
    script = directory/'script'
    text = read_text(script)
    patched = re.sub(r'^(information_disabled_[123] := ){ false }', r'\1{ true }', text, flags=re.M)
    if 'information_disabled_1 := { true }' not in patched:
        raise MSEError('Could not switch off the MSE card footer; the pack layout changed')
    script.write_text(patched, encoding='utf-8')


FOOTER_FIELD = re.compile(r'illustrator|illus\b|copyright|artist|paintbrush|card code|set code|card number|collector|set language', re.I)


def patch_style(directory):
    """No footer on fan templates that draw their own: hide illustrator, copyright and collector fields."""
    style = directory/'style'
    out, section, hide, skipping = [], None, False, False
    for line in read_text(style).split('\n'):
        if skipping:
            if line.startswith('\t\t\t') or not line.strip():
                continue
            skipping = False
        if line and not line[0].isspace():
            section, hide = line.split(':')[0].strip(), False
        elif section in ('card style', 'extra card style') and re.match(r'^\t[^\t].*:\s*$', line):
            hide = bool(FOOTER_FIELD.search(line))
            out.append(line)
            if hide:
                out.append('\t\tvisible: false')
            continue
        elif hide and re.match(r'^\t\tvisible:', line):
            skipping = not line.split(':', 1)[1].strip()
            continue
        out.append(line)
    style.write_text('\n'.join(out), encoding='utf-8')


def export_template(target, zoom):
    name = f'cardstudio-png-z{zoom}'
    directory = target/'data'/f'{name}.mse-export-template'
    directory.mkdir(parents=True, exist_ok=True)
    (directory/'export-template').write_text(
        'mse version: 2.6.0\ngame: magic\nshort name: Card Studio PNG\nfull name: Card Studio PNG export\n'
        'position hint: 999999\nversion: 2026-11-01\ndepends on: magic.mse-game 2008-05-18\ncreate directory: true\n'
        'file type: *.txt|*.txt\n\nscript:\n'
        f'\tfor each card in set do write_image_file(card, file:"card{{position(of:card,in:set)}}.png", zoom: {zoom}) + "\\n"\n',
        encoding='utf-8')
    return name


def sync(style_ids):
    """Copy the program and the packages these stylesheets need into the Windows cache, refreshing changed ones."""
    target = home()
    (target/'data').mkdir(parents=True, exist_ok=True)
    for program in ('magicseteditor.exe', 'magicseteditor.com'):
        source, copy = PACK/program, target/program
        if not copy.exists() or copy.stat().st_size != source.stat().st_size:
            shutil.copyfile(source, copy)
    packages = sorted({p for s in style_ids for p in dependencies(s)})
    # Studio imports and gallery previews run in separate processes; only one may refresh the cache at a time.
    with open(target/'.sync-lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        for package in packages:
            refresh(package, target)
    return packages


def refresh(package, target):
    """Copy one package into the cache unless its copy is current, applying the footer patches."""
    source, copy = PACK/'data'/package, target/'data'/package
    stamp = tree_stamp(source)
    marker = copy/'.cardstudio-source' if source.is_dir() else copy.with_name(copy.name+'.cardstudio-source')
    if marker.exists() and marker.read_text() == stamp:
        return
    if source.is_dir():
        shutil.rmtree(copy, ignore_errors=True)
        shutil.copytree(source, copy)
        if package == 'magic.mse-game':
            patch_game(copy)
        elif package.endswith('.mse-style'):
            patch_style(copy)
    else:
        shutil.copyfile(source, copy)
    marker.write_text(stamp)


# ---------------------------------------------------------------- fonts

def install_fonts():
    """Install the pack's fonts for the current Windows user (no administrator rights; MSE reads installed fonts)."""
    wine = bool(os.environ.get('CARDSTUDIO_MSE_WINE'))
    target = Path(os.environ.get('WINEPREFIX', Path.home()/'.wine'))/'drive_c/windows/Fonts' if wine else home().parent.parent/'Microsoft/Windows/Fonts'
    target.mkdir(parents=True, exist_ok=True)
    from PIL import ImageFont
    key = r'HKCU\Software\Microsoft\Windows NT\CurrentVersion\Fonts'
    installed = []
    registry = []
    wine_target = windows_path(target) if wine else None
    for path in sorted((PACK/'Magic - Fonts').rglob('*')):
        if path.suffix.lower() not in ('.ttf', '.otf') or any(p.name == path.name for p in installed):
            continue
        family, style = ImageFont.truetype(str(path), 12).getname()
        copy = target/path.name
        if not copy.exists() or copy.stat().st_size != path.stat().st_size:
            shutil.copyfile(path, copy)
        label = family if style in ('Regular', '') else f'{family} {style}'
        kind = 'OpenType' if path.suffix.lower() == '.otf' else 'TrueType'
        if wine:
            registry.append(json.dumps(f'{label} ({kind})', ensure_ascii=False)+'='+json.dumps(wine_target+'\\'+copy.name, ensure_ascii=False))
        else:
            subprocess.run(windows_command('reg.exe', 'add', key, '/v', f'{label} ({kind})', '/t', 'REG_SZ', '/d', windows_path(copy), '/f'),
                           capture_output=True, check=True, cwd='/mnt/c')
        installed.append(path)
    if wine and registry:
        registry_file = target/'card-studio-fonts.reg'
        registry_file.write_text('Windows Registry Editor Version 5.00\n\n[HKEY_CURRENT_USER\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts]\n'+'\n'.join(registry)+'\n', encoding='utf-16')
        subprocess.run(windows_command('reg.exe', 'import', windows_path(registry_file)), capture_output=True, check=True, cwd=target, timeout=120)
    return [p.name for p in installed]


# ---------------------------------------------------------------- set files

def quote(value):
    """One MSE field value: single line inline, otherwise an indented block."""
    value = str(value).replace('\r', '')
    if '\n' not in value:
        return ' ' + value
    return '\n' + '\n'.join('\t\t' + line for line in value.split('\n'))


def mana(cost):
    """{2}{W/U}{G/P} → 2W/UH/G, MSE's casting-cost notation."""
    out = []
    for token in re.findall(r'\{([^{}]+)\}', cost or ''):
        parts = token.split('/')
        if parts[-1] == 'P':
            token = 'H/' + '/'.join(parts[:-1])
        out.append(token)
    return ''.join(out)


def symbols(text):
    """Oracle text with {T}, {2}{G} … as MSE symbol tags; angle brackets are escaped as MSE expects."""
    text = (text or '').replace('<', '\u2039').replace('>', '\u203a')
    return re.sub(r'(?:\{[^{}]+\})+', lambda m: f'<sym>{mana(m.group(0))}</sym>', text)


def split_type(type_line):
    supertypes, _, subtypes = (type_line or '').partition(' — ')
    return supertypes.strip(), subtypes.strip()


def loyalty_lines(oracle):
    costs, lines = [], []
    for line in oracle.split('\n'):
        m = re.match(r'^([+\u2212\-]?(?:\d+|X)):\s*(.*)$', line)
        costs.append(m.group(1).replace('\u2212', '-') if m else '')
        lines.append(m.group(2) if m else line)
    return costs, lines


def card_fields(card, stylesheet, image, supports_alias):
    supertypes, subtypes = split_type(card['type_line'])
    display = card.get('display_name') if card.get('display_name') and card['display_name'] != card['name'] else None
    fields = [('stylesheet', stylesheet), ('has_styling', 'false'),
              ('name', display if display and supports_alias else card['name'])]
    if display and supports_alias:
        fields.append(('alias', card['name']))
    fields += [('casting_cost', mana(card.get('mana_cost', ''))), ('image', image),
               ('super_type', supertypes), ('sub_type', subtypes),
               ('rarity', MSE_RARITY.get(card.get('rarity', 'rare'), 'rare'))]
    oracle = card.get('oracle_text', '')
    if 'Planeswalker' in card['type_line']:
        costs, lines = loyalty_lines(oracle)
        # Planeswalker templates hold one ability per level_N_text field, each with its own loyalty_cost_N box.
        fields += [(f'level_{i+1}_text', symbols(l)) for i, l in enumerate(lines[:8])]
        fields += [(f'loyalty_cost_{i+1}', c) for i, c in enumerate(costs) if c]
        fields.append(('loyalty', str(card.get('loyalty', ''))))
    else:
        fields.append(('rule_text', symbols(oracle)))
    if card.get('flavor_text'):
        fields.append(('flavor_text', '<i-flavor>' + symbols(card['flavor_text']) + '</i-flavor>'))
    if 'power' in card:
        fields += [('power', card['power']), ('toughness', card['toughness'])]
    fields.append(('illustrator', ''))
    return fields


def set_file(cards, stylesheet):
    lines = ['mse_version: 2.6.0', 'game: magic', f'stylesheet: {stylesheet}', 'set_info:', '\ttitle: Card Studio',
             '\tsymbol: symbol1', '\tautomatic_reminder_text: ', '\tmark_errors: no', '\tauto_correct: no',
             '\tautomatic_card_numbers: no', '\tautomatic_copyright: no', '\tcopyright: ', '\tartist: ']
    for fields in cards:
        lines.append('card:')
        lines += [f'\t{k}:{quote(v)}' for k, v in fields]
    return '\n'.join(lines) + '\n'


# ---------------------------------------------------------------- rarity symbol (vector .mse-symbol)

def _loops(mask):
    """Closed pixel-edge outlines of a binary mask, foreground on the right of each directed edge."""
    h, w = mask.shape
    padded = np.zeros((h+2, w+2), bool)
    padded[1:-1, 1:-1] = mask
    edges = {}
    ys, xs = np.nonzero(mask)
    for y, x in zip(ys.tolist(), xs.tolist()):
        py, px = y+1, x+1
        if not padded[py-1, px]: edges.setdefault((x, y), []).append((x+1, y))
        if not padded[py, px+1]: edges.setdefault((x+1, y), []).append((x+1, y+1))
        if not padded[py+1, px]: edges.setdefault((x+1, y+1), []).append((x, y+1))
        if not padded[py, px-1]: edges.setdefault((x, y+1), []).append((x, y))
    loops = []
    while edges:
        start = next(iter(edges))
        loop, point = [start], start
        while True:
            options = edges[point]
            nxt = options.pop()
            if not options:
                del edges[point]
            if nxt == start:
                break
            loop.append(nxt)
            point = nxt
            if point not in edges:
                break
        if len(loop) >= 4:
            loops.append(loop)
    return loops


def _simplify(points, epsilon):
    if len(points) < 3:
        return points
    a, b = np.array(points[0], float), np.array(points[-1], float)
    d = b - a
    norm = math.hypot(*d) or 1.0
    distances = [abs(d[0]*(a[1]-p[1]) - d[1]*(a[0]-p[0]))/norm if norm else math.hypot(p[0]-a[0], p[1]-a[1]) for p in points]
    i = int(np.argmax(distances))
    if distances[i] <= epsilon:
        return [points[0], points[-1]]
    return _simplify(points[:i+1], epsilon)[:-1] + _simplify(points[i:], epsilon)


def _area(loop):
    return sum(x0*y1 - x1*y0 for (x0, y0), (x1, y1) in zip(loop, loop[1:]+loop[:1]))/2


def _inside(point, loop):
    x, y = point
    hit = False
    for (x0, y0), (x1, y1) in zip(loop, loop[1:]+loop[:1]):
        if (y0 > y) != (y1 > y) and x < x0 + (y-y0)*(x1-x0)/(y1-y0):
            hit = not hit
    return hit


def symbol_file(spec, size=256):
    """The frame set's rarity glyph as an MSE vector symbol, so MSE colours it per rarity like a printed set symbol."""
    from .rarity import mask
    glyph = np.array(mask(json.dumps(spec or DEFAULT_SYMBOL, sort_keys=True), size)) >= 128
    loops = []
    for loop in _loops(glyph):
        mid = len(loop)//2
        simple = _simplify(loop[:mid+1], .7)[:-1] + _simplify(loop[mid:]+loop[:1], .7)[:-1]
        if len(simple) >= 3:
            loops.append(simple)
    depth = [sum(_inside((l[0][0]+.25, l[0][1]+.25), other) for other in loops if other is not l) for l in loops]
    out = ['mse version: 0.3.8']
    for n, (d, loop) in enumerate(sorted(zip(depth, loops), key=lambda p: p[0])):
        out += ['part:', '\ttype: shape', f'\tname: part {n}', f'\tcombine: {"subtract" if d % 2 else "merge"}']
        for x, y in loop:
            out += ['\tpoint:', f'\t\tposition: ({x/size:.6f},{y/size:.6f})', '\t\tlock: free', '\t\tline after: line']
    return '\n'.join(out) + '\n'


# ---------------------------------------------------------------- rendering

def run_mse(set_text, images, zoom, symbol):
    """Write a set file, run MSE's exporter once and return the PNG of each card in order."""
    target = home()
    name = export_template(target, zoom)
    jobs = target/'jobs'
    jobs.mkdir(exist_ok=True)
    job = jobs/uuid.uuid4().hex
    job.mkdir()
    try:
        with zipfile.ZipFile(job/'card.mse-set', 'w', zipfile.ZIP_STORED) as z:
            z.writestr('set', set_text)
            z.writestr('symbol1', symbol)
            for key, data in images.items():
                z.writestr(key, data)
        with open(target/'.render-lock', 'w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            result = subprocess.run(windows_command(target/'magicseteditor.com', '--export', name, 'card.mse-set', 'out.txt'),
                                    cwd=job, capture_output=True, text=True, timeout=600)
        outputs = sorted((job/'out-files').glob('card*.png'), key=lambda p: int(re.sub(r'\D', '', p.stem)))
        if not outputs:
            raise MSEError('Magic Set Editor did not export the card: ' + (result.stdout + result.stderr).strip()[-1500:])
        problems = [l for l in (result.stdout + result.stderr).splitlines() if re.search(r'error', l, re.I) and 'Dictionary' not in l]
        images = []
        for path in outputs:
            with Image.open(path) as image:
                images.append(image.convert('RGBA'))
        return images, problems
    finally:
        shutil.rmtree(job, ignore_errors=True)


def flat(image, colour):
    """Fill transparent card corners so the print has full bleed."""
    base = Image.new('RGBA', image.size, colour)
    base.alpha_composite(image)
    return base.convert('RGB')


def png_bytes(image):
    buffer = io.BytesIO()
    image.save(buffer, 'PNG', compress_level=3)
    return buffer.getvalue()


def probe_image(width=1024, height=1024):
    """Coordinates encoded as colour: red rises left to right, green top to bottom, blue constant."""
    x = np.tile(np.linspace(0, 255, width), (height, 1))
    y = np.tile(np.linspace(0, 255, height)[:, None], (1, width))
    return Image.fromarray(np.dstack([x, y, np.full_like(x, 128)]).round().astype(np.uint8), 'RGB')


def art_box(style_id):
    """Measure the art field: render a coordinate-gradient picture and fit where its columns and rows land."""
    meta = template(style_id)
    cache = STATE/'art-boxes'/f'{style_id}.json'
    revision = catalog()['pack_revision']
    if cache.exists():
        data = json.loads(cache.read_text())
        if data.get('pack_revision') == revision:
            return data
    sync([style_id])
    probe = {'id': 'probe', 'name': 'Probe', 'type_line': 'Creature — Probe', 'oracle_text': 'Probe.', 'mana_cost': '{1}',
             'power': '1', 'toughness': '1', 'rarity': 'rare'}
    zoom = 200
    images, _ = run_mse(set_file([card_fields(probe, style_id, 'image1', meta['alias'])], style_id),
                        {'image1': png_bytes(probe_image())}, zoom, symbol_file(None))
    out = np.asarray(images[0]).astype(float)
    r, g, b, a = out[..., 0], out[..., 1], out[..., 2], out[..., 3]
    ys, xs = np.mgrid[0:out.shape[0], 0:out.shape[1]]
    visible = (a > 250) & (np.abs(b - 128) < 3)
    if visible.sum() < 1000:
        raise MSEError(f'Could not find the art window of {style_id}')
    # Least squares x = x0 + w·r/255 and y = y0 + h·g/255 over the visible art pixels.
    sx = np.polyfit(r[visible]/255, xs[visible], 1)
    sy = np.polyfit(g[visible]/255, ys[visible], 1)
    scale = zoom/100
    box = [sx[1]/scale, sy[1]/scale, (sx[1]+sx[0])/scale, (sy[1]+sy[0])/scale]
    data = {'pack_revision': revision, 'box': [round(v, 2) for v in box], 'card_size': [meta['width'], meta['height']],
            'visible': [int(xs[visible].min()/scale), int(ys[visible].min()/scale), int(xs[visible].max()/scale), int(ys[visible].max()/scale)]}
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(data, indent=1))
    return data


def prepared_art(art_path, box, zoom, focus):
    """Crop the artwork to the art field's proportions around the saved focus; never enlarge it."""
    width, height = box[2]-box[0], box[3]-box[1]
    with Image.open(art_path) as source:
        image = ImageOps.exif_transpose(source).convert('RGB')
    aspect = width/height
    if image.width/image.height > aspect:
        w, h = round(image.height*aspect), image.height
    else:
        w, h = image.width, round(image.width/aspect)
    fx, fy = focus
    left = min(max(0, round(fx*image.width - w/2)), image.width-w)
    top = min(max(0, round(fy*image.height - h/2)), image.height-h)
    image = image.crop((left, top, left+w, top+h))
    need = math.ceil(width*zoom/100)
    if image.width > need*1.05:
        image = image.resize((need, round(need/aspect)), Image.Resampling.LANCZOS)
    return image


def placeholder(box, zoom):
    width, height = round((box[2]-box[0])*zoom/100), round((box[3]-box[1])*zoom/100)
    image = Image.new('RGB', (max(16, width), max(16, height)), '#5d665f')
    d = ImageDraw.Draw(image)
    for x in range(-height, width, 48):
        d.line((x, 0, x+height, height), fill='#6b746c', width=10)
    from .render import font
    d.text((image.width/2, image.height/2), 'ARTWORK PLACEHOLDER', font=font('title', max(16, image.width//18)), anchor='mm', fill='#d4dad2')
    return image


def stylesheet_for(card, config):
    from .template_sets import layout_kind
    kind = 'planeswalker' if 'Planeswalker' in card.get('type_line', '') else layout_kind(card)
    spec = config['mse']
    return (spec.get('layouts') or {}).get(kind) or spec['stylesheet'], kind


_LAST = {}


def render_previews(items, width=900):
    """Screen proofs sharing a stylesheet use one MSE export, with no overlay probes."""
    card = items[0][0]
    config = card['frame_style']
    style_id, kind = stylesheet_for(card, config)
    meta = template(style_id)
    if meta['missing_fonts']:
        raise MSEError(f'{meta["name"]} needs fonts the pack does not include: {", ".join(meta["missing_fonts"])}')
    target = (width, round(width * 1.4))
    zoom = math.ceil(width / meta['width'] * 100)
    sync([style_id])
    box = art_box(style_id)['box']
    fields, assets = [], {}
    for index, (current, art_path) in enumerate(items, 1):
        if stylesheet_for(current, current['frame_style'])[0] != style_id:
            raise MSEError('Batch previews must share a stylesheet')
        name = f'image{index}'
        art = prepared_art(art_path, box, zoom, current.get('art_focus', [.5, .5]))
        fields.append(card_fields(current, style_id, name, meta['alias']))
        assets[name] = png_bytes(art)
    images, problems = run_mse(set_file(fields, style_id), assets, zoom, symbol_file(config.get('rarity_symbol')))
    if len(images) != len(items):
        raise MSEError('Magic Set Editor did not export every preview card')
    return [(flat(image.resize(target, Image.Resampling.LANCZOS), '#000000'),
             {'template': 'mse', 'renderer': 'Magic Set Editor', 'stylesheet': style_id,
              'layout_kind': stylesheet_for(current, current['frame_style'])[1],
              'status': 'preview', 'preview': True, 'size': list(target),
              'logical_size': [1500, 2100], 'dpi': width / 2.5,
              'footer_text': False, 'color_space': 'sRGB', 'mse_warnings': problems[:20]})
            for image, (current, _) in zip(images, items)]


def render_preview(card, art_path, width=900):
    return render_previews([(card, art_path)], width)[0]


def render_card(card, art_path=None, frame_only=False, dpi=600):
    """Render one face with its MSE template. Returns (image, report) like cardforge.render.render."""
    config = card['frame_style']
    style_id, kind = stylesheet_for(card, config)
    meta = template(style_id)
    if meta['missing_fonts']:
        raise MSEError(f'{meta["name"]} needs fonts the pack does not include: {", ".join(meta["missing_fonts"])}')
    target = (round(2.5*dpi), round(3.5*dpi))
    zoom = math.ceil(target[0]/meta['width']*100)
    key = hashlib.sha256(json.dumps([card, str(art_path), dpi, hash_file(art_path)], sort_keys=True, default=str).encode()).hexdigest()
    if key not in _LAST:
        sync([style_id])
        measured = art_box(style_id)
        box = measured['box']
        art = prepared_art(art_path, box, zoom, card.get('art_focus', [.5, .5])) if art_path else placeholder(box, zoom)
        size = art.size
        fields = lambda image: card_fields(card, style_id, image, meta['alias'])
        images, problems = run_mse(set_file([fields('image1'), fields('image2'), fields('image3')], style_id),
                                   {'image1': png_bytes(art), 'image2': png_bytes(Image.new('RGB', size, 'black')),
                                    'image3': png_bytes(Image.new('RGB', size, 'white'))},
                                   zoom, symbol_file(config.get('rarity_symbol')))
        composed, black, white = (np.asarray(i.resize(target, Image.Resampling.LANCZOS)).astype(float) for i in images)
        # Over black the frame shows colour·alpha; over white colour·alpha + 255·(1-alpha).
        alpha = np.clip(1 - (white[..., :3] - black[..., :3]).max(axis=2)/255, 0, 1) * (black[..., 3]/255)
        colour = np.clip(black[..., :3]/np.maximum(alpha[..., None], 1e-3), 0, 255)
        frame = Image.fromarray(np.dstack([colour, alpha*255]).round().astype(np.uint8), 'RGBA')
        image = flat(Image.fromarray(composed.round().astype(np.uint8), 'RGBA'), '#000000')
        report = {
            'template': 'mse', 'renderer': 'Magic Set Editor', 'stylesheet': style_id, 'stylesheet_name': meta['name'],
            'pack_revision': catalog()['pack_revision'], 'template_ppi': meta['ppi'], 'mse_zoom': zoom, 'layout_kind': kind,
            'id': card['id'], 'name': card['name'], 'frame_set': config.get('name'),
            'display_name_printed': bool(card.get('display_name') and card['display_name'] != card['name'] and meta['alias']),
            'size': list(target), 'dpi': dpi, 'logical_size': [1500, 2100], 'text_rendering': 'native-font-rasterization',
            'art_box': box, 'art_sha256': hash_file(art_path), 'mse_warnings': problems[:20],
            'input_sha256': hashlib.sha256(json.dumps(card, sort_keys=True, ensure_ascii=False).encode()).hexdigest(),
            'renderer_sha256': hash_file(Path(__file__)),
            'status': 'composed' if art_path else 'layout-proof', 'footer_text': False, 'color_space': 'sRGB',
            'review_required': ['Compare Oracle text against snapshot', 'Inspect art crop and legibility at print size'],
        }
        if card.get('display_name') and card['display_name'] != card['name'] and not meta['alias']:
            report['review_required'].append('This template has no original-name tab, so the card prints its original name')
        if art_path:
            with Image.open(art_path) as original:
                field = ((box[2]-box[0])/meta['width']*target[0], (box[3]-box[1])/meta['width']*target[0])
                report['art_resolution'] = {'source_pixels': list(original.size), 'sampled_pixels': [round(v) for v in field],
                                            'effective_ppi': round(min(size[0]/field[0], size[1]/field[1])*dpi, 1),
                                            'enlarged': size[0] < field[0] or size[1] < field[1]}
        _LAST.clear()
        _LAST[key] = (image, frame, report)
    image, frame, report = _LAST[key]
    if frame_only:
        return frame, {**report, 'status': 'frame-overlay'}
    return image, report


def hash_file(path):
    if not path:
        return None
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


# ---------------------------------------------------------------- frame sets

def frame_config(style_id, name=None, rarity_symbol=None):
    """A frame set config that renders normal cards, tokens and double-faced card faces with an MSE template."""
    meta = template(style_id)
    if not meta['usable']:
        raise MSEError(f'{meta["name"]} is not a normal-card template')
    layouts = {}
    config = {'schema_version': 3, 'renderer': 'mse', 'name': (name or meta['name'])[:120],
              'description': f'Magic Set Editor template “{meta["name"]}” ({meta["group"]}) from the Full Magic Pack.',
              'mse': {'stylesheet': style_id, 'layouts': layouts, 'pack_revision': catalog()['pack_revision']}}
    if rarity_symbol:
        config['rarity_symbol'] = rarity_symbol
    return config
