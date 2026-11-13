import json,tempfile,unittest
from pathlib import Path
from PIL import Image
from cardforge.render import render,save_card
from cardforge.template_sets import preview_card
class ResolutionTests(unittest.TestCase):
    def test_native_fonts_are_rasterized_at_1200_without_changing_logical_layout(self):
        card=preview_card('creature',None)
        low,a=render(card,dpi=600);high,b=render(card,dpi=1200)
        self.assertEqual(high.size,(3000,4200));self.assertEqual(a['geometry'],b['geometry']);self.assertEqual(a['body_font_pt'],b['body_font_pt']);self.assertEqual(b['body_font_px'],a['body_font_px']*2)
        self.assertNotEqual(high.crop((180,110,1100,360)).tobytes(),low.resize(high.size,Image.Resampling.LANCZOS).crop((180,110,1100,360)).tobytes())
    def test_special_layouts_use_the_same_scaled_drawing_pipeline(self):
        for kind in ('planeswalker','adventure','prepare','saga'):
            with self.subTest(kind=kind):
                image,report=render(preview_card(kind,None),dpi=1200)
                self.assertEqual(image.size,(3000,4200));self.assertEqual(report['dpi'],1200)
    def test_high_resolution_source_art_and_rgb_profile_are_retained(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);art=root/'art.png';Image.new('RGB',(3000,4200),'orange').save(art)
            card=preview_card('land',None);target=save_card(card,root/'out',art,dpi=1200)
            report=json.loads(target.with_suffix('.report.json').read_text());self.assertFalse(report['art_resolution']['enlarged']);self.assertEqual(report['art_resolution']['effective_ppi'],1200)
            with Image.open(target) as image:self.assertTrue(image.info['icc_profile']);self.assertEqual(image.size,(3000,4200))
    def test_unknown_resolution_rejected(self):
        with self.assertRaises(ValueError):render(preview_card('creature',None),dpi=900)
if __name__=='__main__':unittest.main()
