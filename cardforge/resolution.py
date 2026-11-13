"""Scale drawing operations, not finished lettering, on a fixed logical canvas.

Layout is always measured in the approved 1500 x 2100 coordinate system.
Fonts are rasterized directly at output resolution; artwork is sampled separately.
"""
from contextvars import ContextVar
from contextlib import contextmanager
from PIL import Image, ImageDraw

SCALE = ContextVar('cardforge_output_scale', default=1)

@contextmanager
def resolution(dpi):
    if dpi not in (600, 1200):
        raise ValueError('Card rendering supports 600 or 1200 DPI.')
    token = SCALE.set(dpi // 600)
    try:
        yield
    finally:
        SCALE.reset(token)

def points(value, scale):
    if isinstance(value, (list, tuple)):
        return tuple(points(v, scale) for v in value)
    return value * scale

class ScaledDraw:
    def __init__(self, image, mode=None):
        self.scale = image.scale
        self.draw = ImageDraw.Draw(image.native, mode)
    def text(self, xy, text, fill=None, font=None, **kwargs):
        if font is not None:
            font = font.font_variant(size=round(font.size * self.scale))
        for name in ('stroke_width','spacing'):
            if name in kwargs: kwargs[name] = round(kwargs[name] * self.scale)
        return self.draw.text(points(xy,self.scale),text,fill=fill,font=font,**kwargs)
    def __getattr__(self, name):
        if name not in ('line','polygon','rectangle','rounded_rectangle','ellipse','pieslice','arc','point'):
            raise AttributeError(name)
        def paint(xy, *args, **kwargs):
            for key in ('width','radius'):
                if key in kwargs: kwargs[key] = round(kwargs[key] * self.scale)
            if name in ('line','polygon','rectangle','rounded_rectangle','ellipse','arc','pieslice') and 'width' not in kwargs:
                kwargs['width'] = self.scale
            return getattr(self.draw,name)(points(xy,self.scale),*args,**kwargs)
        return paint

class Surface:
    def __init__(self, native, size, scale):
        self.native, self.size, self.scale = native, tuple(size), scale
    @property
    def width(self): return self.size[0]
    @property
    def height(self): return self.size[1]
    def getdraw(self, mode=None): return ScaledDraw(self,mode)
    def alpha_composite(self, other, dest=(0,0), source=(0,0)):
        other = unwrap(other)
        return self.native.alpha_composite(other, tuple(round(v*self.scale) for v in dest), tuple(round(v*self.scale) for v in source))
    def paste(self, other, box=None, mask=None):
        return self.native.paste(unwrap(other) if hasattr(other,'size') else other, points(box or (0,0),self.scale), unwrap(mask) if mask is not None else None)
    def __getattr__(self, name): return getattr(self.native,name)

def unwrap(image): return image.native if isinstance(image,Surface) else image

def canvas(mode, size, color=None):
    scale=SCALE.get()
    image=Image.new(mode,tuple(round(v*scale) for v in size),color)
    return Surface(image,size,scale) if scale!=1 else image

def wrap(image,size):
    scale=SCALE.get()
    return Surface(image,size,scale) if scale!=1 else image
