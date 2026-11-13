import copy,json,subprocess,sys,tempfile,unittest
from pathlib import Path
from cardforge.render import ROOT,render,validate,LayoutError,text_plan
from cardforge.template_sets import validate_set,layout_kind,layout_style
from cardforge.saga import blocks

class SagaTests(unittest.TestCase):
    def saga(self):return {'id':'chapter-proof','name':'Chapter Proof','layout':'saga','type_line':'Enchantment — Saga','oracle_text':'Read ahead (Choose a chapter.)\nI, II — Create a Treasure token.\nIII — Draw two cards.','colors':['R']}

    def test_grouped_chapters_and_reminder_are_retained_and_drawn_once(self):
        card=self.saga();card['flavor_text']='Every tale has a final page.'
        parsed=blocks(card['oracle_text']);self.assertEqual('\n'.join(b['raw'] for b in parsed),card['oracle_text'])
        image,report=render(card);self.assertEqual([c['chapter'] for c in report['alignment']['saga_chapters']],['I','II','III'])
        plan=text_plan(card);self.assertEqual(len([r for r in plan['saga_blocks'] if r['text']=='Create a Treasure token.']),1);self.assertTrue(plan['flavor']);self.assertLessEqual(report['geometry']['rules_panel'][3]-report['geometry']['rules_panel'][1],840)
        self.assertEqual(image.tobytes(),render(card)[0].tobytes())

    def test_urabrask_import_preserves_both_faces_and_every_saga_chapter(self):
        source=json.loads((ROOT/'data/urabrask.scryfall.json').read_text())
        with tempfile.TemporaryDirectory() as d:
            out=Path(d)/'manifest.json';subprocess.run([sys.executable,'-m','cardforge','import',str(ROOT/'data/urabrask.scryfall.json'),'--out',str(out)],check=True,capture_output=True)
            card=json.loads(out.read_text())['cards'][0];self.assertEqual(card['layout'],'transform');self.assertEqual(card['faces'][1]['layout'],'saga')
            for saved,original in zip(card['faces'],source['card_faces']):self.assertEqual(saved['oracle_text'],original['oracle_text'])
            from cardforge.faces import face_cards
            back=face_cards(card)[1];self.assertEqual(layout_kind(back),'saga');_,report=render(back)
            self.assertEqual([c['chapter'] for c in report['alignment']['saga_chapters']],['I','II','III']);self.assertIn('front face up',back['oracle_text']);self.assertLessEqual(report['geometry']['rules_panel'][3]-report['geometry']['rules_panel'][1],840)

    def test_saga_creature_keeps_stats_and_static_abilities(self):
        card={**self.saga(),'type_line':'Enchantment Creature — Avatar Saga','power':'5','toughness':'5'};card['oracle_text']+='\nFlying'
        _,report=render(card);self.assertIn('statistics',report['alignment']);self.assertEqual(text_plan(card)['saga_blocks'][-1]['text'],'Flying')

    def test_old_templates_inherit_enchantment_style_and_new_templates_require_saga(self):
        config=json.loads((ROOT/'examples/frame-set.json').read_text());self.assertEqual(config['schema_version'],3)
        for version in (1,2):
            legacy=copy.deepcopy(config);legacy['schema_version']=version;del legacy['layouts']['saga'];legacy['layouts']['enchantment']['panel_alpha']=211
            validate_set(legacy);card={**self.saga(),'frame_style':legacy};self.assertEqual(layout_style(card)['panel_alpha'],211);render(card)
        del config['layouts']['saga']
        with self.assertRaises(LayoutError):validate_set(config)

    def test_invalid_or_overflowing_sagas_fail_instead_of_dropping_text(self):
        for card in [{**self.saga(),'oracle_text':'No chapter.'},{**self.saga(),'type_line':'Artifact'},{**self.saga(),'oracle_text':'IIV — Invalid numeral.'},{**self.saga(),'oracle_text':'I — '+('Draw a card. '*1000)}]:
            with self.assertRaises(LayoutError):render(card)

if __name__=='__main__':unittest.main()
