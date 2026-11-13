"""Dedicated Class level track: exact Oracle text with a level band ("{cost}: Level N") above each gained ability."""
import math,re
from PIL import Image,ImageColor,ImageDraw
from .typography import cap_center,centered_text
from .template_sets import rules_inset,rules_bottom

LEVEL=re.compile(r'^((?:\{[^}]+\})+):\s*Level\s+(\d+)$')
SYMBOL=re.compile(r'\{[^}]+\}')

def blocks(text):
    """Level 1 lines (reminder + abilities) stay plain; each 'COST: Level N' header owns the lines after it."""
    from .render import LayoutError
    result=[]
    for line in text.split('\n'):
        match=LEVEL.match(line.strip())
        if match:result.append({'kind':'level','cost':match[1],'level':int(match[2]),'text':'','raw':line})
        elif result and result[-1]['kind']=='level' and not result[-1]['text']:result[-1]['text']=line;result[-1]['raw']+='\n'+line
        else:result.append({'kind':'text','text':line,'raw':line})
    levels=[b['level'] for b in result if b['kind']=='level']
    if not levels:raise LayoutError('Class requires at least one "{cost}: Level N" header.')
    if levels!=list(range(2,2+len(levels))):raise LayoutError('Class levels must run in order from Level 2.')
    if any(b['kind']=='level' and not b['text'].strip() for b in result):raise LayoutError('Every Class level needs its ability text.')
    return result

def text_plan(card):
    from .render import wrap,LayoutError
    from .geometry import BODY_SIZES,planning_type_top
    boundary=planning_type_top(card,1100);top=boundary+118;bottom=1900 if 'power' in card else 1940
    source=blocks(card['oracle_text'])
    inset=rules_inset(card);bottom=rules_bottom(card,bottom);left=106+inset;width=1288-2*inset
    for size in BODY_SIZES:
        scale=size/64;leading=math.ceil(size*1.13);gap=round(18*scale);band=round(66*scale);band_gap=round(18*scale);y=top;rows=[]
        for block in source:
            lines=wrap(block['text'],size,width,italic_phrases=card.get('italic_phrases',[]))
            if block['kind']=='level':
                y+=round(8*scale)
                rows.append({**block,'left':left,'band_top':y,'band_height':band,'top':y+band+band_gap,'height':band+band_gap+len(lines)*leading,'lines':lines})
                y+=band+band_gap+len(lines)*leading+gap
            else:
                rows.append({**block,'left':left,'top':y,'height':len(lines)*leading,'lines':lines})
                y+=len(lines)*leading+gap
        if rows:y-=gap
        flavor=wrap(card.get('flavor_text',''),size,width,True);flavor_gap=round(38*scale) if rows and flavor else 0
        flavor_top=y+flavor_gap;height=flavor_top+len(flavor)*leading-top
        if height<=bottom-top:return {'size':size,'leading':leading,'rules':[line for row in rows for line in row['lines']],'flavor':flavor,'gap':flavor_gap,'top':top,'bottom':bottom,'height':height,'type_top':boundary,'class_blocks':rows,'flavor_top':flavor_top}
    raise LayoutError('Class levels + flavour overflow within the 40% height limit at the 36px readability floor. Retain all Oracle text.')

def draw(image,card,plan,alignment):
    from .render import font,fitted,symbol,advance
    from .template_sets import text_color,layout_style
    from .frames import CONFIG
    ink=text_color(card);options=layout_style(card);colors=card.get('colors',[]);key=colors[0] if len(colors)==1 else 'M' if colors else 'C'
    palette=card.get('frame_style',{}).get('palettes',CONFIG['colors'])[key];rim=options.get('rail_color',palette['rim']);highlight=options.get('rail_highlight',palette['highlight']);fill=options.get('panel_color',CONFIG['panel_fill'])
    size=plan['size'];scale=size/64;d=ImageDraw.Draw(image);body=font('body',size)
    right=1394-rules_inset(card)
    def lines_at(lines,left,top):
        y=top
        for line in lines:
            x=left;baseline=round(y)+body.getmetrics()[0]
            for token,role in line:
                if token.startswith('{'):
                    diameter=round(size*.82);center=cap_center(body,baseline);sy=round(center-(diameter+1)/2)
                    image.alpha_composite(symbol(token[1:-1],diameter),(round(x),sy));alignment.setdefault('inline_symbols',[]).append({'token':token,'disc_center_y':sy+(diameter+1)/2,'text_cap_center_y':center,'baseline':baseline})
                else:ImageDraw.Draw(image).text((round(x),baseline),token,font=font(role,size),fill=ink,anchor='ls')
                x+=advance(token,role,size)
            y+=plan['leading']
    for row in plan['class_blocks']:
        if row['kind']=='level':
            y0=row['band_top'];h=row['band_height'];y1=y0+h;left=row['left'];stroke=max(2,round(3*scale))
            # The level band: a faint rim-tinted bar between rails, the cost on the left and a LEVEL cartouche on the right.
            tint=Image.new('RGBA',image.size,(0,0,0,0));ImageDraw.Draw(tint).rectangle((left,y0,right,y1),fill=ImageColor.getrgb(rim)[:3]+(34,));image.alpha_composite(tint);d=ImageDraw.Draw(image)
            d.line((left,y0,right,y0),fill=highlight,width=max(1,round(2*scale)));d.line((left,y1,right,y1),fill=highlight,width=max(1,round(2*scale)))
            label=f"LEVEL {row['level']}";face=fitted('title',label,round(size*.78),max(20,round(size*.5)),round(320*scale))
            box=face.getbbox(label);text_w=box[2]-box[0];cut=round(16*scale);pad=round(26*scale)
            cx1=right;cx0=right-text_w-2*pad-cut
            points=[(cx0+cut,y0),(cx1,y0),(cx1,y1),(cx0+cut,y1),(cx0,y0+h/2)]
            d.polygon(points,fill=fill,outline=rim,width=stroke)
            centered_text(d,(cx0+cut,y0+3*scale,cx1,y1-3*scale),label,face,ink,align='center')
            diameter=round(size*.82);x=left+round(6*scale)
            capc=y0+h/2
            for token in SYMBOL.findall(row['cost']):
                image.alpha_composite(symbol(token[1:-1],diameter),(round(x),round(capc-(diameter+1)/2)));x+=diameter+round(6*scale)
            colon_base=round(capc-cap_center(body,0))
            d.text((round(x+2*scale),colon_base),':',font=body,fill=ink,anchor='ls')
            alignment.setdefault('class_levels',[]).append({'level':row['level'],'cost':row['cost'],'band':[left,y0,right,y1],'label_box':[cx0,y0,cx1,y1],'text':row['text']})
        lines_at(row['lines'],row['left'],row['top'])
    if plan['flavor']:
        d.line((106,plan['flavor_top']-plan['gap']/2,1394,plan['flavor_top']-plan['gap']/2),fill=highlight,width=2);lines_at(plan['flavor'],106+rules_inset(card),plan['flavor_top'])
