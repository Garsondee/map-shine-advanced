# GIMP 3 round trip (mmp-0mv.18). Saves the sources with GIMP's default export settings.
#   set MSA_EDTEST=<dir with src/>, then:
#   gimp-console-3.2.exe -i --batch-interpreter=python-fu-eval -b "exec(open(r'<this file>').read())"
# Results land in <dir>/gimp/; read them with read.py. GIMP may not exit by itself: kill it once done.txt appears.
import os
import gi
gi.require_version('Gimp', '3.0')
from gi.repository import Gimp, Gio

D = os.environ['MSA_EDTEST']
os.makedirs(D + '/gimp', exist_ok=True)
JOBS = {
    'a.png': ['a-transparent.png', 'a-transparent.webp'],
    'b.png': ['b-rgb.png'],
    'c.png': ['c-line.png', 'c-line.webp'],
}
for src, outs in JOBS.items():
    img = Gimp.file_load(Gimp.RunMode.NONINTERACTIVE, Gio.File.new_for_path(D + '/src/' + src))
    for name in outs:
        Gimp.file_save(Gimp.RunMode.NONINTERACTIVE, img, Gio.File.new_for_path(D + '/gimp/' + name), None)
    img.delete()
open(D + '/gimp/done.txt', 'w').write('done')
