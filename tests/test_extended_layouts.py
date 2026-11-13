import copy
import json
import tempfile
import unittest
from pathlib import Path
from cardforge.render import ROOT, render, save_card, validate, LayoutError
from cardforge.template_sets import validate_set, REQUIRED_LAYOUTS


class ExtendedLayoutTests(unittest.TestCase):
    def setUp(self):
        self.walker={'id':'test-walker','name':'Test Walker','type_line':'Legendary Planeswalker — Test',
                     'mana_cost':'{2}{W}','colors':['W'],'loyalty':'3',
                     'oracle_text':'+1: Draw a card.\n0: Add {W}{W}.\n−2: Create a 1/1 white Cat creature token.'}

    def test_loyalty_rows_retain_costs_and_inline_symbols(self):
        _, report=render(self.walker)
        self.assertEqual([b['cost'] for b in report['alignment']['loyalty_abilities']],['+1','0','−2'])
        self.assertIn('loyalty',report['alignment'])
        self.assertEqual(len(report['alignment']['inline_symbols']),2)
        with self.assertRaises(LayoutError): validate({**self.walker,'loyalty':'-3'})

    def test_default_rules_panels_collapse_and_all_layouts_obey_the_height_cap(self):
        from cardforge.template_sets import preview_card,apply_controls
        short=preview_card('creature',None)
        _,report=render(short)
        self.assertGreater(report['type_top'],1280)
        self.assertEqual(report['body_font_px'],64)
        for mode in ['fit','full']:
            config=apply_controls(json.loads((ROOT/'examples/frame-set.json').read_text()),{'rules_sizing':mode,'type_padding':60,'rules_offset_y':-150})
            for kind in REQUIRED_LAYOUTS:
                _,report=render(preview_card(kind,config))
                panel=report['geometry']['rules_panel']
                self.assertLessEqual(panel[3]-panel[1],840)
                self.assertLessEqual(report['text_height'],report['text_capacity'])

    def test_long_planeswalkers_shrink_text_without_growing_the_panel_or_losing_abilities(self):
        from cardforge.render import text_plan
        card={**self.walker,'oracle_text':'+1: '+('Draw a card, then discard a card. '*4).strip()+'\n−2: '+('Create a 2/2 green Cat creature token. '*4).strip()+'\n−7: '+('You gain 10 life and draw two cards. '*4).strip()}
        plan=text_plan(card)
        self.assertLess(plan['size'],56)
        self.assertGreaterEqual(plan['size'],48)
        self.assertEqual([block['cost'] for block in plan['ability_blocks']],['+1','−2','−7'])
        for block in plan['ability_blocks']:
            actual=' '.join(''.join(token for token,_ in line) for line in block['lines'])
            self.assertEqual(actual,block['text'])
        _,report=render(card)
        self.assertLessEqual(report['geometry']['rules_panel'][3]-report['geometry']['rules_panel'][1],840)
        with self.assertRaises(LayoutError):render({**card,'oracle_text':card['oracle_text']*10})

    def test_ajani_back_compacts_complete_rules_and_flavour_without_enlarging_the_box(self):
        from cardforge.render import text_plan
        snapshot=json.loads((ROOT/'data/ajani-nacatl-pariah.scryfall.json').read_text())
        face=snapshot['card_faces'][1]
        card={key:face[key] for key in ['name','type_line','oracle_text','colors','loyalty']}
        card.update(id='ajani-compact-proof',flavor_text='His grief became their shelter.')
        plan=text_plan(card)
        self.assertLess(plan['size'],48)
        self.assertGreaterEqual(plan['size'],36)
        self.assertTrue(plan['flavor'])
        _,report=render(card)
        self.assertLessEqual(report['geometry']['rules_panel'][3]-report['geometry']['rules_panel'][1],840)
        self.assertLessEqual(plan['height'],plan['bottom']-plan['top'])
        for block in report['alignment']['loyalty_abilities']:
            self.assertLess(block['box'][3]-block['box'][1],78)

    def test_both_faces_are_saved_and_back_has_its_own_loyalty_frame(self):
        front={'id':'front','name':'Test Creature','type_line':'Creature — Cat','oracle_text':'Transform this creature.', 'power':'2','toughness':'2'}
        card={'id':'two-faces','name':'Test Creature','layout':'transform','faces':[front,self.walker]}
        with tempfile.TemporaryDirectory() as directory:
            target=save_card(card,directory)
            back=target.with_name('two-faces-back.png')
            self.assertTrue(back.exists())
            self.assertEqual(len(json.loads(target.with_suffix('.report.json').read_text())['faces']),2)
            self.assertIn('loyalty',json.loads(back.with_suffix('.report.json').read_text())['alignment'])
        with self.assertRaises(LayoutError):validate({**card,'faces':[front]})

    def test_custom_frame_set_requires_every_layout_and_colour_family(self):
        config=json.loads((ROOT/'examples/frame-set.json').read_text())
        validate_set(config)
        for kind in REQUIRED_LAYOUTS:
            bad=copy.deepcopy(config);del bad['layouts'][kind]
            with self.assertRaises(LayoutError):validate_set(bad)
        bad=copy.deepcopy(config);bad['palettes']['G']['header']='#ffffff'
        with self.assertRaises(LayoutError):validate_set(bad)
        _,report=render({**self.walker,'frame_style':config})
        self.assertEqual(report['frame_set'],config['name'])

    def test_frame_controls_preserve_material_and_change_measured_geometry(self):
        from cardforge.template_sets import apply_controls,preview_card
        config=json.loads((ROOT/'examples/frame-set.json').read_text())
        config=apply_controls(config,{'rail_material':'copper','border_mode':'bordered','rules_sizing':'fit','title_padding':40,'type_padding':35,'alias_padding':25})
        card=preview_card('creature',config,['U'],True,True)
        _,report=render(card)
        self.assertEqual(config['style']['rail_color'],'#B97842')
        self.assertGreater(report['geometry']['art'][0],0)
        self.assertGreater(report['type_top'],950)
        self.assertGreater(report['geometry']['title'][3]-report['geometry']['title'][1],132)
        other=copy.deepcopy(config);other['style']['title_padding']=61
        with self.assertRaises(LayoutError):validate_set(other)

    def test_power_toughness_box_moves_resizes_and_centres_ink_without_changing_gameplay(self):
        from cardforge.template_sets import apply_controls,preview_card
        config=apply_controls(json.loads((ROOT/'examples/frame-set.json').read_text()),{'stats_x':920,'stats_y':1920,'stats_width':400,'stats_height':130})
        card=preview_card('creature',config)
        _,report=render(card)
        self.assertEqual(report['geometry']['stats'],(920,1920,1320,2050))
        ink=report['alignment']['statistics']
        self.assertAlmostEqual((ink[0]+ink[2])/2,1120,delta=1)
        self.assertAlmostEqual((ink[1]+ink[3])/2,1985,delta=1)
        self.assertEqual((card['power'],card['toughness']),('2','3'))
        bad=apply_controls(copy.deepcopy(config),{'stats_x':1280})
        with self.assertRaises(LayoutError):render(preview_card('creature',bad))

    def test_adventure_and_prepare_import_preserve_two_characteristic_sets_on_one_face(self):
        import subprocess,sys
        for slug,layout,side in [('bonecrusher-giant','adventure','left'),('emeritus-of-ideation','prepare','right')]:
            source=json.loads((ROOT/'data'/f'{slug}.scryfall.json').read_text())
            with tempfile.TemporaryDirectory() as directory:
                manifest=Path(directory)/'manifest.json'
                subprocess.run([sys.executable,'-m','cardforge','import',str(ROOT/'data'/f'{slug}.scryfall.json'),'--out',str(manifest)],cwd=ROOT,check=True,capture_output=True)
                card=json.loads(manifest.read_text())['cards'][0]
                self.assertEqual(card['layout'],layout)
                self.assertNotIn('faces',card)
                self.assertEqual(card['oracle_text'],source['card_faces'][0]['oracle_text'])
                self.assertEqual(card['spell']['oracle_text'],source['card_faces'][1]['oracle_text'])
                self.assertEqual(card['spell']['mana_cost'],source['card_faces'][1]['mana_cost'])
                _,report=render(card)
                self.assertEqual(report['alignment']['inset_spell']['side'],side)
                self.assertEqual(report['alignment']['inset_spell']['name'],source['card_faces'][1]['name'])
                output=save_card(card,directory)
                self.assertTrue(output.exists())
                self.assertFalse(output.with_name(output.stem+'-back.png').exists())
                self.assertTrue(output.with_suffix('.frame.png').exists())

    def test_inset_spell_box_keeps_even_margins_inside_the_frame_panel(self):
        from cardforge.template_sets import preview_card,rail_depth,layout_style,rules_inset
        config=json.loads((ROOT/'examples/frame-set.json').read_text())
        config.setdefault('style',{}).update(panel_bottom='flat',panel_corners='rounded',panel_corner_size=18,rail_width=4)
        config=validate_set(config)
        land=preview_card('adventure',config);land.update(type_line='Land — Town',mana_cost='',oracle_text='This land enters tapped.\n{T}: Add {R}.');land.pop('power');land.pop('toughness')
        _,report=render(land);left,top,right,bottom=report['alignment']['inset_spell']['box']
        style=layout_style(land);margin=106+rules_inset(land)-(78+rail_depth(style))
        self.assertEqual(left-(78+rail_depth(style)),margin)
        self.assertEqual(top-report['geometry']['type'][3],margin)
        from cardforge.frames import PANEL_BOTTOM,STATS_BOX
        self.assertEqual(PANEL_BOTTOM-rail_depth(style)-bottom,margin)
        # A prepare spell on the stats side stops above the power/toughness box.
        prepare=preview_card('prepare',config);_,report=render(prepare)
        box=report['alignment']['inset_spell']['box'];self.assertLess(box[3],report['alignment']['statistics']['box'][1] if 'box' in report['alignment']['statistics'] else STATS_BOX[1])
        self.assertGreater(box[0],750)

    def test_old_frame_sets_inherit_new_inset_templates_but_new_sets_require_them(self):
        from cardforge.template_sets import preview_card
        config=json.loads((ROOT/'examples/frame-set.json').read_text())
        legacy=copy.deepcopy(config);legacy['schema_version']=1
        for key in ('adventure','prepare'):del legacy['layouts'][key]
        validate_set(legacy)
        for key in ('adventure','prepare'):
            render(preview_card(key,legacy))
        legacy['schema_version']=2
        with self.assertRaises(LayoutError):validate_set(legacy)

    def test_raster_frame_details_are_frozen_and_cannot_cover_gameplay_text(self):
        from PIL import Image
        from cardforge.decorations import load_set
        from cardforge.template_sets import preview_card
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);asset=Image.new('RGBA',(64,64),(255,0,0,0))
            for x in range(8,56):
                for y in range(8,56):asset.putpixel((x,y),(255,0,0,255))
            asset.save(root/'detail.png')
            config=json.loads((ROOT/'examples/frame-set.json').read_text());config['decorations']=[{'image':'detail.png','box':[0,0,1500,2100],'fit':'stretch'}]
            (root/'config.json').write_text(json.dumps(config));loaded=load_set(root/'config.json')
            decorated,report=render(preview_card('creature',loaded))
            plain=copy.deepcopy(loaded);plain['decorations']=[]
            baseline,_=render(preview_card('creature',plain))
            text_top=round(report['type_top']+118)
            self.assertEqual(decorated.crop((110,text_top,1380,1850)).tobytes(),baseline.crop((110,text_top,1380,1850)).tobytes())
            self.assertNotEqual(decorated.crop((300,300,1100,700)).tobytes(),baseline.crop((300,300,1100,700)).tobytes())
            self.assertEqual(decorated.crop((1180,1920,1438,2014)).tobytes(),baseline.crop((1180,1920,1438,2014)).tobytes())
            walker,_=render(preview_card('planeswalker',loaded))
            plain_walker,_=render(preview_card('planeswalker',plain))
            self.assertEqual(walker.crop((1220,1930,1442,2064)).tobytes(),plain_walker.crop((1220,1930,1442,2064)).tobytes())
            asset.putpixel((20,20),(0,0,255,255));asset.save(root/'detail.png')
            with self.assertRaises(LayoutError):validate_set(loaded)
