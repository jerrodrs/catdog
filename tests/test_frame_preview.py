import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from PIL import Image, ImageChops
from cardforge import mse
from cardforge.render import render
from cardforge.template_sets import preview_card
from cardforge.borders import finish
from studio.preview_deck_frame import preview, preview_batch


class FramePreviewTests(unittest.TestCase):
    def test_native_preview_matches_the_renderer_and_border_at_screen_size(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            art = root/'art.png'
            Image.new('RGB', (1500, 2100), 'orange').save(art)
            card = preview_card('creature', None)
            card['art'] = 'art.png'
            manifest = root/'manifest.json'
            manifest.write_text(json.dumps({'cards': [card]}))
            destination = root/'preview.png'
            request = dict(manifest_path=str(manifest), card_id=card['id'], allowed_roots=[directory],
                           width=900, border_settings={'style': 'black', 'width_mm': 1.2}, destination=str(destination))
            preview(request)
            expected, report = render(card, art, dpi=600)
            expected = expected.resize((900, 1260), Image.Resampling.LANCZOS)
            expected, _ = finish(expected, request['border_settings'], report, card)
            with Image.open(destination) as actual:
                self.assertEqual(actual.size, (900, 1260))
                self.assertTrue(actual.info['icc_profile'])
                self.assertIsNone(ImageChops.difference(actual.convert('RGB'), expected.convert('RGB')).getbbox())
            self.assertTrue(json.loads(destination.with_suffix('.report.json').read_text())['preview'])
            broken = {**request, 'manifest_path': str(root/'missing.json')}
            result = preview_batch([broken, request])
            self.assertIn('error', result['results'][0])
            self.assertEqual(result['results'][1]['image_path'], str(destination))

    def test_mse_batch_exports_only_the_requested_cards_without_black_white_probes(self):
        card = preview_card('creature', None)
        card['frame_style'] = {'mse': {'stylesheet': 'preview-test'}}
        other = {**card, 'name': 'Second preview'}
        meta = {'width': 744, 'missing_fonts': [], 'alias': True, 'name': 'Test'}
        outputs = [Image.new('RGBA', (900, 1260), 'red'), Image.new('RGBA', (900, 1260), 'blue')]
        with patch.object(mse, 'template', return_value=meta), patch.object(mse, 'sync'), \
             patch.object(mse, 'art_box', return_value={'box': [0, 0, 100, 140]}), \
             patch.object(mse, 'prepared_art', return_value=Image.new('RGB', (100, 140))), \
             patch.object(mse, 'symbol_file', return_value='symbol'), \
             patch.object(mse, 'run_mse', return_value=(outputs, [])) as run:
            results = mse.render_previews([(card, 'first.png'), (other, 'second.png')], 900)
        self.assertEqual(run.call_count, 1)
        self.assertEqual(set(run.call_args.args[1]), {'image1', 'image2'})
        self.assertEqual(run.call_args.args[0].count('\ncard:'), 2)
        self.assertEqual([image.size for image, _ in results], [(900, 1260)]*2)
        self.assertTrue(all(report['preview'] and report['footer_text'] is False for _, report in results))

    def test_mse_preview_refuses_missing_fonts(self):
        card = preview_card('creature', None)
        card['frame_style'] = {'mse': {'stylesheet': 'preview-test'}}
        with patch.object(mse, 'template', return_value={'name': 'Test', 'missing_fonts': ['Missing']}), \
             patch.object(mse, 'run_mse') as run:
            with self.assertRaisesRegex(mse.MSEError, 'Missing'):
                mse.render_preview(card, 'art.png')
        run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
