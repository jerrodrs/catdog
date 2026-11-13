import copy,json,subprocess,sys,tempfile,unittest
from pathlib import Path
from cardforge.render import ROOT,render,validate,LayoutError,text_plan
from cardforge.template_sets import layout_kind,layout_style
from cardforge.class_layout import blocks

ARTISTS_TALENT='(Gain the next level as a sorcery to add its ability.)\nWhenever you cast a noncreature spell, you may discard a card. If you do, draw a card.\n{2}{R}: Level 2\nNoncreature spells you cast cost {1} less to cast.\n{2}{R}: Level 3\nIf a source you control would deal noncombat damage to an opponent or a permanent an opponent controls, it deals that much damage plus 2 instead.'


class ClassTests(unittest.TestCase):
    def card(self):return {'id':'artists-talent','name':"Artist's Talent",'layout':'class','mana_cost':'{1}{R}','type_line':'Enchantment — Class','oracle_text':ARTISTS_TALENT,'colors':['R'],'rarity':'rare'}

    def test_every_level_and_reminder_is_retained_and_drawn_once(self):
        card=self.card();card['flavor_text']='Every signature is a brushstroke.'
        parsed=blocks(card['oracle_text']);self.assertEqual('\n'.join(b['raw'] for b in parsed),card['oracle_text'])
        image,report=render(card);levels=report['alignment']['class_levels']
        self.assertEqual([(l['level'],l['cost']) for l in levels],[(2,'{2}{R}'),(3,'{2}{R}')])
        plan=text_plan(card);self.assertEqual(len([r for r in plan['class_blocks'] if r['text']=='Noncreature spells you cast cost {1} less to cast.']),1);self.assertTrue(plan['flavor'])
        # Bands sit inside the rules panel, in order, and never overlap their ability text.
        panel=report['geometry']['rules_panel']
        for level,row in zip(levels,[r for r in plan['class_blocks'] if r['kind']=='level']):
            self.assertGreaterEqual(level['band'][1],panel[1]);self.assertLessEqual(level['band'][3],panel[3]);self.assertEqual(level['band'][3]-level['band'][1],row['band_height']);self.assertGreater(row['top']-row['band_top'],row['band_height'])
        self.assertLess(levels[0]['band'][3],levels[1]['band'][1])
        self.assertEqual(layout_kind(card),'class');self.assertEqual(image.tobytes(),render(card)[0].tobytes())

    def test_class_inherits_enchantment_style_from_existing_frame_sets(self):
        config=json.loads((ROOT/'examples/frame-set.json').read_text())
        config.setdefault('layouts',{}).setdefault('enchantment',{})['panel_alpha']=211
        from cardforge.template_sets import validate_set
        card={**self.card(),'frame_style':validate_set(config)};self.assertEqual(layout_style(card)['panel_alpha'],211);render(card)

    def test_malformed_levels_and_flattening_are_rejected(self):
        for text in ('Draw a card.','{2}: Level 3\nDraw a card.','{2}{R}: Level 2'):
            with self.assertRaises(LayoutError):validate({**self.card(),'oracle_text':text})
        with self.assertRaises(LayoutError):validate({**self.card(),'type_line':'Enchantment'})
        with self.assertRaises(LayoutError):validate({**self.card(),'type_line':'Battle — Siege','layout':'normal'})

    def test_scryfall_class_import(self):
        item={'object':'card','id':'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','oracle_id':'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','name':"Artist's Talent",'layout':'class','mana_cost':'{1}{R}','type_line':'Enchantment — Class','oracle_text':ARTISTS_TALENT,'colors':['R'],'color_identity':['R'],'rarity':'rare'}
        with tempfile.TemporaryDirectory() as tmp:
            snapshot=Path(tmp)/'card.json';out=Path(tmp)/'manifest.json';snapshot.write_text(json.dumps(item))
            subprocess.run([sys.executable,'-m','cardforge','import',str(snapshot),'--out',str(out)],cwd=ROOT,check=True,capture_output=True)
            card=json.loads(out.read_text())['cards'][0];self.assertEqual(card['layout'],'class');self.assertEqual(card['oracle_text'],ARTISTS_TALENT)
            _,report=render(card);self.assertEqual(len(report['alignment']['class_levels']),2)


if __name__=='__main__':unittest.main()
