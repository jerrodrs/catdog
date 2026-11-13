import unittest
from PIL import Image
from cardforge.borders import finish

class BorderTests(unittest.TestCase):
    def test_none_is_pixel_identical_and_does_not_mutate_source(self):
        source=Image.new('RGB',(1500,2100),'orange')
        result,report=finish(source,{'style':'none','width_mm':0})
        self.assertEqual(source.tobytes(),result.tobytes())
        self.assertEqual(report['width_mm'],0)
    def test_uniform_border_preserves_dimensions_and_interior(self):
        source=Image.new('RGB',(1500,2100),'orange')
        result,report=finish(source,{'style':'black','width_mm':1.2})
        self.assertEqual(result.size,source.size)
        self.assertEqual(result.getpixel((0,1050)),(0,0,0))
        self.assertEqual(result.getpixel((750,0)),(0,0,0))
        self.assertEqual(result.getpixel((750,2099)),(0,0,0))
        self.assertEqual(result.crop((106,300,1394,1900)).tobytes(),source.crop((106,300,1394,1900)).tobytes())
        self.assertEqual(source.getpixel((0,0)),(255,165,0))
    def test_modern_taper_preserves_statistics_and_loyalty(self):
        source=Image.new('RGB',(1500,2100),'orange')
        result,report=finish(source,{'style':'modern','width_mm':1.2},card={'power':'2'})
        self.assertTrue(report['taper_applied'])
        self.assertEqual(result.getpixel((750,2050)),(0,0,0))
        self.assertEqual(result.getpixel((1300,1995)),source.getpixel((1300,1995)))
        self.assertEqual(result.getpixel((106,1850)),source.getpixel((106,1850)))
        walker,_=finish(source,{'style':'modern','width_mm':1.2},card={'loyalty':'5'})
        self.assertEqual(walker.getpixel((1310,1995)),source.getpixel((1310,1995)))
    def test_adjusted_statistics_near_edge_remain_readable(self):
        source=Image.new('RGB',(1500,2100),'orange')
        result,_=finish(source,{'style':'black','width_mm':2.2},report={'geometry':{'stats':[1176,1990,1442,2070]}},card={'power':'2'})
        self.assertEqual(result.getpixel((1300,2055)),source.getpixel((1300,2055)))
    def test_scans_keep_their_lower_information_area(self):
        source=Image.new('RGB',(745,1040),'orange')
        result,report=finish(source,{'style':'modern','width_mm':1.2},official=True)
        self.assertFalse(report['taper_applied'])
        self.assertEqual(result.tobytes(),source.tobytes())
    def test_white_frame_antialiasing_uses_straight_rgba_colour(self):
        result,_=finish(Image.new('RGBA',(745,1040)),{'style':'white','width_mm':1.2})
        partially_transparent=[pixel for pixel in result.crop((0,0,40,40)).getdata() if 0 < pixel[3] < 255]
        self.assertTrue(partially_transparent)
        self.assertTrue(all(pixel[:3]==(243,240,230) for pixel in partially_transparent))
    def test_transparent_frame_remains_transparent_interior(self):
        result,_=finish(Image.new('RGBA',(1500,2100)),{'style':'white','width_mm':2})
        self.assertEqual(result.getpixel((750,1000))[3],0)
        self.assertEqual(result.getpixel((0,1000))[3],255)
    def test_statistics_capsules_at_scan_sizes_do_not_crash(self):
        # At 744 x 1040 the protected badge is 169 supersampled pixels high.
        # Half-height radii triggered a reversed-rectangle error in Pillow 9.5.
        for size in [(744,1040),(745,1040),(1500,2100)]:
            for card in [{'power':'2'},{'loyalty':'5'}]:
                with self.subTest(size=size,card=card):
                    image=Image.new('RGB',size,'orange')
                    result,_=finish(image,{'style':'modern','width_mm':1.2},report={'geometry':None},card=card)
                    self.assertEqual(result.size,size)

if __name__=='__main__':unittest.main()
