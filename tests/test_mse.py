import os
import unittest
import numpy as np
from PIL import Image
from cardforge import mse
from cardforge.render import render, LayoutError
from cardforge.template_sets import validate_set, preview_card


def pack_available():
    return (mse.PACK/'data').is_dir()


class MagicSetEditorMappingTests(unittest.TestCase):
    def test_mana_and_rules_symbols_use_mse_notation(self):
        self.assertEqual(mse.mana('{2}{W}{U}'), '2WU')
        self.assertEqual(mse.mana('{10}{G/P}{W/U}{2/B}{X}'), '10H/GW/U2/BX')
        self.assertEqual(mse.symbols('{T}: Add {C}{C}.'), '<sym>T</sym>: Add <sym>CC</sym>.')
        self.assertNotIn('<b>', mse.symbols('Deal 2 <b> damage'))

    def test_multi_line_fields_are_indented_blocks(self):
        card = {'id': 'x', 'name': 'Original', 'display_name': 'Shown', 'type_line': 'Legendary Creature — Cat Scout',
                'mana_cost': '{1}{G}', 'oracle_text': 'Vigilance\n{T}: Add {G}.', 'flavor_text': 'Quiet.', 'power': '2', 'toughness': '2', 'rarity': 'mythic'}
        text = mse.set_file([mse.card_fields(card, 'm15-altered', 'image1', True)], 'm15-altered')
        self.assertIn('\trule_text:\n\t\tVigilance\n\t\t<sym>T</sym>: Add <sym>G</sym>.\n', text)
        self.assertIn('\tname: Shown\n\talias: Original\n', text)
        self.assertIn('\tsuper_type: Legendary Creature\n\tsub_type: Cat Scout\n', text)
        self.assertIn('\trarity: mythic rare\n', text)
        # No footer and no automatic reminder text: the card prints exactly its saved Oracle text.
        self.assertIn('\tautomatic_reminder_text: \n', text)
        # Without an original-name tab the card keeps its real name.
        self.assertIn('\tname: Original\n', mse.set_file([mse.card_fields(card, 'm15-altered', 'image1', False)], 'm15-altered'))

    def test_rarity_glyph_becomes_a_vector_symbol_with_holes(self):
        ring = {'name': 'Ring', 'shapes': [{'shape': 'circle', 'center': [0, 0], 'r': 1}, {'shape': 'circle', 'center': [0, 0], 'r': .5, 'cut': True}]}
        text = mse.symbol_file(ring, size=96)
        self.assertEqual(text.count('part:'), 2)
        self.assertEqual(text.count('combine: merge'), 1)
        self.assertEqual(text.count('combine: subtract'), 1)
        self.assertIn('combine: merge', mse.symbol_file(None, size=64))

    def test_template_classification(self):
        self.assertEqual(mse.layout_of('m15-showcase-capenna-art-deco', 'Art Deco', 'magic/M15 Frames/Booster Fun/Art Deco', 744, 1039), 'normal')
        self.assertEqual(mse.layout_of('m15-showcase-capenna-art-deco-walker', 'Art Deco PW', '', 744, 1039), 'planeswalker')
        self.assertEqual(mse.layout_of('m15-split-fusable', 'M15 Split', '', 375, 523), 'special')
        self.assertEqual(mse.layout_of('m15-something', 'x', '', 523, 375), 'special')

    @unittest.skipUnless(pack_available(), 'Full Magic Pack not installed')
    def test_catalogue_and_frame_configs(self):
        templates = {t['id']: t for t in mse.catalog()['templates']}
        self.assertGreater(len(templates), 300)
        deco = templates['m15-showcase-capenna-art-deco']
        self.assertTrue(deco['usable'] and deco['alias'])
        self.assertGreaterEqual(deco['ppi'], 290)
        self.assertFalse(templates['m15-split-fusable']['usable'])
        config = mse.frame_config('m15-showcase-capenna-art-deco')
        self.assertIs(validate_set(config), config)
        with self.assertRaises(LayoutError):
            validate_set({**config, 'mse': {'stylesheet': 'no-such-template'}})
        with self.assertRaises(mse.MSEError):
            mse.frame_config('m15-split-fusable')
        self.assertIn('magic.mse-game', mse.dependencies('m15-showcase-capenna-art-deco'))

    @unittest.skipUnless(pack_available(), 'Full Magic Pack not installed')
    def test_special_structures_keep_the_included_renderer(self):
        config = mse.frame_config('m15-showcase-capenna-art-deco')
        for kind in ('planeswalker', 'saga', 'adventure'):
            image, report = render(preview_card(kind, config))
            self.assertNotEqual(report.get('template'), 'mse')

    @unittest.skipUnless(pack_available() and os.environ.get('CARDSTUDIO_MSE_TESTS'), 'set CARDSTUDIO_MSE_TESTS=1 to run Magic Set Editor')
    def test_magic_set_editor_renders_card_and_exact_frame_overlay(self):
        card = preview_card('creature', mse.frame_config('m15-showcase-capenna-art-deco'), ['R'], True, True)
        image, report = render(card, dpi=600)
        frame, _ = render(card, frame_only=True, dpi=600)
        self.assertEqual(image.size, (1500, 2100))
        self.assertEqual((report['template'], report['status'], report['footer_text']), ('mse', 'layout-proof', False))
        self.assertTrue(report['display_name_printed'])
        alpha = np.asarray(frame)[..., 3]
        # Opaque frame around a transparent art window.
        self.assertEqual(alpha[20, 750], 255)
        self.assertEqual(alpha[700, 750], 0)


if __name__ == '__main__':
    unittest.main()
