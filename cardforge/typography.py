"""Position text by visible glyph bounds, independently of font ascender metrics."""


def ink_bounds(text, face):
    mask, offset = face.getmask2(text, mode='L', anchor='ls')
    box = mask.getbbox()
    if box is None:
        return (0, 0, 0, 0)
    return tuple(box[i] + offset[i % 2] for i in range(4))


def centered_origin(text, face, box, align='left', vertical_reference=None):
    left, top, right, bottom = ink_bounds(text, face)
    if vertical_reference is not None:
        _, top, _, bottom = ink_bounds(vertical_reference, face)
    x0, y0, x1, y1 = box
    x = x0-left if align == 'left' else (x0+x1-left-right)/2
    y = (y0+y1-top-bottom)/2
    # Freeze rounding so exports and alignment measurements agree.
    return round(x), round(y)


def centered_text(draw, box, text, face, fill, align='left', vertical_reference=None, **kwargs):
    x, y = centered_origin(text, face, box, align, vertical_reference)
    draw.text((x, y), text, font=face, fill=fill, anchor='ls', **kwargs)
    bounds = ink_bounds(text, face)
    return [bounds[0]+x, bounds[1]+y, bounds[2]+x, bounds[3]+y]


def cap_center(face, baseline):
    _, top, _, bottom = ink_bounds('H', face)
    return baseline + (top+bottom)/2
