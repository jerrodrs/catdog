import copy
import json
import unittest

from PIL import Image, ImageDraw

from cardforge.frames import KINDS, frame_for, template_key
from cardforge.render import ROOT, font, render
from cardforge.typography import centered_text


class AlignmentAndFramesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.card = json.loads((ROOT/'decks/delighted-halfling.json').read_text())['cards'][0]

    def test_visible_ink_is_centered_for_each_label_font(self):
        # Actual raster pixels, rather than reproducing the anchor calculation.
        for role, text, size in [('title', 'Bright-Eyed Trailguide', 80),
                                 ('alias', 'Delighted Halfling', 45),
                                 ('title', 'Creature — Halfling Citizen', 57),
                                 ('title', '1/2', 78), ('title', 'Ágyp', 64)]:
            image = Image.new('RGBA', (1500, 200))
            box = (90, 50, 1400, 150)
            centered_text(ImageDraw.Draw(image), box, text, font(role, size), '#ffffff')
            bounds = image.getchannel('A').getbbox()
            self.assertLessEqual(abs((bounds[1]+bounds[3])/2-100), .5, (role, text, bounds))

    def test_card_headers_and_stats_are_centered_in_their_actual_boxes(self):
        _, report = render(self.card)
        for field, center in [('original_name', 220), ('statistics', 1967)]:
            bounds = report['alignment'][field]
            self.assertLessEqual(abs((bounds[1]+bounds[3])/2-center), .5, field)
        type_box=report['geometry']['type']
        for field, center in [('title_capital', 120), ('type_capital', (type_box[1]+type_box[3])/2)]:
            top, bottom = report['alignment'][field]
            self.assertLessEqual(abs((top+bottom)/2-center), .5, field)

    def test_capital_T_has_equal_top_and_bottom_space(self):
        # Raster check: full text with descenders must not pull a capital T upwards.
        for size, text in [(80, 'Bright-Eyed Trailguide'), (57, 'Creature — Halfling Citizen')]:
            image = Image.new('RGBA', (1500, 220))
            centered_text(ImageDraw.Draw(image), (50, 50, 1400, 170),
                          'T', font('title', size), '#ffffff', vertical_reference='T')
            box = image.getchannel('A').getbbox()
            self.assertLessEqual(abs((box[1]-50)-(170-box[3])), 1)
            from cardforge.typography import centered_origin
            with_descenders = centered_origin(text, font('title', size), (50, 50, 1400, 170), vertical_reference='T')
            capital_only = centered_origin('T', font('title', size), (50, 50, 1400, 170), vertical_reference='T')
            self.assertEqual(with_descenders[1], capital_only[1])

    def test_inline_tap_and_colorless_disc_align_to_text_capitals(self):
        _, report = render(self.card)
        values = report['alignment']['inline_symbols']
        self.assertEqual([v['token'] for v in values], ['{T}', '{C}', '{T}'])
        for value in values:
            self.assertLessEqual(abs(value['disc_center_y']-value['text_cap_center_y']), .5)

    def test_frame_selection_is_independent_of_color_input_order(self):
        for pair in ('WU', 'UB', 'BR', 'RG', 'GW', 'WB', 'UR', 'BG', 'RW', 'GU'):
            a = dict(self.card, colors=list(pair))
            b = dict(self.card, colors=list(reversed(pair)))
            self.assertEqual(template_key(a), pair+'-normal')
            self.assertEqual(template_key(a), template_key(b))

    def test_legendary_crest_occupies_area_above_normal_header(self):
        normal = frame_for(self.card, 1280)
        legendary = frame_for(dict(self.card, type_line='Legendary Creature — Halfling Citizen'), 1280)
        self.assertIsNone(normal.crop((0, 20, 1500, 48)).getbbox())
        self.assertIsNotNone(legendary.crop((0, 20, 1500, 48)).getbbox())

    def test_explicit_full_height_preserves_approved_rules_and_flavor_pixels(self):
        from unittest.mock import patch
        art = ROOT/'decks'/self.card['art']
        with patch('cardforge.geometry.style',return_value={'rules_sizing':'full'}):
            current, _ = render(self.card, art)
        with Image.open(ROOT/'tests/fixtures/approved-halfling.png') as approved:
            # Preserve approved text, divider and frame; exclude the removed footer.
            region = (0, 1380, 1500, 2010)
            self.assertEqual(current.crop(region).tobytes(), approved.convert('RGB').crop(region).tobytes())

    def test_provenance_metadata_never_adds_footer_text(self):
        plain, _ = render(self.card)
        marked, _ = render(dict(self.card, art_credit='AI-generated artwork',
                               collector_number='999', set_code='CUSTOM PROXY'))
        self.assertEqual(plain.tobytes(), marked.tobytes())

    def test_alias_is_attached_and_tapers_inward(self):
        frame = frame_for(self.card, 1280)
        # No transparent gap along the header-to-subtitle connection.
        for y in range(181, 201):
            self.assertGreater(frame.getpixel((750, y))[3], 200)
        # The sloping side is wide near the join and inset at the bottom.
        self.assertGreater(frame.getpixel((112, 192))[3], 0)
        self.assertEqual(frame.getpixel((112, 244))[3], 0)

    def test_all_34_color_and_legendary_variants_are_addressable(self):
        self.assertEqual(len(KINDS)*2, 34)
        for color in KINDS:
            colors = list(color) if len(color) == 2 else ([] if color == 'C' else list('WUR') if color == 'M' else [color])
            for legendary in (False, True):
                card = dict(self.card, colors=colors,
                            type_line=('Legendary ' if legendary else '')+'Creature — Cat')
                self.assertEqual(template_key(card), color+('-legendary' if legendary else '-normal'))

    def test_optional_alias_and_statistics_do_not_leave_unused_panels(self):
        card = copy.deepcopy(self.card)
        card.pop('display_name')
        card.pop('power')
        card.pop('toughness')
        card['type_line'] = 'Sorcery'
        frame = frame_for(card, 1280)
        self.assertEqual(frame.getpixel((750, 208))[3], 0)
        self.assertEqual(frame.getpixel((1350, 2005))[3], 0)


if __name__ == '__main__':
    unittest.main()
