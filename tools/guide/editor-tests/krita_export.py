# Krita 5 round trip (mmp-0mv.18). `krita --export` hangs on Windows; kritarunner works:
#   from THIS folder, set MSA_EDTEST=<dir with src/> and PYTHONPATH=<this folder>, then:
#   kritarunner.com -s krita_export -f main
# Results land in <dir>/krita/; read them with read.py.
import os
from krita import Krita, InfoObject

JOBS = {
    'a.png': ['a-transparent.png', 'a-transparent.webp'],
    'b.png': ['b-rgb.png'],
    'c.png': ['c-line.png', 'c-line.webp'],
}


def main(*_):
    d = os.environ['MSA_EDTEST']
    os.makedirs(d + '/krita', exist_ok=True)
    k = Krita.instance()
    for src, outs in JOBS.items():
        doc = k.openDocument(d + '/src/' + src)
        doc.setBatchmode(True)
        for name in outs:
            doc.exportImage(d + '/krita/' + name, InfoObject())
        doc.close()
    open(d + '/krita/done.txt', 'w').write('done')
