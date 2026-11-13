"""Exercise lossless print resources, cache invalidation and bounded workers."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zlib
import zipfile

from PIL import Image
from studio.print_deck import prepare_image, HEADER, worker_count, archive_pages, export_pdf


class PrintExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source.png'
        self.plan = dict(quality='full', card_width=63.5, card_height=88.9, bleed=0)

    def pixels(self, resource):
        data = Path(resource['path']).read_bytes()
        return zlib.decompress(data[HEADER.size:])

    def test_native_rgb_pixels_remain_exact_and_cache_invalidates_when_source_changes(self):
        image = Image.new('RGB', (80, 112), 'red')
        image.putpixel((10, 12), (17, 81, 201))
        image.save(self.source)
        task = (str(self.source), self.plan, str(self.root))
        _, resource, hit = prepare_image(task)
        self.assertFalse(hit)
        self.assertTrue(resource['native'])
        self.assertEqual(self.pixels(resource), image.tobytes())
        stat = Path(resource['path']).stat()
        _, again, hit = prepare_image(task)
        self.assertTrue(hit)
        self.assertEqual(again, resource)
        self.assertEqual(Path(again['path']).stat().st_mtime_ns, stat.st_mtime_ns)
        image.putpixel((10, 12), (250, 2, 1))
        image.save(self.source)
        _, changed, hit = prepare_image(task)
        self.assertFalse(hit)
        self.assertNotEqual(changed['path'], resource['path'])
        self.assertEqual(self.pixels(changed), image.tobytes())

    def test_transparency_flattens_to_white_and_edge_bleed_preserves_trim_pixels(self):
        Image.new('RGBA', (80, 112), (0, 0, 0, 0)).save(self.source)
        plan = dict(self.plan, quality='compact', card_width=25.4, card_height=25.4, bleed=2.54)
        _, resource, _ = prepare_image((str(self.source), plan, str(self.root)))
        self.assertEqual((resource['width'], resource['height']), (360, 360))
        self.assertEqual(self.pixels(resource), bytes([255]) * 360 * 360 * 3)
        self.assertFalse(resource['native'])
        # Opaque nonuniform pixels exercise edge extension and all four corners.
        image = Image.new('RGB', (300, 300), 'green')
        image.paste('red', (0, 0, 1, 300))
        image.paste('blue', (299, 0, 300, 300))
        image.save(self.source)
        _, resource, _ = prepare_image((str(self.source), plan, str(self.root)))
        result = Image.frombytes('RGB', (360, 360), self.pixels(resource))
        self.assertEqual(result.crop((30, 30, 330, 330)).tobytes(), image.tobytes())
        self.assertEqual(result.getpixel((0, 0)), (255, 0, 0))
        self.assertEqual(result.getpixel((359, 359)), (0, 0, 255))

    def test_worker_count_respects_available_memory_and_explicit_serial_mode(self):
        with patch('studio.print_deck.memory_available', return_value=1024**3), patch('os.cpu_count', return_value=8):
            with patch.dict(os.environ, {'CARDFORGE_PRINT_WORKERS': '4'}):
                self.assertEqual(worker_count(10, 64*1024**2), 4)
                self.assertEqual(worker_count(10, 256*1024**2), 1)
                self.assertEqual(worker_count(1, 1024), 1)
            with patch.dict(os.environ, {'CARDFORGE_PRINT_WORKERS': '1'}):
                self.assertEqual(worker_count(10, 1024), 1)

    def test_separate_faces_fill_normal_cells_in_copy_order_and_obey_page_ranges(self):
        front, back, single = [self.root / name for name in ('front.png', 'back.png', 'single.png')]
        for file, color in ((front, 'red'), (back, 'blue'), (single, 'green')):
            Image.new('RGB', (80, 112), color).save(file)
        plan = dict(self.plan, face_mode='separate', per_page=3, columns=3, rows=1,
                    width=210, height=297, offset_x=5, offset_y=5, gap=2,
                    crop_marks=False, calibration=False)
        request = dict(plan=plan, deck_name='Separate faces', entries=[
            dict(image_path=str(front), back_path=str(back), quantity=2),
            dict(image_path=str(single), back_path=None, quantity=1)])
        # Observe actual PDF placement after image preparation, rather than
        # repeating the list-expansion implementation in this test.
        with patch('studio.print_deck.draw_resource') as draw:
            result = export_pdf(request, self.root / 'separate.pdf')
        self.assertEqual(result['images'], 3)
        resources = [call.args[1]['path'] for call in draw.call_args_list]
        self.assertEqual(len(resources), 5)
        self.assertEqual(resources[0], resources[2])
        self.assertEqual(resources[1], resources[3])
        self.assertEqual(len(set(resources)), 3)
        positions = [call.args[2] for call in draw.call_args_list]
        self.assertLess(positions[0], positions[1])
        self.assertEqual(positions[0], positions[3])
        plan['selected_pages'] = [2]
        with patch('studio.print_deck.draw_resource') as draw:
            export_pdf(request, self.root / 'selected.pdf')
        self.assertEqual([call.args[1]['path'] for call in draw.call_args_list], resources[3:])

    def test_pdf_member_offsets_support_zip64_headers_without_extracting_the_archive(self):
        filename = self.root / 'pages.zip'
        contents = {'page-002-back.pdf': b'%PDF-1.3\nfirst page',
                    'page-005-calibration.pdf': b'%PDF-1.3\nsecond page'}
        with zipfile.ZipFile(filename, 'w', compression=zipfile.ZIP_STORED) as archive:
            for name, data in contents.items():
                with archive.open(name, 'w', force_zip64=True) as out:
                    out.write(data)
        pages = archive_pages(filename)
        self.assertEqual([p['number'] for p in pages], [2, 5])
        with filename.open('rb') as stream:
            for page in pages:
                stream.seek(page['offset'])
                self.assertEqual(stream.read(page['size']), contents[page['name']])
        with zipfile.ZipFile(filename, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('page-001.pdf', b'%PDF-1.3\ncompressed')
        with self.assertRaisesRegex(ValueError, 'Unsupported'):
            archive_pages(filename)


if __name__ == '__main__':
    unittest.main()
