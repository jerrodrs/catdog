"""Dedicated Saga chapter track with exact Oracle text and measured compact rows."""
import math,re
from PIL import ImageDraw
from .typography import cap_center,centered_text
from .template_sets import rules_inset,rules_bottom
from .frames import text_bottom

CHAPTER=re.compile(r'^([IVXLCDM]+(?:\s*,\s*[IVXLCDM]+)*)\s+[—–-]\s*(.*)$')
ROMAN=re.compile(r'M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})')

def blocks(text):
    from .render import LayoutError
    result=[]
    for line in text.split('\n'):
        match=CHAPTER.match(line)
        if match:
            labels=[label.strip() for label in match[1].split(',')]
            if any(not ROMAN.fullmatch(label) for label in labels):raise LayoutError('Invalid Saga chapter numeral')
            result.append({'chapters':labels,'text':match[2],'raw':line})
        elif result and line.lstrip().startswith(('•','◦')) and result[-1]['chapters']:
            result[-1]['text']+='\n'+line;result[-1]['raw']+='\n'+line
        else:result.append({'chapters':[],'text':line,'raw':line})
    if not any(b['chapters'] for b in result):raise LayoutError('Saga requires at least one Roman-numeral chapter ability.')
    return result

def text_plan(card):
    from .render import wrap,LayoutError
    from .geometry import BODY_SIZES,planning_type_top
    boundary=planning_type_top(card,1100);top=boundary+118;bottom=text_bottom(card)
    source=blocks(card['oracle_text'])
    inset=rules_inset(card);bottom=rules_bottom(card,bottom)
    for size in BODY_SIZES:
        scale=size/64;leading=math.ceil(size*1.13);gap=round(24*scale);y=top;rows=[]
        for block in source:
            left=238 if block['chapters'] else 106+inset
            lines=wrap(block['text'],size,1394-inset-left,italic_phrases=card.get('italic_phrases',[]))
            height=max(len(lines)*leading,(len(block['chapters'])*70-8)*scale if block['chapters'] else 0)
            rows.append({**block,'left':left,'top':y,'height':height,'lines':lines})
            y+=height+gap
        if rows:y-=gap
        flavor=wrap(card.get('flavor_text',''),size,1288-2*inset,True);flavor_gap=round(38*scale) if rows and flavor else 0
        flavor_top=y+flavor_gap;height=flavor_top+len(flavor)*leading-top
        if height<=bottom-top:return {'size':size,'leading':leading,'rules':[line for row in rows for line in row['lines']],'flavor':flavor,'gap':flavor_gap,'top':top,'bottom':bottom,'height':height,'type_top':boundary,'saga_blocks':rows,'flavor_top':flavor_top,'chapter_gap':gap}
    raise LayoutError('Saga chapters + flavour overflow within the 40% height limit at the 36px readability floor. Retain all Oracle text.')

def draw(image,card,plan,alignment):
    from .render import font,fitted,symbol,advance
    from .template_sets import text_color,layout_style
    from .frames import CONFIG
    ink=text_color(card);options=layout_style(card);colors=card.get('colors',[]);key=colors[0] if len(colors)==1 else 'M' if colors else 'C'
    palette=card.get('frame_style',{}).get('palettes',CONFIG['colors'])[key];rim=options.get('rail_color',palette['rim']);highlight=options.get('rail_highlight',palette['highlight']);fill=options.get('panel_color',CONFIG['panel_fill'])
    scale=plan['size']/64;d=ImageDraw.Draw(image);chapters=[row for row in plan['saga_blocks'] if row['chapters']]
    if chapters:
        d.line((162,chapters[0]['top']+31*scale,162,chapters[-1]['top']+(len(chapters[-1]['chapters'])*70-39)*scale),fill=highlight,width=max(2,round(4*scale)))
    def lines_at(lines,left,top):
        y=top
        for line in lines:
            x=left;baseline=round(y)+font('body',plan['size']).getmetrics()[0]
            for token,role in line:
                if token.startswith('{'):
                    diameter=round(plan['size']*.82);center=cap_center(font('body',plan['size']),baseline);sy=round(center-(diameter+1)/2)
                    image.alpha_composite(symbol(token[1:-1],diameter),(round(x),sy));alignment.setdefault('inline_symbols',[]).append({'token':token,'disc_center_y':sy+(diameter+1)/2,'text_cap_center_y':center,'baseline':baseline})
                else:ImageDraw.Draw(image).text((round(x),baseline),token,font=font(role,plan['size']),fill=ink,anchor='ls')
                x+=advance(token,role,plan['size'])
            y+=plan['leading']
    for index,row in enumerate(plan['saga_blocks']):
        if index:
            divider=row['top']-plan['chapter_gap']/2;d.line((238,divider,1394,divider),fill=highlight,width=1)
        for number,label in enumerate(row['chapters']):
            y=row['top']+number*70*scale;half=48*scale;h=62*scale;cut=13*scale
            points=[(162-half+cut,y),(162+half-cut,y),(162+half,y+h/2),(162+half-cut,y+h),(162-half+cut,y+h),(162-half,y+h/2)]
            d.polygon(points,fill=fill,outline=rim,width=max(2,round(3*scale)))
            bounds=(162-half+8*scale,y+3*scale,162+half-8*scale,y+h-3*scale)
            face=fitted('title',label,round(plan['size']*.9),max(20,round(plan['size']*.5)),bounds[2]-bounds[0]);centered_text(d,bounds,label,face,ink,align='center')
            alignment.setdefault('saga_chapters',[]).append({'chapter':label,'box':[162-half,y,162+half,y+h],'text':row['text']})
        lines_at(row['lines'],row['left'],row['top'])
    if plan['flavor']:
        d.line((106,plan['flavor_top']-plan['gap']/2,1394,plan['flavor_top']-plan['gap']/2),fill=highlight,width=2);lines_at(plan['flavor'],106+rules_inset(card),plan['flavor_top'])
