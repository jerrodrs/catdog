import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from cardforge.render import ROOT, FONTS, LayoutError, font, render, save_card, text_plan, validate, wrap


class RendererTests(unittest.TestCase):
    def test_single_face_tokens_have_exact_type_stats_and_no_mana(self):
        token = {'id': 'cat-token', 'name': 'Cat', 'layout': 'token', 'type_line': 'Token Creature — Cat',
                 'oracle_text': '', 'colors': ['G'], 'power': '1', 'toughness': '1'}
        validate(token)
        image, report = render(token)
        self.assertEqual(image.size, (1500, 2100))
        self.assertFalse(report['footer_text'])
        with self.assertRaises(LayoutError):
            validate({**token, 'mana_cost': '{G}'})
        with self.assertRaises(LayoutError):
            validate({**token, 'type_line': 'Creature — Cat'})
    @classmethod
    def setUpClass(cls):
        cls.cards = json.loads((ROOT/'examples/layout-proofs.json').read_text())['cards']

    def test_repeated_build_has_identical_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            p = save_card(self.cards[0], Path(temp)/'a')
            q = save_card(self.cards[0], Path(temp)/'b')
            self.assertEqual(p.read_bytes(), q.read_bytes())
            self.assertEqual(p.with_suffix('.report.json').read_bytes(), q.with_suffix('.report.json').read_bytes())

    def test_rules_and_flavor_fit_reserved_space(self):
        for card in self.cards:
            p = text_plan(card)
            self.assertLessEqual(p['height'], p['bottom']-p['top'])
            self.assertGreaterEqual(p['size'], 56)

    def test_text_is_not_discarded_during_wrap(self):
        source = 'Whenever this creature attacks, add {W/U}. (Spend this mana only on creatures.)'
        lines = wrap(source, 64, 500)
        actual = ' '.join(''.join(t for t, _ in line).strip() for line in lines)
        self.assertEqual(actual, source)
        self.assertTrue(any(role == 'italic' for line in lines for _, role in line))

    def test_overflow_is_error(self):
        card = dict(self.cards[0], oracle_text='Draw a card. '*200)
        with self.assertRaises(LayoutError):
            render(card)

    def test_long_title_does_not_collide_with_mana(self):
        with self.assertRaises(LayoutError):
            render(dict(self.cards[0], display_name='Very Long Title '*20))

    def test_long_alternate_title_requires_a_shorter_single_line_name(self):
        config = json.loads((ROOT/'examples/frame-set.json').read_text())
        config['style'].update(shape='angular', shape_cut=40)
        card = dict(self.cards[0], display_name='Madame Morrow, Keeper of Lost Things',
                    mana_cost='{3}{B}{B}', face_label='front', frame_style=config)
        for dpi in (600, 1200):
            with self.subTest(dpi=dpi):
                with self.assertRaisesRegex(LayoutError, 'Choose a shorter display_name'):
                    render(card, frame_only=True, dpi=dpi)
                _, report = render(dict(card, display_name='Madame Morrow'), frame_only=True, dpi=dpi)
                self.assertNotIn('title_lines', report['alignment'])
                self.assertLessEqual(report['alignment']['title'][2], 1406 - 3*76 - 24)

    def test_unknown_symbols_rejected(self):
        with self.assertRaises(LayoutError):
            render(dict(self.cards[0], mana_cost='{BANANA}'))

    def test_symbol_punctuation_and_parentheses_stay_attached(self):
        text = 'Cycling {2} ({2}, Discard this card: Draw a card.)'
        for width in (240, 400, 600):
            lines = wrap(text, 64, width)
            for line in lines:
                plain = ''.join(t for t, _ in line)
                self.assertFalse(plain.startswith((')', ',', ':', '.')))
                self.assertFalse(plain.endswith('('))

    def test_explicit_ability_words_use_italic(self):
        lines = wrap('Landfall — Draw a card.', 64, 1000, italic_phrases=['Landfall'])
        self.assertEqual(lines[0][0], ('Landfall', 'italic'))
        self.assertIn(('Draw', 'body'), lines[0])

    def test_overlay_preserves_transparency_and_has_typeset_panels(self):
        image, report = render(self.cards[0], frame_only=True)
        self.assertEqual(image.mode, 'RGBA')
        self.assertEqual(image.getpixel((0, 0))[3], 0)
        # Sample blank padding below the measured text, rather than a fixed old row.
        self.assertGreater(image.getpixel((400, 1905))[3], 160)
        self.assertLess(image.getpixel((400, 1905))[3], 230)
        self.assertEqual(report['status'], 'frame-overlay')

    def test_assets_match_recorded_source_hashes(self):
        for item in json.loads((ROOT/'assets/provenance.json').read_text()):
            data = (ROOT/'assets/fonts'/item['asset']).read_bytes()
            git_hash = hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()
            self.assertEqual(git_hash, item['git_blob_sha'])

    def test_missing_font_has_no_system_fallback(self):
        font.cache_clear()
        try:
            with patch.dict(FONTS, {'body': Path('/tmp/cardforge-deliberately-absent-font.ttf')}):
                with self.assertRaises(LayoutError):
                    font('body', 64)
        finally:
            font.cache_clear()

    def test_import_retains_oracle_identity_and_text(self):
        import subprocess
        import sys
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp)/'snapshot.json'
            target = Path(temp)/'manifest.json'
            raw = dict(name='Source Card', layout='normal', type_line='Artifact',
                       oracle_text='{T}: Add {C}.', colors=[], mana_cost='{1}',
                       oracle_id='test-oracle-id', id='test-print-id')
            source.write_text(json.dumps(raw))
            subprocess.run([sys.executable, '-m', 'cardforge', 'import', str(source), '--out', str(target)],
                           cwd=ROOT, capture_output=True, check=True)
            card = json.loads(target.read_text())['cards'][0]
            self.assertEqual(card['oracle_text'], raw['oracle_text'])
            self.assertEqual(card['name'], raw['name'])
            self.assertEqual(card['source']['oracle_id'], raw['oracle_id'])

    def test_special_layouts_rejected(self):
        for layout in ['saga', 'transform', 'modal_dfc', 'adventure', 'split', 'planeswalker']:
            with self.assertRaises(LayoutError):
                validate(dict(self.cards[0], layout=layout))

    def test_incorrect_creature_stats_rejected(self):
        card = copy.deepcopy(self.cards[0])
        del card['power']
        with self.assertRaises(LayoutError):
            validate(card)

    def test_small_art_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)/'small.png'
            Image.new('RGB', (100, 100)).save(path)
            with self.assertRaises(LayoutError):
                render(self.cards[0], path)

    def test_full_size_art_is_composited(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)/'art.png'
            Image.new('RGB', (1500, 2100), '#df2525').save(path)
            image, report = render(self.cards[0], path)
            self.assertEqual(image.getpixel((0, 0)), (223, 37, 37))
            self.assertEqual(report['status'], 'composed')
            self.assertIsNotNone(report['art_sha256'])


if __name__ == '__main__':
    unittest.main()
