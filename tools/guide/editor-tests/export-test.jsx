// Photoshop export round-trip test for the Map Shine Guide (mmp-0mv.18).
// Makes small test images the way an artist would and saves them every common way.
#target photoshop
// Results go to <temp>/msa-editor-test/; read them with: python tools/guide/editor-tests/read.py <that folder>
var OUT = Folder.temp.fsName.split("\\").join("/") + "/msa-editor-test/";
new Folder(OUT).create();
new Folder(OUT).create();
app.displayDialogs = DialogModes.NO;
var oldUnits = app.preferences.rulerUnits;
app.preferences.rulerUnits = Units.PIXELS;
var log = [];

function solid(r, g, b) {
  var c = new SolidColor();
  c.rgb.red = r; c.rgb.green = g; c.rgb.blue = b;
  return c;
}
function selectRect(doc, x0, y0, x1, y1) {
  doc.selection.select([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
}
function savePng(doc, name) {
  var o = new PNGSaveOptions();
  o.compression = 6;
  doc.saveAs(new File(OUT + name), o, true, Extension.LOWERCASE);
}
function saveWebp(doc, name, lossless, quality) {
  try {
    var o = new WebPSaveOptions();
    o.compressionType = lossless ? WebPCompression.COMPRESSIONLOSSLESS : WebPCompression.COMPRESSIONLOSSY;
    if (!lossless) o.quality = quality;
    o.includeXMPData = false; o.includeEXIFData = false; o.includePsExtras = false;
    doc.saveAs(new File(OUT + name), o, true, Extension.LOWERCASE);
  } catch (e) { log.push("webp " + name + " failed: " + e); }
}
function exportSfwPng(doc, name) {
  try {
    var o = new ExportOptionsSaveForWeb();
    o.format = SaveDocumentType.PNG; o.PNG8 = false; o.transparency = true;
    doc.exportDocument(new File(OUT + name), ExportType.SAVEFORWEB, o);
  } catch (e) { log.push("sfw " + name + " failed: " + e); }
}

// TEST A — colour hidden under transparency (the _Specular trap).
// A red-filled layer; the left half deleted to full transparency.
var a = app.documents.add(64, 64, 72, "msa-a", NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
app.foregroundColor = solid(255, 0, 0);
a.selection.selectAll(); a.selection.fill(app.foregroundColor); a.selection.deselect();
selectRect(a, 0, 0, 32, 64); a.selection.clear(); a.selection.deselect();
savePng(a, "a-transparent.png");
saveWebp(a, "a-transparent-lossless.webp", true, 100);
exportSfwPng(a, "a-transparent-sfw.png");
a.close(SaveOptions.DONOTSAVECHANGES);

// TEST B — a 50% grey painted in RGB, then the document converted to Grayscale mode
// (does the grey value survive the colour-space change?).
var b = app.documents.add(64, 64, 72, "msa-b", NewDocumentMode.RGB, DocumentFill.WHITE);
app.foregroundColor = solid(128, 128, 128);
selectRect(b, 0, 0, 32, 64); b.selection.fill(app.foregroundColor); b.selection.deselect();
savePng(b, "b-rgb.png");
b.changeMode(ChangeMode.GRAYSCALE);
savePng(b, "b-gray.png");
saveWebp(b, "b-gray.webp", true, 100);
b.close(SaveOptions.DONOTSAVECHANGES);

// TEST C — a thin 1-pixel white line on black (a _Fire line / narrow _Water channel),
// saved lossy at two qualities and lossless.
var c = app.documents.add(64, 64, 72, "msa-c", NewDocumentMode.RGB, DocumentFill.WHITE);
app.foregroundColor = solid(0, 0, 0);
c.selection.selectAll(); c.selection.fill(app.foregroundColor); c.selection.deselect();
app.foregroundColor = solid(255, 255, 255);
selectRect(c, 8, 32, 56, 33); c.selection.fill(app.foregroundColor); c.selection.deselect();
saveWebp(c, "c-line-lossless.webp", true, 100);
saveWebp(c, "c-line-q75.webp", false, 75);
saveWebp(c, "c-line-q30.webp", false, 30);
savePng(c, "c-line.png");
c.close(SaveOptions.DONOTSAVECHANGES);

app.preferences.rulerUnits = oldUnits;
var f = new File(OUT + "log.txt"); f.open("w"); f.write("done\n" + log.join("\n")); f.close();
