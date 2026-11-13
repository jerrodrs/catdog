"""Measured card geometry and bounded, content-fitted rules panels."""
import re
from .frames import TITLE_BOX, ALIAS_TEXT_BOX, ALIAS_BOX, type_box, PANEL_BOTTOM, STATS_BOX

MAX_RULES_HEIGHT=840  # 40% of the 2100px card, including the type bar.
BODY_SIZES=tuple(range(64,35,-2))


def planning_type_top(card,legacy):
    minimum=PANEL_BOTTOM-MAX_RULES_HEIGHT-boxes(card,0)['type'][1]
    return max(minimum,legacy) if style(card).get('rules_sizing','fit')=='full' else minimum


def style(card):
    from .template_sets import layout_style
    return layout_style(card)


def boxes(card,type_top):
    from .render import fitted,font,fitted_title
    from .typography import ink_bounds
    options=style(card)
    title=TITLE_BOX
    if options.get('title_padding') is not None:
        from .template_sets import fit_bar,text_inset
        left=148 if card.get('face_label') else 94
        costs=re.findall(r'\{[^}]+\}',card.get('mana_cost',''))
        cut=text_inset(card,'title',{'title':fit_bar(card,'title',title)})
        width=(1406-len(costs)*76-24 if costs else 1406)-left-2*cut
        face=fitted_title(card.get('display_name') or card['name'],width)
        bounds=ink_bounds('T',face)
        height=max(bounds[3]-bounds[1]+2*max(options['title_padding'],options.get('rail_width',12)+4),104 if costs else 88)
        title=(58,120-height/2,1442,120+height/2)
    offset=options.get('title_offset_y',0)
    title=(title[0],title[1]+offset,title[2],title[3]+offset)
    from .template_sets import fit_bar,stats_box
    # Thick or double rails eat into a bar: grow it until the lettering and symbols clear them.
    title=fit_bar(card,'title',title)
    if title[1]<18:
        from .render import LayoutError
        raise LayoutError('The title bar is too close to the card edge. Reduce padding or move it down.')
    alias_height=68
    if options.get('alias_padding') is not None:
        face=fitted('alias',card['name'],45,34,1196)
        bounds=ink_bounds(card['name'],face)
        alias_height=max(48,bounds[3]-bounds[1]+2*max(options['alias_padding'],options.get('rail_width',12)+2))
    alias_height=fit_bar(card,'alias',(96,title[3]-8,1404,title[3]+alias_height),floor=title[3])[3]-title[3]
    alias_text=(152,title[3],1348,title[3]+alias_height)
    alias=(96,title[3]-8,1404,title[3]+alias_height)
    type_bounds=type_box(type_top)
    if options.get('type_padding') is not None:
        face=fitted('title',card['type_line'],57,43,1172 if card.get('face_label')=='back' and card.get('colors') else 1228)
        bounds=ink_bounds('T',face)
        height=bounds[3]-bounds[1]+2*max(options['type_padding'],options.get('rail_width',12)+4)
        type_bounds=(58,type_top+90-height,1442,type_top+90)
    type_bounds=fit_bar(card,'type',type_bounds)
    result={'title':title,'alias':alias,'alias_text':alias_text,'type':type_bounds}
    if 'power' in card:
        x,y=options.get('stats_x',STATS_BOX[0]),options.get('stats_y',STATS_BOX[1])
        width,height=options.get('stats_width',266),options.get('stats_height',102)
        if x+width>1460 or y+height>2080:
            from .render import LayoutError
            raise LayoutError('Keep the power/toughness box within the card edges.')
        result['stats']=stats_box(card,(x,y,x+width,y+height))
    return result


def apply(card,plan):
    from .render import PROFILES
    options=style(card)
    base=plan.get('type_top',PROFILES[card.get('profile','standard')])
    minimum=PANEL_BOTTOM-MAX_RULES_HEIGHT-boxes(card,0)['type'][1]
    latest=plan['bottom']-plan['height']-118
    target=latest if options.get('rules_sizing','fit')=='fit' else max(base,minimum)
    if options.get('rules_offset_y') is not None:target=min(base+options['rules_offset_y'],latest)
    target=max(minimum,target)
    if target>latest:
        from .render import LayoutError
        raise LayoutError('Rules cannot fit within the 40% card-height limit at the 36px readability floor.')
    delta=target-base
    if delta:
        plan['top']+=delta
        for block in plan.get('ability_blocks',[]):block['top']+=delta
        for block in plan.get('saga_blocks',[]):block['top']+=delta
        for block in plan.get('class_blocks',[]):
            block['top']+=delta
            if 'band_top' in block:block['band_top']+=delta
        if 'flavor_top' in plan:plan['flavor_top']+=delta
    plan['type_top']=target
    result=boxes(card,target)
    result['rules_panel']=(58,result['type'][1],1442,PANEL_BOTTOM)
    if options.get('border_mode')=='bordered':
        has_alias=bool(card.get('display_name') and card['display_name']!=card['name'])
        top=(result['alias'][3] if has_alias else result['title'][3])+22
        bottom=result['type'][1]-22
        if bottom-top<250:
            from .render import LayoutError
            raise LayoutError('The selected frame padding leaves too little artwork space.')
        result['art']=(94,round(top),1406,round(bottom))
    else:result['art']=(0,0,1500,2100)
    return result
