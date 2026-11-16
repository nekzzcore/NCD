"""Generate platform icons directly from the shared compass vector (never a bitmap)."""
from pathlib import Path
import copy
import math
import re
import xml.etree.ElementTree as ET
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
RES = ROOT / 'android/app/src/main/res'
SVG = 'http://www.w3.org/2000/svg'
ET.register_namespace('', SVG)
source = ET.parse(ROOT / 'assets/ncd-compass.svg').getroot()
mark = source.find(f'{{{SVG}}}g')
triangles = []


def collect(node, angle=0):
    transform = node.get('transform', '')
    if transform:
        rotation = re.fullmatch(r'rotate\((\d+) 50 50\)', transform)
        if not rotation:
            raise ValueError(f'Unsupported transform: {transform}')
        angle += float(rotation[1])
    if node.tag == f'{{{SVG}}}path':
        path = node.get('d', '')
        if re.search(r'[A-Za-z]', re.sub(r'[MLZmlz]', '', path)):
            raise ValueError('Icon renderer supports polygon paths only')
        coords = list(map(float, re.findall(r'-?\d+(?:\.\d+)?', path)))
        if len(coords) != 6:
            raise ValueError('Expected a compass triangle')
        radians = math.radians(angle)
        points = []
        for x, y in zip(coords[::2], coords[1::2]):
            x, y = x-50, y-50
            points.append((50+x*math.cos(radians)-y*math.sin(radians),
                           50+x*math.sin(radians)+y*math.cos(radians)))
        triangles.append((points, node.get('fill') != 'none'))
    for child in node:
        collect(child, angle)


collect(mark)


def render(size, factor=.88, transparent=False):
    # Render geometry at each target resolution; supersampling only smooths edges.
    oversample = 4
    edge = size * oversample
    image = Image.new('RGBA', (edge, edge), (0, 0, 0, 0) if transparent else 'black')
    draw = ImageDraw.Draw(image)
    scale = edge * factor / 100
    stroke = 1.5 if size <= 32 else 1.0
    for points, filled in triangles:
        polygon = [(edge/2+(x-50)*scale, edge/2+(y-50)*scale) for x, y in points]
        if filled:
            draw.polygon(polygon, fill='white')
        draw.line(polygon + [polygon[0]], fill='white', width=max(1, round(stroke*scale)))
    return image.resize((size, size), Image.Resampling.LANCZOS)


# Genuine vector favicon/app icon, sharing the same paths as the UI compass.
icon = ET.Element(f'{{{SVG}}}svg', {'viewBox': '0 0 512 512', 'width': '512', 'height': '512'})
ET.SubElement(icon, f'{{{SVG}}}title').text = 'Звезда-компас'
ET.SubElement(icon, f'{{{SVG}}}rect', {'width': '512', 'height': '512', 'fill': '#000000'})
container = ET.SubElement(icon, f'{{{SVG}}}g', {'transform': 'translate(30.72 30.72) scale(4.5056)', 'color': '#ffffff'})
vector = copy.deepcopy(mark)
vector.attrib.pop('id', None)
vector.set('stroke-width', '1')
container.append(vector)
for path in [ROOT / 'icon.svg', ROOT / 'assets/ncd-app-icon.svg']:
    ET.ElementTree(icon).write(path, encoding='unicode', xml_declaration=False)
for size in [48, 192, 512]:
    render(size).save(ROOT / f'icon-{size}.png', optimize=True)
for size in [192, 512]:
    render(size, .80).save(ROOT / f'icon-{size}-maskable.png', optimize=True)
master = render(1024)
master.save(ROOT / 'icon.png', optimize=True)
master.save(ROOT / 'assets/logo.png', optimize=True)
sizes = [16, 24, 32, 48, 64, 128, 256]
master.save(ROOT / 'icon.ico', format='ICO', sizes=[(s, s) for s in sizes], append_images=[render(s) for s in sizes])
(ROOT / 'favicon.ico').write_bytes((ROOT / 'icon.ico').read_bytes())
master.save(ROOT / 'icon.icns', format='ICNS')

for density, size, foreground_size in [('mdpi',48,108),('hdpi',72,162),('xhdpi',96,216),('xxhdpi',144,324),('xxxhdpi',192,432)]:
    folder = RES / f'mipmap-{density}'
    render(size).save(folder / 'ic_launcher.png', optimize=True)
    regular = render(size)
    mask = Image.new('L', (size*4, size*4), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size*4-1, size*4-1), fill=255)
    regular.putalpha(mask.resize((size,size), Image.Resampling.LANCZOS))
    regular.save(folder / 'ic_launcher_round.png', optimize=True)
    for name in ['foreground', 'monochrome']:
        render(foreground_size, .62, transparent=True).save(folder / f'ic_launcher_{name}.png', optimize=True)

# Android adaptive layers stay vector on high-DPI screens, including themed icons.
android = 'http://schemas.android.com/apk/res/android'
ET.register_namespace('android', android)
vector = ET.Element('vector', {f'{{{android}}}{key}': value for key, value in {
    'width':'108dp', 'height':'108dp', 'viewportWidth':'108', 'viewportHeight':'108'}.items()})
for points, filled in triangles:
    points = [(54+(x-50)*.6696, 54+(y-50)*.6696) for x, y in points]
    data = 'M' + ' L'.join(f'{x:.4f},{y:.4f}' for x, y in points) + ' Z'
    ET.SubElement(vector, 'path', {f'{{{android}}}{key}': value for key, value in {
        'pathData':data, 'fillColor':'#FFFFFFFF' if filled else '#00000000',
        'strokeColor':'#FFFFFFFF', 'strokeWidth':'0.6696', 'strokeLineJoin':'miter'}.items()})
for target in ['drawable/ic_launcher_foreground.xml', 'drawable-v24/ic_launcher_foreground.xml', 'drawable/ic_launcher_monochrome.xml']:
    ET.ElementTree(vector).write(RES / target, encoding='utf-8', xml_declaration=True)
for path in RES.glob('mipmap-anydpi-v*/ic_launcher*.xml'):
    text = path.read_text().replace('@mipmap/ic_launcher_foreground', '@drawable/ic_launcher_foreground').replace('@mipmap/ic_launcher_monochrome', '@drawable/ic_launcher_monochrome')
    path.write_text(text)

for splash in RES.glob('drawable*/splash.png'):
    with Image.open(splash) as old:
        width, height = old.size
    canvas = Image.new('RGB', (width, height), 'black')
    tile = render(round(min(width, height)*.4)).convert('RGB')
    canvas.paste(tile, ((width-tile.width)//2, (height-tile.height)//2))
    canvas.save(splash, optimize=True)
print('Generated vector compass icons: SVG, PNG up to 1024px, ICO, ICNS, Android adaptive/monochrome and splash.')
