"""Same-side Adventure and prepare spells, with independently measured characteristics."""
import math,re
from PIL import Image,ImageDraw
from .typography import centered_text,cap_center


GUTTER=44  # between the inset spell box and the permanent's text column
PAD=24  # inset text padding inside the box's 12px rim


def columns(card):
    """Inset box and main column, measured from the frame's own panel: the box keeps the same margin (the gap between
    the panel rail and the rules text) from the panel rail on its outer side, below the type bar and above the panel's
    real lower edge, including rounded/cut corners and arches. The box and main text split the text area evenly."""
    import numpy as np
    from .template_sets import rules_inset,rules_bottom,layout_style,body_points,rail_depth
    from .geometry import boxes
    style=layout_style(card);depth=rail_depth(style) if card.get('frame_style') else 12
    text_left=106+rules_inset(card);text_right=1500-text_left;margin=max(16,text_left-(78+depth))
    width=round((text_right-text_left-GUTTER)/2);right=card['layout']=='prepare'
    box_left=text_right-width if right else text_left;box_right=box_left+width
    main_left=text_left if right else box_right+GUTTER;main_right=box_left-GUTTER if right else text_right
    # The panel's lower edge does not move with the type bar; find its lowest inside point across the box's span.
    mask=Image.new('L',(1500,2100),0);ImageDraw.Draw(mask).polygon(body_points(style,1100),fill=255)
    rows=np.asarray(mask)>0;reach=depth+margin;span=rows[:,box_left:box_right+1]
    lowest=min(int(np.nonzero(column)[0].max()) for column in span.T if column.any())
    box_bottom=lowest-reach
    stats=boxes(card,0).get('stats') if 'power' in card else None
    if stats and box_right>stats[0]-margin:box_bottom=min(box_bottom,stats[1]-margin)
    main_bottom=rules_bottom(card,1900 if stats and main_right>stats[0] else 1940)
    return {'margin':margin,'box_left':box_left,'box_right':box_right,'box_bottom':box_bottom,'main_left':main_left,'main_width':main_right-main_left,'main_bottom':main_bottom,'spell_width':width-2*PAD,'right':right}


def text_plan(card):
    from .render import wrap,font,fitted,LayoutError
    from .geometry import BODY_SIZES,planning_type_top
    top=planning_type_top(card,740 if card.get('profile')=='dense' else 900)
    spell=card['spell'];costs=re.findall(r'\{([^{}]+)\}',spell.get('mana_cost',''))
    layout=columns(card);inner=layout['spell_width'];main_width=layout['main_width']
    name=spell.get('display_name') or spell['name'];name_width=inner-len(costs)*60-22
    if name_width<150:raise LayoutError('The inset spell mana cost leaves insufficient title space.')
    try:name_font=fitted('title',name,56,40,name_width);name_lines=[name]
    except LayoutError:
        name_font=font('title',44);name_lines=[];line=''
        for word in name.split():
            proposed=(line+' '+word).strip()
            if name_font.getlength(proposed)>name_width:
                if not line:raise LayoutError('Inset spell title cannot fit at the readable font size.')
                name_lines.append(line);line=word
            else:line=proposed
        if line:name_lines.append(line)
        if len(name_lines)>2:raise LayoutError('Inset spell title requires more than two readable lines.')
    alias=bool(spell.get('display_name') and spell['display_name']!=spell['name'])
    name_height=90 if len(name_lines)==1 else 136
    header=name_height+(58 if alias else 0)+72
    # Text starts 28px below the type bar; the box starts one margin below it and ends one margin above the panel edge.
    margin=layout['margin'];bottom=layout['main_bottom'];box_offset=margin-28
    for size in BODY_SIZES:
        leading=math.ceil(size*1.13)
        main=wrap(card['oracle_text'],size,main_width,italic_phrases=card.get('italic_phrases',[]))
        flavor=wrap(card.get('flavor_text',''),size,main_width,True)
        secondary=wrap(spell['oracle_text'],size,inner,italic_phrases=spell.get('italic_phrases',[]))
        secondary_flavor=wrap(spell.get('flavor_text',''),size,inner,True)
        main_height=(len(main)+len(flavor))*leading+(38 if main and flavor else 0)
        spell_height=header+PAD+(len(secondary)+len(secondary_flavor))*leading+(38 if secondary and secondary_flavor else 0)+PAD+12
        # Express the box's needs against the main column's bottom so rules_sizing 'fit' can place the type bar.
        height=max(main_height,box_offset+spell_height+bottom-layout['box_bottom'])
        if height<=bottom-(top+118):
            return {'size':size,'leading':leading,'rules':[],'flavor':[],'gap':0,'top':top+118,'bottom':bottom,'height':height,'type_top':top,'subset_layout':True,'main_lines':main,'main_flavor':flavor,'spell_lines':secondary,'spell_flavor':secondary_flavor,'name_lines':name_lines,'name_font_size':name_font.size,'name_height':name_height,'spell_header_height':header,'spell_alias':alias,'inset_columns':layout}
    raise LayoutError('Permanent and inset spell text overflow within the 40% height limit at the 36px readability floor. Shorten optional flavour; preserve all Oracle text.')


def draw(image,card,plan,alignment):
    from .render import font,fitted,symbol,advance
    from .frames import CONFIG
    from .template_sets import text_color,layout_style
    options=layout_style(card);spell=card['spell'];cols=plan['inset_columns'];right=cols['right'];left=cols['box_left'];end=cols['box_right'];main_left=cols['main_left']
    top=plan['top']-28+cols['margin'];bottom=cols['box_bottom'];inner=cols['spell_width'];colors=spell.get('colors',[]);key=colors[0] if len(colors)==1 else 'M' if colors else 'C'
    palette=card.get('frame_style',{}).get('palettes',CONFIG['colors'])[key]
    ink=text_color(card);panel=options.get('panel_color',CONFIG['panel_fill']);rim=options.get('rail_color',palette['rim']);highlight=options.get('rail_highlight',palette['highlight']);shadow=options.get('rail_shadow',palette['shadow'])
    from .resolution import canvas
    overlay=canvas('RGBA',image.size);d=ImageDraw.Draw(overlay)
    d.rounded_rectangle((left,top,end,bottom),radius=16,fill=shadow)
    d.rounded_rectangle((left+3,top+3,end-3,bottom-3),radius=14,fill=rim)
    d.rounded_rectangle((left+7,top+7,end-7,bottom-7),radius=12,outline=highlight,width=2)
    d.rounded_rectangle((left+12,top+12,end-12,bottom-12),radius=9,fill=panel)
    name_bottom=top+plan['name_height'];type_top=name_bottom+(58 if plan['spell_alias'] else 0)
    d.rectangle((left+12,top+12,end-12,name_bottom),fill=palette['header'])
    d.rectangle((left+12,type_top,end-12,type_top+72),fill=palette['header']);d.line((left+12,type_top+72,end-12,type_top+72),fill=rim,width=4)
    image.alpha_composite(overlay);d=ImageDraw.Draw(image)
    costs=re.findall(r'\{([^{}]+)\}',spell.get('mana_cost',''));mana_left=end-PAD-len(costs)*60
    name_font=font('title',plan['name_font_size']);name_bounds=[]
    for i,line in enumerate(plan['name_lines']):
        area=(left+PAD,top+6+i*56,mana_left-22 if costs else end-PAD,top+(plan['name_height'] if len(plan['name_lines'])==1 else 68+i*56))
        name_bounds.append(centered_text(d,area,line,name_font,ink,vertical_reference='T'))
    for i,cost in enumerate(costs):image.alpha_composite(symbol(cost,52),(round(mana_left+i*60),round(top+19)))
    if plan['spell_alias']:
        face=fitted('alias',spell['name'],40,34,inner);centered_text(d,(left+PAD,name_bottom,end-PAD,type_top),spell['name'],face,ink,align='center')
    type_font=fitted('title',spell['type_line'],45,34,inner)
    type_bounds=centered_text(d,(left+PAD,type_top+2,end-PAD,type_top+70),spell['type_line'],type_font,ink,vertical_reference='T')
    def lines_at(lines,x0,y0):
        y=y0
        for line in lines:
            x=x0;baseline=round(y)+font('body',plan['size']).getmetrics()[0]
            for token,role in line:
                if token.startswith('{'):
                    size=round(plan['size']*.82);center=cap_center(font('body',plan['size']),baseline);sy=round(center-(size+1)/2)
                    image.alpha_composite(symbol(token[1:-1],size),(round(x),sy));alignment.setdefault('inline_symbols',[]).append({'token':token,'disc_center_y':sy+(size+1)/2,'text_cap_center_y':center,'baseline':baseline})
                else:ImageDraw.Draw(image).text((round(x),baseline),token,font=font(role,plan['size']),fill=ink,anchor='ls')
                x+=advance(token,role,plan['size'])
            y+=plan['leading']
        return y
    def body(lines,flavor,x,y,width):
        y=lines_at(lines,x,y)
        if flavor:
            if lines:ImageDraw.Draw(image).line((x,y+14,x+width,y+14),fill=highlight,width=2);y+=38
            lines_at(flavor,x,y)
    body(plan['main_lines'],plan['main_flavor'],main_left,plan['top'],cols['main_width'])
    body(plan['spell_lines'],plan['spell_flavor'],left+PAD,top+plan['spell_header_height']+PAD,inner)
    alignment['inset_spell']={'layout':card['layout'],'side':'right' if right else 'left','box':[left,top,end,bottom],'name':spell['name'],'name_ink':name_bounds,'mana_cost':spell.get('mana_cost',''),'type_line':spell['type_line'],'type_ink':type_bounds,'oracle_text':spell['oracle_text'],'main_oracle_text':card['oracle_text']}
