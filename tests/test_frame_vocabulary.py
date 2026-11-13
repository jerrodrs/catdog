import copy
import json
import unittest
from cardforge.render import ROOT, render, LayoutError
from cardforge.decorations import load_set
from cardforge.template_sets import validate_set, preview_card, measured_contrast, SHAPES
from cardforge.ornaments import SYMBOLS, symbol_mask

# A bracket-like custom bar end used wherever tests iterate every shape.
PROFILE = [[28, 0], [8, .18], [20, .5], [8, .82], [28, 1]]
def shaped(shape):
    return {'shape': shape, **({'shape_profile': PROFILE} if shape == 'custom' else {})}


class FrameVocabularyTests(unittest.TestCase):
    def test_example_sets_validate_render_and_stay_readable(self):
        for name in ('classic', 'art-deco', 'showcase-observatory'):
            config = load_set(ROOT/'examples/frame-sets'/(name+'.json'))
            validate_set(config)
            image, report = render(preview_card('creature', config, ['R'], True))
            self.assertEqual(report['frame_set'], config['name'])
        contrast = measured_contrast(load_set(ROOT/'examples/frame-sets/classic.json'))
        self.assertTrue(contrast)

    def test_every_shape_and_symbol_renders(self):
        base = json.loads((ROOT/'examples/frame-set.json').read_text())
        for shape in SHAPES:
            config = copy.deepcopy(base); config['style'].update(shaped(shape))
            validate_set(config)
            render(preview_card('instant', config))
        for symbol in SYMBOLS:
            self.assertGreater(symbol_mask(symbol, 40).getbbox()[2], 20)

    def test_bar_ends_that_cut_in_move_the_lettering_by_the_same_depth(self):
        from cardforge.template_sets import bar_shape, shape_inset
        for box in ((58, 54, 1442, 186), (58, 1689, 1442, 1799)):
            h = box[3]-box[1]
            for shape in SHAPES:
                for cut in (None, 32, 60):
                    profile = tuple(map(tuple, PROFILE)) if shape == 'custom' else None
                    points = bar_shape(shape, box, cut, profile)
                    beside = [x for x, y in points if box[1]+h/4 <= y <= box[3]-h/4]
                    left = [x for x in beside if x < 750]; right = [x for x in beside if x > 750]
                    inset = shape_inset(shape, box, cut, profile)
                    if left: self.assertLessEqual(max(left), box[0]+inset+6.5, (shape, cut))
                    if right: self.assertGreaterEqual(min(right), box[2]-inset-6.5, (shape, cut))
            self.assertEqual(shape_inset('classic', box, 60), 0)
        base = json.loads((ROOT/'examples/frame-set.json').read_text())
        _, plain = render(preview_card('creature', base))
        ticket = copy.deepcopy(base); ticket['style'].update(shape='ticket', shape_cut=32)
        _, cut = render(preview_card('creature', ticket))
        depth = shape_inset('ticket', tuple(cut['geometry']['title']), 32)
        self.assertGreater(depth, 0)
        self.assertEqual(cut['alignment']['title'][0], plain['alignment']['title'][0]+depth)
        self.assertEqual(cut['alignment']['type_line'][0], plain['alignment']['type_line'][0]+depth)

    def test_lettering_and_symbols_always_clear_the_rails(self):
        from cardforge.template_sets import bar_shape, bar_points, clear_height, clear_span, rail_depth, rules_inset, TEXT_GAP
        base = json.loads((ROOT/'examples/frame-set.json').read_text())
        for shape in SHAPES:
            config = copy.deepcopy(base)
            config['style'].update(shaped(shape), shape_cut=40, rail_width=36, rail_style='double')
            card = preview_card('creature', config, ['R', 'G'], True, alias=True)
            card.update(name='Gishath, Sun\'s Avatar', display_name='Grumpy Jumping Kingpin', mana_cost='{5}{R}{G}{W}',
                        type_line='Legendary Creature — Dinosaur Avatar', power='17', toughness='12')
            _, report = render(card)
            geometry, alignment, depth = report['geometry'], report['alignment'], rail_depth(config['style'])
            for element, ink in (('title', alignment['title']), ('type', alignment['type_line'])):
                points = bar_points(card, element, tuple(geometry[element]))
                top, bottom = clear_height(points, depth)
                self.assertGreaterEqual(ink[1], top+TEXT_GAP-1, (shape, element))
                self.assertLessEqual(ink[3], bottom-TEXT_GAP+1, (shape, element))
                left, right = clear_span(points, depth, ink[1], ink[3])
                self.assertGreaterEqual(ink[0], left+TEXT_GAP-1, (shape, element))
            stats = alignment['statistics']
            points = bar_shape(shape, tuple(geometry['stats']), 40, tuple(map(tuple, PROFILE)) if shape == 'custom' else None)
            left, right = clear_span(points, depth, stats[1], stats[3])
            self.assertTrue(left+TEXT_GAP-1 <= stats[0] and stats[2] <= right-TEXT_GAP+1, shape)
            self.assertGreaterEqual(106+rules_inset(card), 78+depth+TEXT_GAP)
        # Frames whose rails already leave room keep the approved geometry.
        _, plain = render(preview_card('creature', base))
        self.assertEqual(list(plain['geometry']['title']), [58, 54, 1442, 186])

    def test_painted_pieces_print_crisp_and_unstretched(self):
        import sys, tempfile, pathlib
        from PIL import Image
        from cardforge.decorations import tiled
        sys.path.insert(0, str(ROOT/'studio'))
        from frame_review import asset_quality
        segment = Image.new('RGBA', (40, 200), (200, 150, 60, 255)); segment.putpixel((0, 0), (0, 0, 0, 0))
        strip = tiled(segment, 60, 1000)
        self.assertEqual(strip.size, (60, 1000)); self.assertEqual(strip.getpixel((0, 300)), (0, 0, 0, 0))  # 300px repeats
        with tempfile.TemporaryDirectory() as folder:
            segment.save(pathlib.Path(folder)/'trim.png')
            config = {'_asset_root': folder, 'style': {}, 'layouts': {}}
            config['decorations'] = [{'image': 'trim.png', 'box': [0, 0, 20, 2100], 'fit': 'tile'}]
            self.assertEqual(asset_quality(config), [])
            config['decorations'] = [{'image': 'trim.png', 'box': [0, 0, 30, 2100], 'fit': 'stretch'}]
            self.assertIn('stretched', asset_quality(config)[0])
            config['decorations'] = [{'image': 'trim.png', 'box': [0, 0, 100, 500], 'fit': 'contain'}]
            self.assertIn('enlarged', asset_quality(config)[0])
            # Drawn at exactly the box's print size: placed as drawn, transparent margin kept, so a ring stays on the rim.
            ring = Image.new('RGBA', (3000, 4200), (0, 0, 0, 0)); ring.paste((40, 90, 160, 255), (64, 64, 2936, 200))
            ring.save(pathlib.Path(folder)/'ring.png')
            from cardforge.decorations import apply
            config['decorations'] = [{'image': 'ring.png', 'box': [0, 0, 1500, 2100], 'fit': 'stretch'}]
            self.assertEqual(asset_quality(config), [])
            layer = Image.new('RGBA', (3000, 4200)); apply(layer, config, {}, 1500, 'creature', False, safe=Image.new('L', (3000, 4200), 255))
            self.assertEqual(layer.getpixel((30, 100))[3], 0); self.assertEqual(layer.getpixel((100, 100))[:3], (40, 90, 160))

    def test_ornaments_and_decorations_must_sit_on_the_frame(self):
        from cardforge.template_sets import art_intrusions
        base = json.loads((ROOT/'examples/frame-set.json').read_text())
        on_frame = copy.deepcopy(base); on_frame['ornaments'] = [{'kind': 'symbol', 'symbol': 'chip', 'points': [[58, 120]], 'size': 48, 'fill': '#ffffff'}]
        self.assertEqual(art_intrusions(on_frame), [])
        in_art = copy.deepcopy(base); in_art['ornaments'] = [{'kind': 'symbol', 'symbol': 'chip', 'points': [[120, 330]], 'size': 60, 'fill': '#ffffff', 'layouts': ['creature']}]
        problems = art_intrusions(in_art)
        self.assertEqual(len(problems), 1); self.assertIn('over the illustration on creature cards', problems[0])

    def test_rarity_symbol_is_validated_and_coloured_by_rarity(self):
        from cardforge.rarity import tile
        base = json.loads((ROOT/'examples/frame-set.json').read_text())
        validate_set(base)
        for bad in ({'shapes': []}, {'shapes': [{'shape': 'circle', 'center': [0, 0], 'r': .05}]}, {'shapes': [{'shape': 'symbol', 'symbol': 'dragon', 'center': [0, 0], 'size': 1}]}):
            config = copy.deepcopy(base); config['rarity_symbol'] = bad
            with self.assertRaises(LayoutError): validate_set(config)
        colours = {r: tile(base['rarity_symbol'], r)[0].convert('RGB').resize((1, 1), 3).getpixel((0, 0)) for r in ('common', 'uncommon', 'rare', 'mythic')}
        self.assertEqual(len(set(colours.values())), 4)
        card = preview_card('creature', base); card['rarity'] = 'mythic'
        with_symbol, report = render(card)
        diamond = copy.deepcopy(base); del diamond['rarity_symbol']
        card = preview_card('creature', diamond); card['rarity'] = 'mythic'
        without, _ = render(card)
        y = round(sum(report['geometry']['type'][1::2])/2)
        self.assertNotEqual(with_symbol.crop((1340, y-30, 1420, y+30)).tobytes(), without.crop((1340, y-30, 1420, y+30)).tobytes())

    def test_invalid_vocabulary_is_rejected(self):
        base = json.loads((ROOT/'examples/frame-set.json').read_text())
        for key, value in (('shape', 'hexagon'), ('rail_style', 'triple'), ('rail_width', 80), ('panel_alpha', 40), ('rules_texture', 'missing')):
            config = copy.deepcopy(base); config['style'][key] = value
            with self.assertRaises(LayoutError, msg=key): validate_set(config)
        config = copy.deepcopy(base); config['ornaments'] = [{'kind': 'symbol', 'symbol': 'dragon', 'points': [[100, 100]], 'size': 50}]
        with self.assertRaises(LayoutError): validate_set(config)
        config = copy.deepcopy(base); config['style']['rules_text_color'] = config['style'].get('panel_color', '#000000')
        with self.assertRaises(LayoutError): validate_set(config)

    def test_ornaments_never_cover_rules_text(self):
        base = json.loads((ROOT/'examples/frame-set.json').read_text())
        plain, report = render(preview_card('creature', base))
        config = copy.deepcopy(base)
        config['ornaments'] = [{'kind': 'symbol', 'symbol': 'star', 'points': [[750, 1700]], 'size': 600, 'fill': '#ff00ff'}]
        validate_set(config)
        covered, _ = render(preview_card('creature', config))
        top = round(report['type_top'] + 118)
        self.assertEqual(plain.crop((110, top, 1380, 1850)).tobytes(), covered.crop((110, top, 1380, 1850)).tobytes())


if __name__ == '__main__':
    unittest.main()


class FrameFreedomTests(unittest.TestCase):
    """Custom silhouettes, rules-box shapes, painted skins and rail textures: freedom inside the fixed card structure."""
    base = json.loads((ROOT/'examples/frame-set.json').read_text())

    def test_custom_profiles_are_validated(self):
        for bad in ([[0, 0], [0, 1]], [[10, .1], [0, .5], [10, 1]], [[10, 0], [50, .5], [10, 1]], [[10, 0], [5, .7], [5, .4], [10, 1]], [[70, 0], [0, .5], [10, 1]]):
            config = copy.deepcopy(self.base); config['style'].update(shape='custom', shape_profile=bad)
            with self.assertRaises(LayoutError, msg=bad): validate_set(config)
        config = copy.deepcopy(self.base); config['style']['shape'] = 'custom'
        with self.assertRaisesRegex(LayoutError, 'shape_profile'): validate_set(config)

    def test_rules_box_shapes_keep_the_text_in_place(self):
        from cardforge.template_sets import PANEL_BOTTOMS, PANEL_CORNERS
        _, plain = render(preview_card('creature', self.base, ['R']))
        for bottom in PANEL_BOTTOMS:
            for corners in PANEL_CORNERS:
                config = copy.deepcopy(self.base); config['style'].update(panel_bottom=bottom, panel_corners=corners, panel_corner_size=40)
                validate_set(config)
                image, report = render(preview_card('creature', config, ['R']))
                self.assertEqual(report['type_top'], plain['type_top'], (bottom, corners))
                self.assertEqual(report['alignment']['type_line'], plain['alignment']['type_line'], (bottom, corners))
        for key, value in (('panel_bottom', 'wave'), ('panel_corners', 'star'), ('panel_corner_size', 60)):
            config = copy.deepcopy(self.base); config['style'][key] = value
            with self.assertRaises(LayoutError): validate_set(config)

    def test_nine_slice_keeps_painted_edges_at_native_size(self):
        from PIL import Image
        from cardforge.template_sets import nine_slice
        source = Image.new('RGBA', (300, 200), (240, 230, 200, 255))
        source.paste((120, 40, 20, 255), (0, 0, 40, 40)); source.paste((20, 120, 40, 255), (260, 160, 300, 200))
        for fill in ('stretch', 'tile'):
            out = nine_slice(source, (1200, 900), [40, 40, 40, 40], fill)
            self.assertEqual(out.size, (1200, 900))
            self.assertEqual(out.getpixel((39, 39))[:3], (120, 40, 20)); self.assertEqual(out.getpixel((41, 41))[:3], (240, 230, 200))
            self.assertEqual(out.getpixel((1199, 899))[:3], (20, 120, 40)); self.assertEqual(out.getpixel((1158, 858))[:3], (240, 230, 200))
        self.assertEqual(nine_slice(source, (60, 60), [40, 40, 40, 40]).size, (60, 60))  # smaller than its edges: shrinks uniformly

    def test_skins_and_rail_textures_render_validate_and_print_crisp(self):
        import sys, tempfile, pathlib
        from PIL import Image
        sys.path.insert(0, str(ROOT/'studio'))
        from frame_review import asset_quality, features, flavour_problems
        with tempfile.TemporaryDirectory() as folder:
            folder = pathlib.Path(folder)
            skin = Image.new('RGB', (1600, 900), (236, 222, 190)); skin.paste((90, 50, 20), (0, 0, 1600, 10)); skin.save(folder/'vellum.png')
            Image.new('RGB', (128, 128), (150, 120, 60)).save(folder/'brass.png')
            config = copy.deepcopy(self.base)
            config['skins'] = {'vellum': {'image': 'vellum.png', 'slice': [60, 60, 60, 60], 'fill': 'tile'}}
            config['textures'] = {'brass': {'image': 'brass.png', 'tint': False}}
            config['style'].update(rules_skin='vellum', type_skin='vellum', panel_color='#ece0c2', panel_alpha=255, rules_text_color='#1d140c', type_text_color='#1d140c', rail_texture='brass', rail_width=16)
            (folder/'config.json').write_text(json.dumps(config))
            loaded = load_set(folder/'config.json'); validate_set(loaded)
            self.assertTrue(measured_contrast(loaded))
            image, report = render(preview_card('creature', loaded, ['R']))
            inside = image.convert('RGB').getpixel((700, report['type_top']+200))
            self.assertLess(sum(abs(a-b) for a, b in zip(inside, (236, 222, 190))), 60)
            self.assertEqual(asset_quality(loaded), [])
            found = features(loaded)
            self.assertEqual(found['skinned_surfaces'], ['rules', 'type']); self.assertTrue(found['rails'])
            self.assertEqual(flavour_problems('showcase', {**found, 'shape': True}), [])
            self.assertTrue(flavour_problems('showcase', {**found, 'skinned_surfaces': ['rules'], 'decorations': 0}))
            loaded['skins']['vellum'] = {'image': 'vellum.png', 'sha256': loaded['skins']['vellum']['sha256']}  # cover-fit 1600x900 on the rules box
            self.assertIn('enlarged', asset_quality(loaded)[0])
            for bad in ({'image': 'vellum.png', 'slice': [900, 0, 900, 0]}, {'image': 'vellum.png', 'fill': 'mirror'}, {'image': 'vellum.png', 'tint': 'yes'}):
                broken = copy.deepcopy(config); broken['skins'] = {'vellum': bad}; (folder/'config.json').write_text(json.dumps(broken))
                with self.assertRaises(LayoutError, msg=bad): validate_set(load_set(folder/'config.json'))
            missing = copy.deepcopy(config); missing['style']['type_skin'] = 'nope'; (folder/'config.json').write_text(json.dumps(missing))
            with self.assertRaisesRegex(LayoutError, 'type_skin'): validate_set(load_set(folder/'config.json'))

    def test_parallel_options_must_differ_until_the_designer_finishes(self):
        import sys, tempfile, pathlib
        sys.path.insert(0, str(ROOT/'studio'))
        from frame_review import sibling_problems
        with tempfile.TemporaryDirectory() as folder:
            mine, other = pathlib.Path(folder)/'mine', pathlib.Path(folder)/'other'
            for path in (mine, other):
                path.mkdir(); (path/'concept.json').write_text(json.dumps({'concepts': [{'name': 'The Oxblood Indenture'}], 'chosen': 0}))
            request = {'siblings': [{'label': 'Simpler', 'directory': str(other)}]}
            problems, warnings, _ = sibling_problems(mine/'creature.frame.png', request, mine)
            self.assertEqual(len(problems), 1); self.assertIn('Simpler', problems[0])
            problems, warnings, _ = sibling_problems(mine/'creature.frame.png', request, mine, final=True)
            self.assertEqual((len(problems), len(warnings)), (0, 1))

    def test_generated_frames_cannot_pin_card_positions(self):
        from cardforge.template_sets import drop_designer_positions, apply_controls
        config = copy.deepcopy(self.base)
        config['style'].update(rules_offset_y=75, stats_x=900, title_padding=30)
        config['layouts']['land']['rules_offset_y'] = 40
        removed = drop_designer_positions(config, {'stats_x': 920})
        self.assertEqual(removed, ['rules_offset_y'])
        self.assertNotIn('rules_offset_y', config['style']); self.assertNotIn('rules_offset_y', config['layouts']['land'])
        self.assertEqual(config['style']['title_padding'], 30)  # padding is a design choice, not a position
        config = apply_controls(config, {'stats_x': 920, 'rules_sizing': 'fit'})
        self.assertEqual(config['style']['stats_x'], 920)
        _, short = render(preview_card('creature', config, ['R']))
        pinned = copy.deepcopy(config); pinned['style']['rules_offset_y'] = 75
        _, tall = render(preview_card('creature', pinned, ['R']))
        self.assertGreater(short['type_top'], tall['type_top'])  # fitted: the box hugs one line of rules

    def test_frames_are_not_compared_with_other_saved_sets(self):
        import sys, tempfile, pathlib, shutil
        sys.path.insert(0, str(ROOT/'studio'))
        from frame_review import review
        from cardforge.template_sets import check_and_preview
        with tempfile.TemporaryDirectory() as folder:
            folder = pathlib.Path(folder)
            config = copy.deepcopy(self.base); config['style'].update(shape='ticket', rail_style='double')
            config['rarity_symbol'] = {'shapes': [{'shape': 'circle', 'center': [0, 0], 'r': .8}]}
            check_and_preview(config, folder/'previews')
            twin = folder/'twin.png'; shutil.copy(folder/'previews'/'creature.frame.png', twin)
            # An identical saved set (legacy request field) neither fails nor warns.
            record = review(config, {'candidate': {'target': 'stylised'}, 'comparisons': [{'name': 'Twin', 'frame_path': str(twin)}]}, folder, folder/'previews')
            self.assertEqual((record['problems'], record['warnings'], record['similarity']), ([], [], []))
